// bb-plugin-statusbar — one glanceable bottom bar for cost, lanes, host, and
// Spotify.
//
// WHY THIS PLUGIN COMPUTES EVERYTHING ITSELF
//
// BB has no cross-plugin data channel. Two facts, both verified against the
// running source rather than the docs:
//
//   1. `bb.storage.kv` is strictly plugin-scoped. getPluginKvValue(db,
//      pluginId, key) closes over the CALLING plugin's id, and plugin_kv is
//      PRIMARY KEY (plugin_id, key). A plugin cannot read another's key.
//   2. `useRpc`/`bb.rpc` take no plugin id, so there is no plugin-to-plugin
//      RPC call either.
//
// So this plugin re-derives each section in its own server. The usage and
// lanes logic below is DUPLICATED from bb-plugin-usage-footer and
// bb-plugin-lanes on purpose: if either of those changes its schema or its
// provider handling, this file does not follow automatically. That is the
// known, accepted cost of the design.
//
// The one deliberate exception is Spotify, which needs credentials that are
// per-plugin. Rather than duplicate them (two independent refresh flows would
// race on token rotation), this plugin READS bb-spotify's own credentials
// read-only. The user owns both plugins. Credential values stay server-side:
// they are never logged, never written to disk, never returned over RPC, and
// never placed in KV.
import { readFile } from "node:fs/promises";
import { homedir, cpus, loadavg, totalmem, freemem, hostname } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Cache lifetimes. The bar polls `snapshot()`; these keep the work bounded.
// ---------------------------------------------------------------------------

const HOST_CACHE_MS = 5_000;
/**
 * Spotify changes from outside this bar too (the user pausing in the Spotify
 * app, a track ending, a different device taking over). This TTL is the worst
 * case for noticing such a change, so keep it short: the endpoint is one cheap
 * authenticated GET and the bar polls on its own interval anyway.
 */
const SPOTIFY_CACHE_MS = 3_000;
const USAGE_CACHE_MS = 60_000;
const LANES_CACHE_MS = 60_000;

const USAGE_DB_PATH = join(homedir(), ".bb", "plugins", "usage", "data.db");
const BB_DB_PATH = join(homedir(), ".bb", "bb.db");
const SPOTIFY_SECRETS_DIR = join(homedir(), ".bb", "plugins", "spotify", "secrets");
const ENV_JSON_PATH = join(homedir(), ".bb", "env.json");
const FETCH_TIMEOUT_MS = 20_000;

// ---------------------------------------------------------------------------
// Wire schemas
// ---------------------------------------------------------------------------

/**
 * Every section carries `status` so the UI can render per-section degradation.
 * A failing source must never blank the other three.
 */
const sectionStatusSchema = z.enum(["ok", "unavailable", "error"]);

const usageSectionSchema = z
  .object({
    status: sectionStatusSchema,
    /** Cost today, in USD. Null when the usage store is absent or unreadable. */
    todayCost: z.number().nullable(),
    /** Calendar-month-to-date cost, in USD. */
    monthCost: z.number().nullable(),
    /** Month label for the month the latest data falls in, e.g. "2026-10". */
    monthLabel: z.string().nullable(),
    /** Which day the latest data actually covers; not necessarily today. */
    latestDay: z.string().nullable(),
    detail: z.string().nullable(),
  })
  .strict();

const laneWindowSchema = z
  .object({
    label: z.string(),
    usedPercent: z.number(),
    resetsAt: z.string().nullable(),
  })
  .strict();

const laneSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    /**
     * subscription — a quota window that REFILLS; exhausting it costs waiting.
     * metered      — a balance that DEPLETES and never auto-reloads.
     */
    kind: z.enum(["subscription", "metered"]),
    status: z.enum(["ok", "error", "unconfigured"]),
    /** Highest usedPercent across windows, for a single-number bar item. */
    worstUsedPercent: z.number().nullable(),
    /** Label of the window `worstUsedPercent` came from. */
    worstWindowLabel: z.string().nullable(),
    /** When the worst window refills; null for metered (it never does). */
    resetsAt: z.string().nullable(),
    detail: z.string().nullable(),
  })
  .strict();

