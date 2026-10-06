// bb-plugin-statusbar-section-lanes — contributes the `lanes` section.
//
// This is what the split exists for. bb-plugin-lanes already knows how to read
// lane headroom (Claude Code and Codex from bb itself, OpenRouter from its
// credits endpoint). Rather than the statusbar carrying a copy of that logic
// that drifts, the plugin that owns the data publishes it here.
//
// HOW CONTRIBUTION WORKS
//
// There is no manifest dependency on the statusbar and nothing to install in
// order. This plugin publishes a discoverable RPC method; a loaded statusbar
// finds it, asks for a reading, and prefers it over its own built-in lanes
// reader. If no statusbar is loaded, this plugin still runs and costs nothing:
// nothing ever calls it.
//
// The plugin therefore does NOT check "is the statusbar installed" in its
// factory. It cannot — `bb.sdk` does not exist until the server is listening,
// and the answer can change while the plugin is running. Contribution is
// pull-based by design, so the only thing this plugin owes the bar is a
// correct answer when asked.

import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import {
  SECTION_METHOD_ACTION,
  SECTION_METHOD_SNAPSHOT,
  metricsSection,
  sectionActionRequestSchema,
  sectionActionResponseSchema,
  sectionSnapshotResponseSchema,
  unavailableSection,
  type SectionMetric,
} from "bb-statusbar-section-protocol";

const PROVIDER_VERSION = "0.1.0";

/** Credentials live in bb's env store: FILE FIRST, process.env only as fallback. */
async function readEnvKey(name: string): Promise<string> {
  const { readFile } = await import("node:fs/promises");
  const { homedir } = await import("node:os");
  const { join } = await import("node:path");
  try {
    const raw = await readFile(join(homedir(), ".bb", "env.json"), "utf8");
    const fromFile = (JSON.parse(raw)?.env ?? {})[name];
    if (typeof fromFile === "string" && fromFile.length > 0) return fromFile;
  } catch {
    // fall through
  }
  return process.env[name] ?? "";
}

function percent(value: number | null): string {
  if (value === null) return "—";
  return value > 0 && value < 10 ? `${value.toFixed(1)}%` : `${Math.round(value)}%`;
}

function toneFor(usedPercent: number | null): "neutral" | "attention" | "critical" {
  if (usedPercent === null) return "neutral";
  if (usedPercent >= 90) return "critical";
  if (usedPercent >= 75) return "attention";
  return "neutral";
}

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

/** bb's own subscription windows: Claude Code and Codex. */
async function nativeLanes(bb: BbPluginApi): Promise<SectionMetric[]> {
  const spec: Array<[string, string]> = [
    ["claudeCode", "Claude"],
    ["codex", "Codex"],
  ];

  try {
    const usage = (await bb.sdk.system.usageLimits()) as Record<string, any>;
    return spec.flatMap(([key, name]): SectionMetric[] => {
      const provider = usage?.[key];
      // Not installed is not a lane: omit rather than render an empty row.
      if (!provider || provider.status === "not_installed") return [];
      if (provider.status !== "ok") {
        return [{ label: name, value: "—", tone: "critical" as const, detail: `provider reported "${provider.status}"` }];
      }
      const windows = (provider.windows ?? []) as Array<{ label?: string; usedPercent?: number; resetsAt?: string | null }>;
      if (windows.length === 0) {
        return [{ label: name, value: "—", tone: "neutral" as const, detail: null }];
      }
      let worst = windows[0]!;
      for (const candidate of windows) {
        if (Number(candidate.usedPercent ?? 0) > Number(worst.usedPercent ?? 0)) worst = candidate;
      }
      const used = Number(worst.usedPercent ?? 0);
      const reset = resetLabel(worst.resetsAt ?? null);
      return [
        {
          label: name,
          value: `${percent(used)}${reset === null ? "" : ` ↻${reset}`}`,
          tone: toneFor(used),
          detail: String(worst.label ?? "window"),
        },
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

/** OpenRouter is metered: its balance does not refill on its own. */
async function openRouterLane(): Promise<SectionMetric> {
  const key = await readEnvKey("OPENROUTER_API_KEY");
  if (key === "") {
    return { label: "OpenRouter", value: "not configured", tone: "neutral", detail: "no OPENROUTER_API_KEY in bb's env store" };
  }
  try {
    const response = await fetch("https://openrouter.ai/api/v1/credits", {
      headers: { authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const json = (await response.json()) as any;
    const total = Number(json?.data?.total_credits ?? 0);
    const used = Number(json?.data?.total_usage ?? 0);
    const remaining = total - used;
    const usedPercent = total > 0 ? (used / total) * 100 : 0;
    return {
      label: "OpenRouter",
      value: percent(usedPercent),
      tone: toneFor(usedPercent),
      detail: `$${remaining.toFixed(2)} left`,
    };
  } catch (error) {
    return { label: "OpenRouter", value: "—", tone: "critical", detail: (error as Error).message };
  }
}

export const rpcContract = defineRpcContract({
  [SECTION_METHOD_SNAPSHOT]: {
    input: z.null(),
    output: sectionSnapshotResponseSchema,
    experimental_description: "Model lane headroom, as a statusbar section.",
  },
  /**
   * The statusbar routes a section's transport controls to the plugin that
   * owns the section. Lanes have no controls, so this always reports that.
   */
  [SECTION_METHOD_ACTION]: {
    input: sectionActionRequestSchema,
    output: sectionActionResponseSchema,
  },
});

export default async function plugin(bb: BbPluginApi) {
  bb.rpc.register(
    rpcContract,
    {
      [SECTION_METHOD_SNAPSHOT]: async () => {
        const [native, openrouter] = await Promise.all([nativeLanes(bb), openRouterLane()]);
        const metrics = [...native, openrouter];
        return {
          generatedAt: new Date().toISOString(),
          section: metricsSection({ topic: "lanes", metrics }),
        };
      },
      [SECTION_METHOD_ACTION]: ({ actionId }) => {
        throw new Error(`The lanes section has no "${actionId}" action.`);
      },
    },
    {
      // This is what makes the plugin discoverable by the statusbar.
      experimental_discoverable: true,
      experimental_description: `Model lane headroom for the statusbar (provider ${PROVIDER_VERSION}).`,
    },
  );

  bb.log.info(`ready (lanes provider ${PROVIDER_VERSION})`);
}

export { unavailableSection };
