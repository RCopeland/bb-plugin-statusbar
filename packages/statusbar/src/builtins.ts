// The bar's own fallback readers, one per topic.
//
// These exist so the bar is useful with nothing else installed. When a provider
// plugin for a topic is loaded, that provider wins and the corresponding reader
// here is simply not called — but it is never removed, because disabling a
// provider must fall back to a working bar rather than an empty one.
//
// HISTORY: usage and lanes were duplicated from bb-plugin-usage-footer and
// bb-plugin-lanes because BB had no cross-plugin data channel. It does now
// (plugin-to-plugin RPC), so the intent is for those plugins to publish the
// section themselves and for these readers to become the offline fallback
// rather than the primary source. Until they do, this is still the live path,
// and the duplication caveat in the README still applies to it.

import { readFile } from "node:fs/promises";
import { homedir, cpus, loadavg, totalmem, freemem, hostname } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import {
  metricsSection,
  sectionPayloadSchema,
  unavailableSection,
  type SectionPayload,
} from "bb-statusbar-section-protocol";

const USAGE_DB_PATH = join(homedir(), ".bb", "plugins", "usage", "data.db");
const BB_DB_PATH = join(homedir(), ".bb", "bb.db");
const SPOTIFY_SECRETS_DIR = join(homedir(), ".bb", "plugins", "spotify", "secrets");
const ENV_JSON_PATH = join(homedir(), ".bb", "env.json");
const FETCH_TIMEOUT_MS = 20_000;

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/** A cached async value with a fixed lifetime, plus explicit invalidation. */
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
    // `df -Pk` prints a header then one row.
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

/** Mirrors the bar's own tone vocabulary: attention at 75%, critical at 90%. */
function toneForPercent(value: number | null): "neutral" | "attention" | "critical" {
  if (value === null) return "neutral";
  if (value >= 90) return "critical";
  if (value >= 75) return "attention";
  return "neutral";
}

function money(value: number | null): string {
  if (value === null) return "—";
  if (value === 0) return "$0.00";
  if (value < 0.01) return "<$0.01";
  if (value < 1000) return `$${value.toFixed(2)}`;
  return `$${Math.round(value).toLocaleString()}`;
}

function percent(value: number | null): string {
  if (value === null) return "—";
  return value > 0 && value < 10 ? `${value.toFixed(1)}%` : `${Math.round(value)}%`;
}

function localDay(now: Date): string {
  return [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, "0"),
    String(now.getDate()).padStart(2, "0"),
  ].join("-");
}

