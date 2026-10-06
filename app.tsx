// bb-plugin-statusbar — frontend entry.
//
// One fixed bar at the bottom of the BB window, rendered through
// `experimental_appOverlay`. BB mounts that slot once per app window, outside
// route-owned layout regions, and supplies NO chrome, positioning, visibility,
// or responsive behavior — all of that is owned here, deliberately.
//
// Layout:  $12.40 today · $310 MTD │ Claude 62% ↻4h · Codex 18% · OR $42 │
//          CPU 34% MEM 61% DISK 78% │ ♪ Artist — Track ▶
//
// Every section degrades on its own. A source that is missing or failing shows
// a muted short label, and never blanks the other three.
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { definePluginApp, useRpc } from "@get-bb/plugin-sdk/app";
import type {
  HostSection,
  Lane,
  LanesSection,
  Snapshot,
  SpotifySection,
  UsageSection,
  rpcContract,
} from "./server";

/**
 * How often the bar re-reads the snapshot.
 *
 * This is the worst-case delay before an out-of-band change (pausing in the
 * Spotify app, a track ending) shows up. The server caches each section
 * separately, so a tick is cheap: it is mostly memory reads, with at most one
 * small Spotify GET when that section's short TTL has lapsed.
 */
const POLL_INTERVAL_MS = 3_000;

/** Below this width the bar drops labels and keeps the numbers. */
const COMPACT_BREAKPOINT_PX = 900;

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

function money(value: number | null): string {
  if (value === null) return "—";
  if (value === 0) return "$0.00";
  if (value < 0.01) return "<$0.01";
  if (value < 1000) return `$${value.toFixed(2)}`;
  return `$${Math.round(value).toLocaleString()}`;
}