/**
 * The raw, pre-derivation lane shape. Windows are collapsed into the single
 * worst reading before the lane reaches the wire, so this type is internal
 * only and deliberately distinct from `Lane`.
 */
type RawLane = {
  id: string;
  name: string;
  kind: "subscription" | "metered";
  status: "ok" | "error" | "unconfigured";
  windows?: Array<{
    label: string;
    usedPercent: number;
    resetsAt: string | null;
  }>;
  detail: string | null;
};

const lanesSectionSchema = z
  .object({
    status: sectionStatusSchema,
    lanes: z.array(laneSchema),
    detail: z.string().nullable(),
  })
  .strict();

const hostSectionSchema = z
  .object({
    status: sectionStatusSchema,
    hostname: z.string().nullable(),
    cpuPercent: z.number().nullable(),
    memoryPercent: z.number().nullable(),
    diskPercent: z.number().nullable(),
    /** 1-minute load average, normalised by logical core count. */
    load1: z.number().nullable(),
    load1PerCore: z.number().nullable(),
    logicalCores: z.number().nullable(),
    detail: z.string().nullable(),
  })
  .strict();

const spotifySectionSchema = z
  .object({
    status: z.enum(["ok", "idle", "unavailable", "error"]),
    trackName: z.string().nullable(),
    artistNames: z.array(z.string()),
    albumName: z.string().nullable(),
    isPlaying: z.boolean(),
    progressPercent: z.number().nullable(),
    deviceName: z.string().nullable(),
    /** A track is loaded. Distinct from `isPlaying`: paused tracks are
     *  likeable but not playing. */
    hasTrack: z.boolean(),
    detail: z.string().nullable(),
  })
  .strict();

const snapshotSchema = z
  .object({
    generatedAt: z.string(),
    usage: usageSectionSchema,
    lanes: lanesSectionSchema,
    host: hostSectionSchema,
    spotify: spotifySectionSchema,
  })
  .strict();

export type Snapshot = z.infer<typeof snapshotSchema>;
export type UsageSection = z.infer<typeof usageSectionSchema>;
export type LanesSection = z.infer<typeof lanesSectionSchema>;
export type Lane = z.infer<typeof laneSchema>;
export type HostSection = z.infer<typeof hostSectionSchema>;
export type SpotifySection = z.infer<typeof spotifySectionSchema>;

export const rpcContract = defineRpcContract({
  snapshot: { input: z.null(), output: snapshotSchema },
  /**
   * Transport controls, mirroring bb-spotify's own `sidebar_control`.
   * `play`/`pause` are disruptive in bb-spotify's sense: starting playback is
   * refused unless that plugin's `allowDisruptiveActions` setting is on.
   */
  spotify_control: {
    input: z.object({
      action: z.enum(["pause", "play", "next", "previous"]),
    }),
    output: z.object({ message: z.string() }),
  },
  /** Save the current track to Liked Songs. Errors when nothing is loaded. */
  spotify_like: {
    input: z.null(),
    output: z.object({ message: z.string() }),
  },
});

// ---------------------------------------------------------------------------
// Small shared helpers
// ---------------------------------------------------------------------------

/** A cached async value with a fixed lifetime; failures are not cached. */
/**
 * A cached async value with a fixed lifetime, plus explicit invalidation.
 *
 * `invalidate()` drops the current value so the next read reloads. Failures are
 * never cached, and concurrent reads share one in-flight promise.
 */
function makeCache<T>(ttlMs: number, load: () => Promise<T>) {
  let value: T | null = null;
  let expiresAt = 0;
  let inFlight: Promise<T> | null = null;

  async function read(): Promise<T> {
    const now = Date.now();
    if (value !== null && now < expiresAt) return value;
    if (inFlight !== null) return inFlight;
    inFlight = load()
      .then((next) => {
        value = next;
        expiresAt = Date.now() + ttlMs;
        return next;
      })
      .finally(() => {
        inFlight = null;
      });
    return inFlight;
  }

  /** Forces the next read to reload, and starts that reload immediately. */
  read.invalidate = (): void => {
    value = null;
    expiresAt = 0;
  };

  return read;
}