// ---------------------------------------------------------------------------
// Usage — duplicated from bb-plugin-usage-footer
// ---------------------------------------------------------------------------

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

  return function readUsage(): SectionPayload {
    try {
      const conn = connection();
      const latest = conn
        .prepare(`SELECT MAX(day) AS day FROM usage_events`)
        .get() as { day: string | null } | undefined;
      const latestDay = latest?.day ?? null;

      if (latestDay === null) {
        return unavailableSection({
          topic: "usage",
          status: "idle",
          detail: "No usage recorded yet.",
        });
      }

      const todayRow = conn
        .prepare(`SELECT SUM(cost_usd) AS cost FROM usage_events WHERE day = ?`)
        .get(latestDay) as { cost: number | null } | undefined;

      const monthLabel = latestDay.slice(0, 7);
      const monthRow = conn
        .prepare(`SELECT SUM(cost_usd) AS cost FROM usage_events WHERE day LIKE ?`)
        .get(`${monthLabel}%`) as { cost: number | null } | undefined;

      const isToday = latestDay === localDay(new Date());
      return sectionPayloadSchema.parse({
        topic: "usage",
        status: "ok",
        presentation: "headline",
        metrics: [
          {
            label: "MTD",
            value: money(Number(monthRow?.cost ?? 0)),
            tone: "neutral",
            detail: `Month to date (${monthLabel}).`,
          },
        ],
        headline: money(Number(todayRow?.cost ?? 0)),
        // The bar labels today's figure honestly when the newest data is older
        // than the current calendar day.
        detail: isToday ? null : `Latest data is ${latestDay}.`,
      });
    } catch (error) {
      return unavailableSection({
        topic: "usage",
        detail: `Usage store unreadable: ${(error as Error).message}`,
      });
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

interface LaneReading {
  label: string;
  value: string;
  tone: "neutral" | "attention" | "critical";
  detail: string | null;
}

function laneMetric(name: string, usedPercent: number | null, resetLabel: string | null, detail: string | null): LaneReading {
  const suffix = resetLabel === null ? "" : ` ↻${resetLabel}`;
  return {
    label: name,
    value: `${percent(usedPercent)}${suffix}`,
    tone: toneForPercent(usedPercent),
    detail,
  };
}

/**
 * A lane that could not be read.
 *
 * The `detail` is carried as the metric label rather than left to a tooltip:
 * the pre-split bar rendered `Claude: provider reported "unconfigured"` as
 * visible text, and a lane that silently shows `—` is worse than one that says
 * why.
 */
function brokenLane(name: string, detail: string): LaneReading {
  return { label: name, value: "—", tone: "critical", detail };
}

/** "↻4h" / "↻2d" / "↻12m" — when a refilling quota comes back. */
function resetLabel(resetsAt: string | null): string | null {
  if (resetsAt === null) return null;
  const target = new Date(resetsAt).getTime();
  if (!Number.isFinite(target)) return null;
  const seconds = Math.floor((target - Date.now()) / 1000);
  if (seconds <= 0) return "now";
  if (seconds < 3600) return `${Math.max(1, Math.floor(seconds / 60))}m`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86_400)}d`;
}

async function nativeLanes(bb: BbPluginApi): Promise<LaneReading[]> {
  const spec: Array<[string, string]> = [
    ["claudeCode", "Claude"],
    ["codex", "Codex"],
  ];

  try {
    const usage = (await bb.sdk.system.usageLimits()) as Record<string, any>;
    return spec.flatMap(([key, name]) => {
      const provider = usage?.[key];
      // A provider that is not installed is not a lane — omit rather than
      // render a permanently empty row.
      if (!provider || provider.status === "not_installed") return [];
      if (provider.status !== "ok") {
        return [
          {
            label: name,
            value: "—",
            tone: "critical" as const,
            detail: `provider reported "${provider.status}"`,
          },
        ];
      }
      const windows = (provider.windows ?? []) as Array<{ label?: string; usedPercent?: number; resetsAt?: string | null }>;
      if (windows.length === 0) return [laneMetric(name, null, null, null)];

      let worst = windows[0]!;
      for (const candidate of windows) {
        if (Number(candidate.usedPercent ?? 0) > Number(worst.usedPercent ?? 0)) worst = candidate;
      }
      return [
        laneMetric(
          name,
          Number(worst.usedPercent ?? 0),
          worst.resetsAt ?? null,
          String(worst.label ?? "window"),
        ),
      ];
    });
  } catch (error) {
    return spec.map(([, name]) => ({
      label: name,
      value: "—",
      tone: "critical" as const,
      detail: `usage lookup failed: ${(error as Error).message}`,
    }));
  }
}

async function openRouterLane(): Promise<LaneReading> {
  const key = await readEnvKey("OPENROUTER_API_KEY");
  if (key === "") {
    return {
      label: "OpenRouter",
      value: "not configured",
      tone: "neutral",
      detail: "no OPENROUTER_API_KEY in bb's env store",
    };
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
    // Metered: this balance does not refill on its own, so no reset arrow.
    return laneMetric(
      "OpenRouter",
      total > 0 ? (used / total) * 100 : 0,
      null,
      `$${remaining.toFixed(2)} left`,
    );
  } catch (error) {
    return {
      label: "OpenRouter",
      value: "—",
      tone: "critical",
      detail: (error as Error).message,
    };
  }
}

// ---------------------------------------------------------------------------
// Host — sampled in-plugin, deliberately minimal (host-monitor owns history
// and the process list; the bar only needs a current reading)
// ---------------------------------------------------------------------------

let lastCpuTimes: { idle: number; total: number } | null = null;

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

async function readHost(): Promise<SectionPayload> {
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

    const loadTone: "neutral" | "attention" | "critical" =
      load === null ? "neutral" : load / cores >= 2 ? "critical" : load / cores >= 1 ? "attention" : "neutral";

    return metricsSection({
      topic: "host",
      metrics: [
        { label: "CPU", value: percent(cpuValue), tone: toneForPercent(cpuValue), detail: null },
        { label: "MEM", value: percent(memoryPercent), tone: toneForPercent(memoryPercent), detail: null },
        // DISK and load are the first to go on a narrow window, matching the
        // pre-split bar's compact behavior.
        {
          label: "DISK",
          value: percent(diskPercent),
          tone: toneForPercent(diskPercent),
          detail: null,
          importance: "secondary" as const,
        },
        {
          label: "load",
          value: load === null ? "—" : load.toFixed(2),
          tone: loadTone,
          detail: `${cores} logical core${cores === 1 ? "" : "s"}.`,
          importance: "secondary" as const,
        },
      ],
      detail: null,
    });
  } catch (error) {
    return unavailableSection({ topic: "host", status: "error", detail: (error as Error).message });
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
 */
export function readSpotifySetting(key: string): unknown {
  try {
    const db = new DatabaseSync(BB_DB_PATH, { readOnly: true });
    try {
      db.exec("PRAGMA busy_timeout = 2000");
      const row = db
        .prepare(`SELECT value FROM plugin_settings WHERE plugin_id = 'spotify' AND key = ?`)
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
export function spotifyDisruptiveActionsAllowed(): boolean {
  return readSpotifySetting("allowDisruptiveActions") === true;
}

export function spotifyDefaultDeviceId(): string | null {
  const value = readSpotifySetting("defaultDeviceId");
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

export function createSpotifyReader() {
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

  async function readSpotify(): Promise<SectionPayload> {
    const unavailable = (detail: string, status: "idle" | "unavailable" | "error" = "unavailable"): SectionPayload =>
      unavailableSection({ topic: "spotify", status, detail });

    try {
      const token = await getAccessToken();
      if (token === null) {
        return unavailable("Spotify not connected. Run `bb spotify auth start`.");
      }

      const response = await fetchWithTimeout("https://api.spotify.com/v1/me/player", {
        headers: { authorization: `Bearer ${token}` },
      });
      // 204 = nothing playing on any device. Not an error.
      if (response.status === 204) {
        return sectionPayloadSchema.parse({
          topic: "spotify",
          status: "idle",
          presentation: "text",
          text: "♪ nothing playing",
        });
      }
      if (!response.ok) throw new Error(`HTTP ${response.status}`);

      const playback = (await response.json()) as any;
      const item = playback?.item;
      const progressMs = typeof playback?.progress_ms === "number" ? playback.progress_ms : null;
      const durationMs = typeof item?.duration_ms === "number" ? item.duration_ms : null;
      const artists = item?.artists?.map((artist: any) => String(artist.name)) ?? [];
      const hasTrack = typeof item?.uri === "string" && item.uri.length > 0;
      const isPlaying = Boolean(playback?.is_playing);

      const text =
        item?.name === undefined
          ? "♪ nothing playing"
          : `${isPlaying ? "♪" : "♪ ❚❚"} ${artists.join(", ")} — ${String(item.name)}`;

      const progressLabel =
        progressMs !== null && durationMs !== null && durationMs > 0
          ? `${Math.round((progressMs / durationMs) * 100)}%`
          : null;

      return sectionPayloadSchema.parse({
        topic: "spotify",
        status: hasTrack ? "ok" : "idle",
        presentation: "text",
        metrics:
          progressLabel === null
            ? []
            : [
                {
                  label: "",
                  value: progressLabel,
                  tone: "neutral",
                  detail: "Track progress.",
                  importance: "secondary",
                },
              ],
        text,
        // Controls travel with the reading, so the bar renders them only when
        // the provider that owns them is the one answering.
        actions: [
          { id: "previous", label: "Previous track", glyph: "⏮" },
          { id: isPlaying ? "pause" : "play", label: isPlaying ? "Pause" : "Play", glyph: isPlaying ? "❚❚" : "▶" },
          { id: "next", label: "Next track", glyph: "⏭" },
          { id: "like", label: "Save to Liked Songs", glyph: "♥", enabled: hasTrack },
        ],
        detail: playback?.device?.name ?? null,
      });
    } catch (error) {
      return unavailable((error as Error).message, "error");
    }
  }

  return {
    read: readSpotify,
    /** Server-side only. The value must never reach the frontend or a log. */
    token: getAccessToken,
  };
}

// ---------------------------------------------------------------------------
// Cache lifetimes
// ---------------------------------------------------------------------------

const HOST_CACHE_MS = 5_000;
/**
 * Spotify changes from outside the bar too (the user pausing in the Spotify
 * app, a track ending, a different device taking over). This TTL is the worst
 * case for noticing such a change, so keep it short.
 */
const SPOTIFY_CACHE_MS = 3_000;
const USAGE_CACHE_MS = 60_000;
const LANES_CACHE_MS = 60_000;

/**
 * Builds the bar's built-in readers, one per topic.
 *
 * Each is independently cached and independently failing: a broken usage store
 * must not stop the host reading from rendering.
 */
export function createBuiltins(bb: BbPluginApi) {
  const readUsage = createUsageReader();
  const spotify = createSpotifyReader();

  const usageCache = makeCache(USAGE_CACHE_MS, async () => readUsage());
  const spotifyCache = makeCache(SPOTIFY_CACHE_MS, spotify.read);
  const hostCache = makeCache(HOST_CACHE_MS, readHost);

  const lanesCache = makeCache(LANES_CACHE_MS, async (): Promise<SectionPayload> => {
    const [native, openrouter] = await Promise.all([nativeLanes(bb), openRouterLane()]);
    const lanes = [...native, openrouter];
    if (lanes.length === 0) {
      return unavailableSection({ topic: "lanes", status: "idle", detail: "no lanes" });
    }
    return metricsSection({ topic: "lanes", metrics: lanes });
  });

  return {
    usage: usageCache,
    lanes: lanesCache,
    host: hostCache,
    spotify: spotifyCache,
    /** Exposed so transport controls can force a fresh reading after a click. */
    invalidateSpotify: () => spotifyCache.invalidate(),
    spotifyToken: spotify.token,
  };
}
