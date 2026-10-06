// bb-plugin-statusbar — frontend entry.
//
// One fixed bar at the bottom of the BB window, rendered through
// `experimental_appOverlay`. BB mounts that slot once per app window, outside
// route-owned layout regions, and supplies NO chrome, positioning, visibility,
// or responsive behavior — all of that is owned here, deliberately.
//
// The bar renders *section payloads*, not a fixed set of hard-coded readers.
// A section is produced either by a provider plugin or by the bar's own
// fallback, and both arrive in the same shape (see the section protocol). That
// is what lets a section's data move to the plugin that owns it without the
// bar's rendering changing.
//
// What the bar still owns, and deliberately so:
//
//   - Ordering. Providers cannot push themselves to the front.
//   - Layout, compaction, and the reserved strip.
//   - The tone vocabulary, so "amber" means the same thing in every section.
//   - How many sections fit; the least load-bearing are dropped first.
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { definePluginApp, useRpc } from "@get-bb/plugin-sdk/app";
import type { SectionPayload } from "bb-statusbar-section-protocol";
import type { Snapshot, rpcContract } from "./server";

/**
 * How often the bar re-reads the snapshot.
 *
 * This is the worst-case delay before an out-of-band change (pausing in the
 * Spotify app, a track ending) shows up. The server caches each section
 * separately, so a tick is cheap.
 */
const POLL_INTERVAL_MS = 3_000;

/** Below this width the bar drops labels and keeps the numbers. */
const COMPACT_BREAKPOINT_PX = 900;

// ---------------------------------------------------------------------------
// Tone vocabulary
// ---------------------------------------------------------------------------

type Tone = "neutral" | "attention" | "critical";

/** Thresholds mirror host-monitor's vocabulary so a colour means the same
 *  thing across BB surfaces: attention at 75%, critical at 90%. */
const TONE_CLASS: Record<Tone, string> = {
  neutral: "text-muted-foreground",
  attention: "text-amber-500",
  critical: "text-red-500",
};

// ---------------------------------------------------------------------------
// Shell
// ---------------------------------------------------------------------------

/** A separator that is decorative only — screen readers get the group labels. */
function Divider() {
  return <span aria-hidden="true" className="h-3 w-px shrink-0 bg-border" />;
}

/** Muted text used whenever a section has nothing truthful to show. */
function Fallback({ children }: { children: React.ReactNode }) {
  return <span className="truncate text-muted-foreground/70">{children}</span>;
}

/**
 * Renders one section payload.
 *
 * A section that is not `ok` renders its `detail` as a short muted label
 * rather than disappearing: a section that has silently vanished reads as a
 * bug, while "usage: unavailable" reads as a fact about the world.
 */
function SectionItem({ section, compact }: { section: SectionPayload; compact: boolean }) {
  if (section.status !== "ok" && section.status !== "idle") {
    return <Fallback>{section.topic}: {section.detail ?? section.status}</Fallback>;
  }

  if (section.status === "idle") {
    return <Fallback>{section.detail ?? section.text ?? section.topic}</Fallback>;
  }

  if (section.presentation === "headline") {
    return (
      <span
        aria-label={section.topic}
        className="flex min-w-0 shrink-0 items-center gap-2"
        role="group"
      >
        <span className="shrink-0 font-medium tabular-nums text-foreground">
          {section.headline}
          {/* A stale reading is labelled rather than passed off as current. */}
          {section.detail !== null && !compact ? (
            <span className="font-normal text-muted-foreground/60" title={section.detail}> </span>
          ) : null}
        </span>
        {section.metrics
          .filter((metric) => metric.label !== "")
          .map((metric) => (
            <span className="shrink-0 tabular-nums" key={metric.label} title={metric.detail ?? undefined}>
              <span className="text-muted-foreground/60">{metric.label}</span>{" "}
              <span className={TONE_CLASS[metric.tone]}>{metric.value}</span>
            </span>
          ))}
      </span>
    );
  }

  if (section.presentation === "text") {
    return (
      <span
        aria-label={section.topic}
        className="flex min-w-0 shrink-0 items-center gap-2"
        role="group"
        title={section.detail ?? undefined}
      >
        <span className="truncate text-muted-foreground">{section.text}</span>
      </span>
    );
  }

  // "metrics": a glanceable row of labelled numbers.
  return (
    <span
      aria-label={section.topic}
      className="flex min-w-0 shrink-0 items-center gap-2"
      role="group"
    >
      {section.metrics.map((metric) => (
        <span
          className="shrink-0 tabular-nums"
          key={`${metric.label}:${metric.value}`}
          title={metric.detail ?? undefined}
        >
          {metric.label === "" ? null : (
            <span className="text-muted-foreground/60">{metric.label}</span>
          )}{" "}
          <span className={TONE_CLASS[metric.tone]}>{metric.value}</span>
        </span>
      ))}
    </span>
  );
}

/**
 * One provider-supplied control, sized for the 24px bar.
 *
 * Real `<button>` so it is keyboard reachable; `aria-label` carries the name
 * and `title` gives the hover hint.
 */
function SectionActionButton({
  action,
  busy,
  onActivate,
}: {
  action: SectionPayload["actions"][number];
  busy: boolean;
  onActivate: (actionId: string) => void;
}) {
  return (
    <button
      aria-label={action.label}
      className="inline-flex size-4 shrink-0 items-center justify-center rounded-sm text-[11px] leading-none text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-40"
      disabled={!action.enabled || busy}
      onClick={(event) => {
        // Do not let the click fall through to whatever BB has behind the bar.
        event.stopPropagation();
        onActivate(action.id);
      }}
      title={action.label}
      type="button"
    >
      {busy ? "…" : action.glyph}
    </button>
  );
}

/** Attributes this bar's DOM so host CSS and debugging can target it. */
const BAR_ATTRIBUTE = "data-bb-plugin";

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
   * Runs a section action and refreshes immediately.
   *
   * Waiting for the next poll tick would make a click feel unresponsive, so
   * the bar refreshes as soon as the action settles.
   */
  const runAction = async (topic: string, actionId: string) => {
    setBusyAction(actionId);
    try {
      const result = await rpc.call("section_action", {
        topic: topic as SectionPayload["topic"],
        actionId,
      });
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

  // The longest, least load-bearing section is the first to go when width is
  // tight. Everything else stays: a bar that drops the cost figure to keep the
  // track name would be optimizing for the wrong thing.
  const visible = compact
    ? snapshot.sections.filter((section) => section.topic !== "spotify")
    : snapshot.sections;

  return (
    <Shell>
      {visible.map((section, index) => (
        <span className="contents" key={section.topic}>
          {index > 0 ? <Divider /> : null}
          <SectionItem compact={compact} section={section} />
          {section.actions.map((action) => (
            <SectionActionButton
              action={action}
              busy={busyAction === action.id}
              key={action.id}
              onActivate={(actionId) => void runAction(section.topic, actionId)}
            />
          ))}
        </span>
      ))}
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
      {...{ [BAR_ATTRIBUTE]: "statusbar" }}
      style={{ height: `${BAR_HEIGHT_PX}px` }}
    >
      {children}
    </div>
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

export default definePluginApp((app) => {
  app.slots.experimental_appOverlay({
    id: "bottom-status-bar",
    component: StatusBar,
  });
});
