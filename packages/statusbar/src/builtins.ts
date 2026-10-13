// The bar's own fallback readers.
//
// HISTORY, AND WHY THIS FILE IS ALMOST EMPTY
//
// This file used to compute every section itself — usage cost, model lane
// headroom, host resources, and Spotify — because BB had no cross-plugin data
// channel. It does now (plugin-to-plugin RPC), so each topic is supplied by the
// plugin that already owns its data and credentials:
//
//   usage    -> the usage provider plugin
//   lanes    -> the lanes provider plugin
//   spotify  -> bb-statusbar-spotify
//   host     -> still read here (see below)
//
// Each removal was deliberate. The reasoning is the same in every case: a copy
// of another plugin's logic inside the bar drifts from its original, and the
// bar's job is to render sections, not to own them.
//
// WHY A READER REMAINS FOR HOST
//
// `host` is the one topic with no owning plugin, because it is not another
// plugin's data: it is this machine's CPU, memory, disk, and load, sampled
// directly from node:os. There is no second copy anywhere to drift from, so
// there is nothing to extract. If a host-monitor-style provider is installed it
// still wins — this is only the fallback.
//
// A topic with no built-in reader and no provider simply produces no section.
// That is intended: the bar degrades to a shorter row rather than inventing a
// placeholder for data nobody supplied.

import { cpus, loadavg, totalmem, freemem, homedir } from "node:os";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import {
  metricsSection,
  unavailableSection,
  type SectionPayload,
} from "@robcopeland/bb-statusbar-section-protocol";

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/**
 * A cached async value with a fixed lifetime.
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

  read.invalidate = (): void => {
    value = null;
    expiresAt = 0;
  };

  return read;
}

/** Mirrors the bar's own tone vocabulary: attention at 75%, critical at 90%. */
function toneForPercent(value: number | null): "neutral" | "attention" | "critical" {
  if (value === null) return "neutral";
  if (value >= 90) return "critical";
  if (value >= 75) return "attention";
  return "neutral";
}

function percent(value: number | null): string {
  if (value === null) return "—";
  return value > 0 && value < 10 ? `${value.toFixed(1)}%` : `${Math.round(value)}%`;
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

// ---------------------------------------------------------------------------
// Host — sampled here, deliberately minimal (a host-monitor provider owns
// history and the process list; the bar only needs a current reading)
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
        // DISK and load are the first to go on a narrow window.
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

/**
 * The bar's built-in readers.
 *
 * `usage`, `lanes`, and `spotify` are absent on purpose; each is supplied by its
 * own provider plugin. `host` remains because no plugin owns that data — it is
 * this machine, sampled here.
 *
 * A missing topic means no fallback: if nothing provides it, it does not render.
 */
export interface Builtins {
  /** Built-in readers, keyed by topic. A provider-supplied topic is absent. */
  readers: Record<string, () => Promise<SectionPayload>>;
}

export function createBuiltins(_bb: BbPluginApi): Builtins {
  const hostCache = makeCache(HOST_CACHE_MS, readHost);

  return {
    readers: {
      host: hostCache,
    },
  };
}