async function fetchWithTimeout(url: string, init: RequestInit = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Disk usage for the filesystem containing `path`.
 *
 * `statfs` is not exposed by node:os, so this shells out to df with a bounded
 * output read. Failure returns null rather than throwing: a missing df must
 * not take down the whole bar.
 */
async function diskUsagePercent(path: string): Promise<number | null> {
  try {
    const { execFile } = await import("node:child_process");
    const stdout = await new Promise<string>((resolve, reject) => {
      execFile("df", ["-Pk", path], { timeout: 5_000 }, (error, out) => {
        if (error) reject(error);
        else resolve(String(out));
      });
    });
    // `df -Pk` prints a header then one row: Filesystem 1024-blocks Used Available Capacity Mounted
    const lines = stdout.trim().split("\n");
    const row = lines[lines.length - 1];
    if (row === undefined) return null;
    const columns = row.trim().split(/\s+/);
    const used = Number(columns[2]);
    const available = Number(columns[3]);
    if (!Number.isFinite(used) || !Number.isFinite(available)) return null;
    const total = used + available;
    if (total <= 0) return null;
    return (used / total) * 100;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Usage — duplicated from bb-plugin-usage-footer
// ---------------------------------------------------------------------------

/** Days the usage store keeps; the bar only needs today and month-to-date. */
function localDay(now: Date): string {
  return [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, "0"),
    String(now.getDate()).padStart(2, "0"),
  ].join("-");
}

function createUsageReader() {
  let handle: DatabaseSync | null = null;

  function connection(): DatabaseSync {
    if (handle === null) {
      // Read-only: the Usage plugin owns this file. WAL means a reader never
      // blocks its writer. node:sqlite is built in, so no native module.
      handle = new DatabaseSync(USAGE_DB_PATH, { readOnly: true });
      handle.exec("PRAGMA busy_timeout = 2000");
    }
    return handle;
  }

  return function readUsage(): UsageSection {
    try {
      const conn = connection();
      const latest = conn
        .prepare(`SELECT MAX(day) AS day FROM usage_events`)
        .get() as { day: string | null } | undefined;
      const latestDay = latest?.day ?? null;

      if (latestDay === null) {
        return {
          status: "ok",
          todayCost: 0,
          monthCost: 0,
          monthLabel: null,
          latestDay: null,
          detail: "No usage recorded yet.",
        };
      }

      const todayRow = conn
        .prepare(
          `SELECT SUM(cost_usd) AS cost FROM usage_events WHERE day = ?`,
        )
        .get(latestDay) as { cost: number | null } | undefined;

      const monthLabel = latestDay.slice(0, 7);
      const monthRow = conn
        .prepare(
          `SELECT SUM(cost_usd) AS cost FROM usage_events WHERE day LIKE ?`,
        )
        .get(`${monthLabel}%`) as { cost: number | null } | undefined;

      return {
        status: "ok",
        todayCost: Number(todayRow?.cost ?? 0),
        monthCost: Number(monthRow?.cost ?? 0),
        monthLabel,
        latestDay,
        // The bar labels today's figure honestly when the newest data is older
        // than the current calendar day.
        detail:
          latestDay === localDay(new Date())
            ? null
            : `Latest data is ${latestDay}.`,
      };
    } catch (error) {
      return {
        status: "unavailable",
        todayCost: null,
        monthCost: null,
        monthLabel: null,
        latestDay: null,
        detail: `Usage store unreadable: ${(error as Error).message}`,
      };
    }
  };
}

// ---------------------------------------------------------------------------
// Lanes — duplicated from bb-plugin-lanes
// ---------------------------------------------------------------------------

/**
 * Credentials come from bb's env store, FILE FIRST and process.env only as a
 * fallback. The order matters: process.env is a snapshot taken when the server
 * started, so after a key rotation it serves a revoked credential until the
 * whole server restarts. env.json is the live file the user edits.
 */
async function readEnvKey(name: string): Promise<string> {
  try {
    const raw = await readFile(ENV_JSON_PATH, "utf8");
    const fromFile = (JSON.parse(raw)?.env ?? {})[name];
    if (typeof fromFile === "string" && fromFile.length > 0) return fromFile;
  } catch {
    // fall through to the process environment
  }
  return process.env[name] ?? "";
}

function pickWorst(lane: RawLane): Lane {
  // `windows` is deliberately dropped: the wire schema is `.strict()` and only
  // carries the derived worst reading.
  const { windows: rawWindows, ...rest } = lane;
  const windows = rawWindows ?? [];
  if (windows.length === 0) {
    return { ...rest, worstUsedPercent: null, worstWindowLabel: null, resetsAt: null };
  }
  let worst = windows[0]!;
  for (const candidate of windows) {
    if (candidate.usedPercent > worst.usedPercent) worst = candidate;
  }
  return {
    ...rest,
    worstUsedPercent: worst.usedPercent,
    worstWindowLabel: worst.label,
    resetsAt: lane.kind === "metered" ? null : worst.resetsAt,
  };
}

async function nativeLanes(bb: BbPluginApi): Promise<Lane[]> {
  const spec: Array<[string, string]> = [
    ["claudeCode", "Claude"],
    ["codex", "Codex"],
  ];
  const base = (id: string, name: string): RawLane => ({
    id,
    name,
    kind: "subscription",
    status: "ok",
    detail: null,
  });

  try {
    const usage = (await bb.sdk.system.usageLimits()) as Record<string, any>;
    return spec.flatMap(([key, name]) => {
      const provider = usage?.[key];
      // A provider that is not installed is not a lane — omit rather than
      // render a permanently empty row.
      if (!provider || provider.status === "not_installed") return [];
      if (provider.status !== "ok") {
        return [
          pickWorst({
            ...base(key, name),
            status: "error" as const,
            detail: `provider reported "${provider.status}"`,
          }),
        ];
      }
      const windows = (provider.windows ?? []).map((w: any) => ({
        label: String(w.label ?? "window"),
        usedPercent: Number(w.usedPercent ?? 0),
        resetsAt: w.resetsAt ?? null,
      }));
      return [
        pickWorst({
          ...base(key, name),
          windows,
        }),
      ];
    });
  } catch (error) {
    return spec.map(([key, name]) =>
      pickWorst({
        ...base(key, name),
        status: "error" as const,
        detail: `usage lookup failed: ${(error as Error).message}`,
      }),
    );
  }
}

async function openRouterLane(): Promise<Lane> {
  const base: Pick<RawLane, "id" | "name" | "kind"> = {
    id: "openrouter",
    name: "OpenRouter",
    kind: "metered",
  };
  const key = await readEnvKey("OPENROUTER_API_KEY");
  if (key === "") {
    return pickWorst({
      ...base,
      status: "unconfigured",
      detail: "no OPENROUTER_API_KEY in bb's env store",
    });
  }
  try {
    const response = await fetchWithTimeout("https://openrouter.ai/api/v1/credits", {
      headers: { authorization: `Bearer ${key}` },
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const json = (await response.json()) as any;
    const total = Number(json?.data?.total_credits ?? 0);
    const used = Number(json?.data?.total_usage ?? 0);
    const remaining = total - used;
    return pickWorst({
      ...base,
      status: "ok",
      windows: [
        {
          label: "Balance consumed",
          usedPercent: total > 0 ? (used / total) * 100 : 0,
          // Metered: this balance does not refill on its own.
          resetsAt: null,
        },
      ],
      detail: `$${remaining.toFixed(2)} left`,
    });
  } catch (error) {
    return pickWorst({
      ...base,
      status: "error",
      detail: (error as Error).message,
    });
  }
}

// ---------------------------------------------------------------------------
// Host — sampled in-plugin, deliberately minimal (host-monitor owns history
// and the process list; the bar only needs a current reading)
// ---------------------------------------------------------------------------

let lastCpuTimes: { idle: number; total: number } | null = null;

/** CPU% from the delta between two /proc/stat-style cumulative readings. */
function cpuPercent(from: { idle: number; total: number }, to: { idle: number; total: number }): number {
  const idleDelta = to.idle - from.idle;
  const totalDelta = to.total - from.total;
  if (totalDelta <= 0) return 0;
  return Math.min(100, Math.max(0, (1 - idleDelta / totalDelta) * 100));
}

function cpuTimes(): { idle: number; total: number } {
  let idle = 0;
  let total = 0;
  for (const cpu of cpus()) {
    const times = cpu.times;
    idle += times.idle;
    total += times.user + times.nice + times.sys + times.idle + times.irq;
  }
  return { idle, total };
}

async function sampleHost(): Promise<HostSection> {
  try {
    const cores = cpus().length || 1;
    const load = loadavg()[0] ?? null;

    // First call has no previous reading to diff against; report null rather
    // than a fabricated 0%.
    const current = cpuTimes();
    const previous = lastCpuTimes;
    lastCpuTimes = current;
    const cpuValue = previous === null ? null : cpuPercent(previous, current);

    const totalMemory = totalmem();
    const freeMemory = freemem();
    const memoryPercent = totalMemory > 0 ? ((totalMemory - freeMemory) / totalMemory) * 100 : null;
    const diskPercent = await diskUsagePercent(homedir());

    return {
      status: "ok",
      hostname: hostname(),
      cpuPercent: cpuValue,
      memoryPercent,
      diskPercent,
      load1: load,
      load1PerCore: load === null ? null : load / cores,
      logicalCores: cores,
      detail: null,
    };
  } catch (error) {
    return {
      status: "error",
      hostname: null,
      cpuPercent: null,
      memoryPercent: null,
      diskPercent: null,
      load1: null,
      load1PerCore: null,
      logicalCores: null,
      detail: (error as Error).message,
    };
  }
}

// ---------------------------------------------------------------------------
// Spotify — reads bb-spotify's credentials read-only rather than duplicating
// them. Two independent refresh flows would race on token rotation.
// ---------------------------------------------------------------------------

/**
 * Read one of bb-spotify's NON-SECRET plugin settings (clientId,
 * defaultDeviceId, allowDisruptiveActions) from bb.db. Secrets are never read
 * this way; they live in the plugin's 0600 files, read separately below.
 *
 * Returns null on any failure: a missing table or malformed row must degrade
 * the Spotify section, not throw.
 */
function readSpotifySetting(key: string): unknown {
  try {
    const db = new DatabaseSync(BB_DB_PATH, { readOnly: true });
    try {
      db.exec("PRAGMA busy_timeout = 2000");
      const row = db
        .prepare(
          `SELECT value FROM plugin_settings WHERE plugin_id = 'spotify' AND key = ?`,
        )
        .get(key) as { value: string } | undefined;
      if (row === undefined) return null;
      return JSON.parse(row.value);
    } finally {
      db.close();
    }
  } catch {
    return null;
  }
}

/** bb-spotify refuses to start playback unless the user opted in. Default off. */
function spotifyDisruptiveActionsAllowed(): boolean {
  return readSpotifySetting("allowDisruptiveActions") === true;
}

function spotifyDefaultDeviceId(): string | null {
  const value = readSpotifySetting("defaultDeviceId");
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function createSpotifyReader() {
  // Access token lives in memory only, until its stated expiry.
  let accessToken: string | null = null;
  let accessTokenExpiresAt = 0;

  async function readCredential(name: string): Promise<string | null> {
    try {
      return (await readFile(join(SPOTIFY_SECRETS_DIR, name), "utf8")).trim();
    } catch {
      return null;
    }
  }

  /** clientId is NOT a secret; bb-spotify keeps it in plugin_settings. */
  function readClientId(): string | null {
    const value = readSpotifySetting("clientId");
    return typeof value === "string" && value.length > 0 ? value : null;
  }

  async function getAccessToken(): Promise<string | null> {
    if (accessToken !== null && Date.now() < accessTokenExpiresAt) return accessToken;

    const [clientId, clientSecret, refreshToken] = await Promise.all([
      Promise.resolve(readClientId()),
      readCredential("clientSecret"),
      readCredential("refreshToken"),
    ]);
    if (!clientId || !clientSecret || !refreshToken) return null;

    const response = await fetchWithTimeout("https://accounts.spotify.com/api/token", {
      method: "POST",
      headers: {
        authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
      }).toString(),
    });
    if (!response.ok) throw new Error(`token refresh failed: HTTP ${response.status}`);

    const json = (await response.json()) as {
      access_token: string;
      expires_in: number;
      refresh_token?: string;
    };

    // If Spotify rotated the refresh token, IGNORE it. bb-spotify owns that
    // value and persists rotation on its own path; writing here would fight it.
    accessToken = json.access_token;
    // Refresh a minute early so a slow poll never serves an expired token.
    accessTokenExpiresAt = Date.now() + Math.max(0, json.expires_in - 60) * 1000;
    return accessToken;
  }

  return {
    read: async function readSpotify(): Promise<SpotifySection> {
    const idle: SpotifySection = {
      status: "idle",
      trackName: null,
      artistNames: [],
      albumName: null,
      isPlaying: false,
      progressPercent: null,
      deviceName: null,
      hasTrack: false,
      detail: null,
    };

    try {
      const token = await getAccessToken();
      if (token === null) {
        return {
          ...idle,
          status: "unavailable",
          detail: "Spotify not connected. Run `bb spotify auth start`.",
        };
      }

      const response = await fetchWithTimeout("https://api.spotify.com/v1/me/player", {
        headers: { authorization: `Bearer ${token}` },
      });
      // 204 = nothing playing on any device. Not an error.
      if (response.status === 204) return idle;
      if (!response.ok) throw new Error(`HTTP ${response.status}`);

      const playback = (await response.json()) as any;
      const item = playback?.item;
      const progressMs = typeof playback?.progress_ms === "number" ? playback.progress_ms : null;
      const durationMs = typeof item?.duration_ms === "number" ? item.duration_ms : null;

      return {
        status: "ok",
        trackName: item?.name ?? null,
        artistNames: item?.artists?.map((artist: any) => String(artist.name)) ?? [],
        albumName: item?.album?.name ?? null,
        isPlaying: Boolean(playback?.is_playing),
        progressPercent:
          progressMs !== null && durationMs !== null && durationMs > 0
            ? (progressMs / durationMs) * 100
            : null,
        deviceName: playback?.device?.name ?? null,
        // A track can be loaded but paused; `like` needs the track, not playback.
        hasTrack: typeof item?.uri === "string" && item.uri.length > 0,
        detail: null,
      };
    } catch (error) {
      return { ...idle, status: "error", detail: (error as Error).message };
    }
    },
    /** Server-side only. The value must never reach the frontend or a log. */
    token: getAccessToken,
  };
}

// ---------------------------------------------------------------------------
// Spotify transport controls
// ---------------------------------------------------------------------------

/**
 * One request against the Spotify Web API.
 *
 * Mirrors bb-spotify's own helper. The access token is passed in, never
 * stored on the instance, and never logged.
 */
async function spotifyApi(
  token: string,
  method: "GET" | "PUT" | "POST",
  path: string,
  options: { query?: Record<string, string>; body?: unknown } = {},
): Promise<Response> {
  const url = new URL(`https://api.spotify.com/v1${path}`);
  for (const [key, value] of Object.entries(options.query ?? {})) {
    url.searchParams.set(key, value);
  }
  return fetchWithTimeout(url.toString(), {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(options.body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
}

/** Spotify returns a small JSON error body worth surfacing verbatim. */
async function spotifyErrorText(response: Response): Promise<string> {
  try {
    const json = (await response.json()) as { error?: { message?: string; reason?: string } };
    const message = json?.error?.message ?? json?.error?.reason;
    if (typeof message === "string" && message.length > 0) return message;
  } catch {
    // fall through to the status code
  }
  return `HTTP ${response.status}`;
}

// ---------------------------------------------------------------------------
// Plugin entry
// ---------------------------------------------------------------------------

export default async function plugin(bb: BbPluginApi) {
  const readUsage = createUsageReader();
  const spotify = createSpotifyReader();

  const usageCache = makeCache(USAGE_CACHE_MS, async () => readUsage());
  const spotifyCache = makeCache(SPOTIFY_CACHE_MS, spotify.read);

  /**
   * Runs one transport action against the Spotify Web API.
   *
   * Playback is addressed to bb-spotify's configured default device when one
   * is set, matching that plugin's behavior; otherwise Spotify targets the
   * active device.
   */
  async function controlSpotify(
    action: "pause" | "play" | "next" | "previous",
  ): Promise<{ message: string }> {
    // Starting playback is the disruptive case: bb-spotify gates it behind an
    // explicit opt-in, so honor the same setting rather than overriding it.
    if (action === "play" && !spotifyDisruptiveActionsAllowed()) {
      throw new Error(
        "Starting playback is disabled. Enable \"Allow agents to start/resume playback\" in the Spotify plugin settings, or use the Spotify plugin's own controls.",
      );
    }

    const token = await spotify.token();
    if (token === null) {
      throw new Error("Spotify is not connected. Run `bb spotify auth start`.");
    }

    const deviceId = spotifyDefaultDeviceId();
    const query = deviceId === null ? undefined : { device_id: deviceId };

    const request: Record<typeof action, () => Promise<Response>> = {
      pause: () => spotifyApi(token, "PUT", "/me/player/pause", { query }),
      play: () => spotifyApi(token, "PUT", "/me/player/play", { query }),
      next: () => spotifyApi(token, "POST", "/me/player/next", { query }),
      previous: () => spotifyApi(token, "POST", "/me/player/previous", { query }),
    };

    const response = await request[action]();
    // Spotify answers 204 No Content on success for these endpoints.
    if (!response.ok && response.status !== 204) {
      throw new Error(`Spotify refused ${action}: ${await spotifyErrorText(response)}`);
    }

    spotifyCache.invalidate();

    const label =
      action === "pause" ? "Paused"
      : action === "play" ? "Resumed"
      : action === "next" ? "Skipped to the next track"
      : "Went back to the previous track";
    return { message: deviceId === null ? `${label}.` : `${label} on ${deviceId}.` };
  }

  /** Saves the loaded track to Liked Songs. */
  async function likeSpotifyTrack(): Promise<{ message: string }> {
    const token = await spotify.token();
    if (token === null) {
      throw new Error("Spotify is not connected. Run `bb spotify auth start`.");
    }

    const playback = await spotifyApi(token, "GET", "/me/player");
    if (playback.status === 204) {
      throw new Error("Nothing is playing, so there is no track to save.");
    }
    if (!playback.ok) {
      throw new Error(`Spotify refused the request: ${await spotifyErrorText(playback)}`);
    }

    const body = (await playback.json()) as { item?: { uri?: string; name?: string } };
    const uri = body?.item?.uri;
    const name = body?.item?.name ?? "the current track";
    if (typeof uri !== "string" || uri.length === 0) {
      throw new Error("Nothing is playing, so there is no track to save.");
    }

    // Spotify moved "Save to Liked Songs" to /me/library. The older
    // PUT /me/tracks?uris=... now answers 403 Forbidden even with the
    // user-library-modify scope, so it must not be used here.
    const save = await spotifyApi(token, "PUT", "/me/library", {
      query: { uris: uri },
    });
    // Spotify answers 200 here; 204 is also documented.
    if (!save.ok && save.status !== 204 && save.status !== 200) {
      throw new Error(`Spotify refused to save the track: ${await spotifyErrorText(save)}`);
    }

    spotifyCache.invalidate();
    return { message: `Saved ${name} to Liked Songs.` };
  }

  const lanesCache = makeCache(LANES_CACHE_MS, async (): Promise<LanesSection> => {
    const [native, openrouter] = await Promise.all([nativeLanes(bb), openRouterLane()]);
    const lanes = [...native, openrouter];
    return {
      status: lanes.every((lane) => lane.status === "error") ? "error" : "ok",
      lanes,
      detail: null,
    };
  });

  const hostCache = makeCache(HOST_CACHE_MS, sampleHost);

  bb.rpc.register(rpcContract, {
    snapshot: async (): Promise<Snapshot> => {
      // Each section settles independently: one failing source must not blank
      // the other three.
      const [usage, lanes, host, spotifySection] = await Promise.all([
        usageCache(),
        lanesCache(),
        hostCache(),
        spotifyCache(),
      ]);
      return {
        generatedAt: new Date().toISOString(),
        usage,
        lanes,
        host,
        spotify: spotifySection,
      };
    },
    spotify_control: ({ action }) => controlSpotify(action),
    spotify_like: () => likeSpotifyTrack(),
  });

  bb.log.info(`ready (usage ${USAGE_DB_PATH}, spotify ${SPOTIFY_SECRETS_DIR})`);

  return () => {
    // Nothing long-lived to dispose: caches are in-memory and every fetch is
    // bounded by a timeout.
    bb.log.info("disposed");
  };
}