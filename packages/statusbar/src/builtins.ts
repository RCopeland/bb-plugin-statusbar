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
//
// NOTE: there is deliberately no Spotify reader here. See `createBuiltins`.
// The `spotify` topic is served only by bb-plugin-statusbar-spotify.

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
} from "@robcopeland/bb-statusbar-section-protocol";

const USAGE_DB_PATH = join(homedir(), ".bb", "plugins", "usage", "data.db");
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
            // The pre-split bar dropped the month figure on a narrow window
            // and kept today's number, which is the one people glance at.
            importance: "secondary" as const,
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
// Cache lifetimes
// ---------------------------------------------------------------------------

const HOST_CACHE_MS = 5_000;
const USAGE_CACHE_MS = 60_000;
const LANES_CACHE_MS = 60_000;

/**
 * The bar's built-in readers.
 *
 * There is no built-in reader for `spotify`. That section is supplied entirely
 * by the separate `bb-plugin-statusbar-spotify` provider, which claims the
 * topic and is preferred over any built-in. The topic still appears in the
 * protocol's BUILTIN_TOPICS so it keeps its declared position in the row;
 * "built-in" there means "the bar knows this slot", not "the bar computes it".
 *
 * The cost is deliberate: with no fallback, uninstalling that provider leaves
 * the slot empty rather than degrading to a reading computed here. That is the
 * intended tradeoff — the alternative was two independent refresh flows racing
 * on the same Spotify token.
 */
export interface Builtins {
  /** Built-in readers, keyed by topic. A provider-supplied topic is absent. */
  readers: Record<string, () => Promise<SectionPayload>>;
}

export function createBuiltins(bb: BbPluginApi): Builtins {
  const readUsage = createUsageReader();

  const usageCache = makeCache(USAGE_CACHE_MS, async () => readUsage());
  const hostCache = makeCache(HOST_CACHE_MS, readHost);

  const lanesCache = makeCache(LANES_CACHE_MS, async (): Promise<SectionPayload> => {
    const [native, openrouter] = await Promise.all([nativeLanes(bb), openRouterLane()]);
    const lanes = [...native, openrouter];
    if (lanes.length === 0) {
      return unavailableSection({ topic: "lanes", status: "idle", detail: "no lanes" });
    }
    return metricsSection({ topic: "lanes", metrics: lanes });
  });

  /**
   * Built-in readers, keyed by topic.
   *
   * The index signature is deliberate: topics are open, so the bar looks up a
   * provider-invented topic here and legitimately finds nothing. It also keeps
   * this object free of the non-reader members below, which are reached by name
   * rather than by topic.
   */
  return {
    readers: {
      usage: usageCache,
      lanes: lanesCache,
      host: hostCache,
    },
  };
}