function percent(value: number | null): string {
  if (value === null) return "—";
  // Sub-10% readings keep a decimal so a slow climb is visible.
  return value > 0 && value < 10 ? `${value.toFixed(1)}%` : `${Math.round(value)}%`;
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

type Tone = "neutral" | "attention" | "critical";

/** Thresholds mirror host-monitor's vocabulary so a colour means the same
 *  thing across BB surfaces: attention at 75%, critical at 90%. */
function toneForPercent(value: number | null): Tone {
  if (value === null) return "neutral";
  if (value >= 90) return "critical";
  if (value >= 75) return "attention";
  return "neutral";
}

const TONE_CLASS: Record<Tone, string> = {
  neutral: "text-muted-foreground",
  attention: "text-amber-500",
  critical: "text-red-500",
};

// ---------------------------------------------------------------------------
// Shell
// ---------------------------------------------------------------------------

function Section({
  children,
  label,
}: {
  children: React.ReactNode;
  /** Accessible group name; the visible label is optional. */
  label: string;
}) {
  return (
    <div
      aria-label={label}
      className="flex min-w-0 items-center gap-2"
      role="group"
    >
      {children}
    </div>
  );
}

/** A separator that is decorative only — screen readers get the group labels. */
function Divider() {
  return <span aria-hidden="true" className="h-3 w-px shrink-0 bg-border" />;
}

/** Muted text used whenever a section has nothing truthful to show. */
function Fallback({ children }: { children: React.ReactNode }) {
  return <span className="truncate text-muted-foreground/70">{children}</span>;
}

function Metric({
  label,
  tone = "neutral",
  value,
}: {
  label: string;
  tone?: Tone;
  value: string;
}) {
  return (
    <span className={`shrink-0 tabular-nums ${TONE_CLASS[tone]}`}>
      <span className="text-muted-foreground/60">{label}</span> {value}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Sections
// ---------------------------------------------------------------------------

function UsageItem({ usage, compact }: { usage: UsageSection; compact: boolean }) {
  if (usage.status !== "ok") {
    return <Fallback>usage: {usage.detail ?? "unavailable"}</Fallback>;
  }

  return (
    <Section label="Today's AI usage cost">
      <span className="shrink-0 font-medium tabular-nums text-foreground">
        {money(usage.todayCost)}
        {!compact ? <span className="font-normal text-muted-foreground/60"> today</span> : null}
      </span>
      {!compact ? (
        <span className="shrink-0 tabular-nums text-muted-foreground">
          {money(usage.monthCost)} MTD
        </span>
      ) : null}
      {/* A stale reading is labelled rather than silently passed off as today's. */}
      {usage.detail !== null && !compact ? (
        <span className="truncate text-muted-foreground/60" title={usage.detail}>
          {usage.detail}
        </span>
      ) : null}
    </Section>
  );
}

function LaneItem({ lane }: { lane: Lane }) {
  if (lane.status === "unconfigured") {
    return <Fallback>{lane.name}: not configured</Fallback>;
  }
  if (lane.status === "error") {
    return (
      <Fallback>
        {lane.name}: {lane.detail ?? "error"}
      </Fallback>
    );
  }

  const reset = resetLabel(lane.resetsAt);
  return (
    <span
      className="shrink-0 tabular-nums"
      title={
        lane.worstWindowLabel === null
          ? lane.name
          : `${lane.name} — ${lane.worstWindowLabel} used`
      }
    >
      <span className="text-muted-foreground/60">{lane.name}</span>{" "}
      <span className={TONE_CLASS[toneForPercent(lane.worstUsedPercent)]}>
        {percent(lane.worstUsedPercent)}
      </span>
      {/* Metered balances never refill, so they never show a reset arrow. */}
      {reset !== null && lane.kind === "subscription" ? (
        <span className="text-muted-foreground/60"> ↻{reset}</span>
      ) : null}
    </span>
  );
}

function LanesItem({ lanes, compact }: { lanes: LanesSection; compact: boolean }) {
  if (lanes.lanes.length === 0) return <Fallback>no lanes</Fallback>;
  return (
    <Section label="Model lane headroom">
      {lanes.lanes.map((lane, index) => (
        <span className="flex min-w-0 items-center gap-2" key={lane.id}>
          {index > 0 ? (
            <span aria-hidden="true" className="text-muted-foreground/40">
              ·
            </span>
          ) : null}
          <LaneItem lane={lane} />
        </span>
      ))}
    </Section>
  );
}

function HostItem({ host, compact }: { host: HostSection; compact: boolean }) {
  if (host.status !== "ok") {
    return <Fallback>host: {host.detail ?? "unavailable"}</Fallback>;
  }

  const loadTone: Tone =
    host.load1PerCore === null
      ? "neutral"
      : host.load1PerCore >= 2
        ? "critical"
        : host.load1PerCore >= 1
          ? "attention"
          : "neutral";

  return (
    <Section label="Host resources">
      <Metric label="CPU" tone={toneForPercent(host.cpuPercent)} value={percent(host.cpuPercent)} />
      <Metric
        label="MEM"
        tone={toneForPercent(host.memoryPercent)}
        value={percent(host.memoryPercent)}
      />
      {compact ? null : (
        <Metric
          label="DISK"
          tone={toneForPercent(host.diskPercent)}
          value={percent(host.diskPercent)}
        />
      )}
      {/* Load is only meaningful against the core count. */}
      {host.load1 !== null && !compact ? (
        <Metric
          label="load"
          tone={loadTone}
          value={host.load1.toFixed(2)}
        />
      ) : null}
    </Section>
  );
}

/**
 * One transport button, sized for the 24px bar.
 *
 * Real `<button>` so it is keyboard reachable; `aria-label` carries the name
 * and `title` gives the hover hint. `shrink-0` keeps it from being squeezed
 * out of the row when the track name is long.
 */
function ControlButton({
  busy,
  disabled = false,
  glyph,
  label,
  onClick,
}: {
  busy: boolean;
  disabled?: boolean;
  glyph: string;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      aria-label={label}
      className="inline-flex size-4 shrink-0 items-center justify-center rounded-sm text-[11px] leading-none text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-40"
      disabled={disabled || busy}
      onClick={(event) => {
        // Do not let the click fall through to whatever BB has behind the bar.
        event.stopPropagation();
        onClick();
      }}
      title={label}
      type="button"
    >
      {busy ? "…" : glyph}
    </button>
  );
}

function SpotifyItem({
  busyAction,
  compact,
  onControl,
  onLike,
  spotify,
}: {
  busyAction: string | null;
  compact: boolean;
  onControl: (action: "pause" | "play" | "next" | "previous") => void;
  onLike: () => void;
  spotify: SpotifySection;
}) {
  // Not connected or failing: show the reason, no controls to offer.
  if (spotify.status === "unavailable" || spotify.status === "error") {
    return (
      <Section label="Spotify now playing">
        <Fallback>
          ♪ {spotify.status === "unavailable" ? "not connected" : (spotify.detail ?? "error")}
        </Fallback>
      </Section>
    );
  }

  const idle = spotify.trackName === null;
  const artists = spotify.artistNames.join(", ");

  return (
    <Section label="Spotify now playing">
      {idle ? (
        <Fallback>♪ nothing playing</Fallback>
      ) : (
        <span className="min-w-0 truncate" title={`${artists} — ${spotify.trackName}`}>
          <span aria-hidden="true" className="text-muted-foreground/60">
            ♪{" "}
          </span>
          {!compact && artists !== "" ? (
            <span className="text-muted-foreground">{artists} — </span>
          ) : null}
          <span className="text-foreground">{spotify.trackName}</span>
        </span>
      )}

      {/* Progress is only meaningful while a track is actually advancing. */}
      {spotify.progressPercent !== null && spotify.isPlaying && !compact ? (
        <span
          aria-hidden="true"
          className="relative hidden h-1 w-16 shrink-0 rounded-full bg-muted lg:block"
        >
          <span
            className="absolute inset-y-0 left-0 rounded-full bg-foreground/50"
            style={{ width: `${Math.min(100, Math.max(0, spotify.progressPercent))}%` }}
          />
        </span>
      ) : null}

      <span className="flex shrink-0 items-center gap-0.5">
        <ControlButton
          busy={busyAction === "previous"}
          glyph="⏮"
          label="Previous track"
          onClick={() => onControl("previous")}
        />
        {/* Play is offered even when idle so a paused or empty session can be
            resumed; the server refuses it unless the user opted in. */}
        <ControlButton
          busy={busyAction === "play" || busyAction === "pause"}
          glyph={spotify.isPlaying ? "⏸" : "▶"}
          label={spotify.isPlaying ? "Pause" : "Play"}
          onClick={() => onControl(spotify.isPlaying ? "pause" : "play")}
        />
        <ControlButton
          busy={busyAction === "next"}
          glyph="⏭"
          label="Next track"
          onClick={() => onControl("next")}
        />
        <ControlButton
          busy={busyAction === "like"}
          disabled={!spotify.hasTrack}
          glyph="♥"
          label="Save to Liked Songs"
          onClick={onLike}
        />
      </span>
    </Section>
  );
}

// ---------------------------------------------------------------------------
// The bar
// ---------------------------------------------------------------------------

/** Bar height in px. Kept in one place because the reserved space must match
 *  the rendered bar exactly. */
const BAR_HEIGHT_PX = 24;

/**
 * Reserve room for the bar by shrinking BB's own shell height.
 *
 * BB sizes the app with the CSS variable `--bb-shell-height`, which it sets on
 * <body> and rewrites on every visual-viewport resize. A plain fixed overlay
 * therefore covers the bottom strip of the app (the composer, terminal, and
 * panel footers).
 *
 * Rather than fight BB's resize handler by reassigning the variable, this
 * shortens the value BB computed: it reads the current custom property, and
 * when BB later writes a fresh full value, a MutationObserver on the style
 * attribute re-applies the inset. `<html>` is given the same value because
 * `bb-app-shell-root` reads it too.
 */
/**
 * Reserve room for the bar by shrinking BB's shell height.
 *
 * BB sizes the app entirely from one CSS variable:
 *
 *   :root { --bb-shell-height: 100dvh }        <- default
 *   .bb-app-shell-root { height: var(--bb-shell-height) }
 *
 * On iOS WebKit a hook rewrites it on <body> as the visual viewport changes.
 * On desktop that hook returns immediately (it is gated on an iOS UA check), so
 * the variable stays at its `:root` fallback of `100dvh` — the full viewport.
 * A plain fixed overlay therefore covers the bottom strip of the app.
 *
 * So the reservation is applied to documentElement, which is where the value is
 * actually consumed, and re-applied if BB ever rewrites it there.
 */
function useReservedSpace(enabled: boolean): void {
  useEffect(() => {
    if (!enabled) return;
    const root = document.documentElement;
    const body = document.body;

    // Remember what BB last wrote so re-observing does not compound the shrink.
    const lastSeen = new WeakMap<HTMLElement, string>();
    const INSET = `${BAR_HEIGHT_PX}px`;

    const resize = (element: HTMLElement) => {
      const raw = element.style.getPropertyValue("--bb-shell-height").trim();
      if (raw === "" || lastSeen.get(element) === raw) return;

      const match = /^([\d.]+)px$/u.exec(raw);
      if (match === null || match[1] === undefined) return;

      const next = `${Math.max(0, Number(match[1]) - BAR_HEIGHT_PX)}px`;
      lastSeen.set(element, next);
      element.style.setProperty("--bb-shell-height", next);
    };

    // The desktop case: no inline value anywhere, so override the :root
    // fallback directly. An inline `calc` wins over the stylesheet.
    const reserveRoot = () => {
      root.style.setProperty("--bb-shell-height", `calc(100dvh - ${INSET})`);
    };
    reserveRoot();

    const apply = () => {
      resize(root);
      resize(body);
    };

    // BB only writes the variable on <body>, and only on iOS. Watch both so the
    // reservation survives whichever path runs.
    const observer = new MutationObserver(apply);
    observer.observe(body, { attributeFilter: ["style"] });
    observer.observe(root, { attributeFilter: ["style"] });

    const onResize = () => {
      // A resize rebuilds the fallback case first, then any BB value on top.
      reserveRoot();
      apply();
    };
    window.addEventListener("resize", onResize);

    return () => {
      observer.disconnect();
      window.removeEventListener("resize", onResize);
      root.style.removeProperty("--bb-shell-height");
    };
  }, [enabled]);
}

function StatusBar() {
  const rpc = useRpc<typeof rpcContract>();
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [compact, setCompact] = useState(false);
  /** Which control is in flight, so that button can show a pending state. */
  const [busyAction, setBusyAction] = useState<string | null>(null);

  // One interval for the whole bar; the server caches each section so this
  // stays cheap. Cancelled on unmount and never restarted by a stale closure.
  const loadRef = useRef<() => void>(() => {});
  loadRef.current = () => {
    rpc.call("snapshot").then(
      (next) => {
        setSnapshot(next as Snapshot);
        setError(null);
      },
      (cause: unknown) => {
        setError(cause instanceof Error ? cause.message : String(cause));
      },
    );
  };

  useEffect(() => {
    loadRef.current();
    const timer = setInterval(() => loadRef.current(), POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, []);

  // The overlay owns its own responsive behavior; BB does not do this for it.
  useEffect(() => {
    const update = () => setCompact(window.innerWidth < COMPACT_BREAKPOINT_PX);
    update();
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, []);

  // Reserve the strip the bar occupies so it never covers BB's own UI.
  useReservedSpace(true);

  /**
   * Runs a Spotify control and refreshes immediately.
   *
   * The bar's poll interval is 10s, so waiting for the next tick would make a
   * click feel unresponsive. The server drops its cache on success, so the
   * refresh here reflects the new state.
   */
  const runSpotify = async (
    busy: string,
    action: () => Promise<{ message: string }>,
  ) => {
    setBusyAction(busy);
    try {
      const result = await action();
      loadRef.current();
      toast.success(result.message);
    } catch (cause) {
      // A refusal (e.g. playback disabled) is expected behavior, not a crash:
      // surface the server's own message so the reason is actionable.
      toast.error(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusyAction(null);
    }
  };

  const onControl = (action: "pause" | "play" | "next" | "previous") =>
    void runSpotify(action, () => rpc.call("spotify_control", { action }));

  const onLike = () => void runSpotify("like", () => rpc.call("spotify_like", null));

  if (error !== null && snapshot === null) {
    return (
      <Shell>
        <Fallback>Statusbar unavailable: {error}</Fallback>
      </Shell>
    );
  }

  if (snapshot === null) {
    return (
      <Shell>
        <Fallback>Loading…</Fallback>
      </Shell>
    );
  }

  return (
    <Shell>
      <UsageItem compact={compact} usage={snapshot.usage} />
      <Divider />
      <LanesItem compact={compact} lanes={snapshot.lanes} />
      <Divider />
      <HostItem compact={compact} host={snapshot.host} />
      {/* Always rendered, even when idle: hiding the section made the feature
          look absent rather than quiet. It is the first thing to go when
          width is tight, because it is the longest and least load-bearing. */}
      {!compact ? (
        <>
          <Divider />
          <SpotifyItem
            busyAction={busyAction}
            compact={compact}
            onControl={onControl}
            onLike={onLike}
            spotify={snapshot.spotify}
          />
        </>
      ) : null}
    </Shell>
  );
}

/**
 * The bar's own chrome.
 *
 * BB mounts app overlays inside a `display: contents` wrapper, so the host
 * positioning is not guaranteed: the strip fixes itself to the bottom and
 * reserves its own height. `useReservedSpace` shrinks BB's shell by the same
 * amount, so the bar sits in a real reserved strip rather than covering the
 * app's bottom edge (composer, terminal, panel footers).
 */
function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div
      className="fixed inset-x-0 bottom-0 z-40 flex items-center gap-3 overflow-hidden border-t border-border bg-background px-3 text-[11px] leading-none"
      data-bb-plugin="statusbar"
      style={{ height: `${BAR_HEIGHT_PX}px` }}
    >
      {children}
    </div>
  );
}

export default definePluginApp((app) => {
  app.slots.experimental_appOverlay({
    id: "bottom-status-bar",
    component: StatusBar,
  });
});