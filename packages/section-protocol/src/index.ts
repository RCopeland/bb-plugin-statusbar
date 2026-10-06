// bb-statusbar-section-protocol — the wire contract between the Statusbar
// plugin and any plugin that contributes a section to it.
//
// WHY THIS PACKAGE EXISTS
//
// BB has no plugin dependency mechanism: there is no `dependsOn`, no load
// ordering, and no way for one plugin to require another. A section provider
// therefore cannot "require" the statusbar in a way the host enforces.
//
// What BB does provide (verified against bb 0.44.0) is plugin-to-plugin RPC:
//
//   - `bb.rpc.register(contract, handlers, { experimental_discoverable: true })`
//     publishes a method on POST /api/v1/plugins/<id>/rpc/<method> and lists it
//     for `bb plugin rpc list` / `inspect` / `bb.sdk.plugins.experimental_discoverRpc`.
//   - `bb.sdk.plugins.callRpc({ pluginId, method, input, outputSchema })` calls
//     it from another plugin's handler, service, or timer.
//
// So the dependency is expressed as DISCOVERY rather than as a manifest
// requirement. The bar advertises what it needs; providers advertise what they
// have; the bar polls, matches by topic, and prefers a provider over its own
// built-in fallback. Nothing installs out of order and nothing breaks when
// either side is absent.
//
// IMPORTANT — this package is deliberately dependency-free apart from zod. It
// is imported by BOTH plugins' servers, and `bb plugin build` bundles each
// plugin from its own package root. Keeping the contract in one place is what
// stops the two sides drifting; the alternative (a hand-copied schema in each
// plugin) is exactly the duplication this design exists to remove.
//
// VERSIONING
//
// Method names carry a version segment (`section.v1.snapshot`, `bar.v1.describe`).
// A future v2 adds methods alongside v1 rather than changing them, so an old
// provider keeps working against a new bar. BB's own guidance for discoverable
// RPC recommends exactly this: there is no negotiation, so versions are
// additive.

import { z } from "zod";

/** Stable id for the Statusbar plugin: the `pluginId` providers call. */
export const STATUSBAR_PLUGIN_ID = "statusbar";

/**
 * The RPC method a provider publishes so the bar can find it.
 *
 * Registered with `experimental_discoverable: true`. The bar calls it on every
 * discovery tick and matches on `topic`.
 */
export const SECTION_METHOD_SNAPSHOT = "section.v1.snapshot";

/**
 * The RPC method a provider may publish to describe itself without producing a
 * reading. Optional: a provider that only implements `section.v1.snapshot` is
 * still discovered, because discovery lists methods and the bar treats a
 * `section.v1.snapshot` registration as the advertisement.
 */
export const SECTION_METHOD_DESCRIBE = "section.v1.describe";

/** The method the bar itself publishes, so providers can self-locate. */
export const BAR_METHOD_DESCRIBE = "bar.v1.describe";

/** How often the bar re-runs discovery. */
export const DISCOVERY_INTERVAL_MS = 10_000;

/**
 * Which slot a section occupies in the bar.
 *
 * This is the *identity* of a section, not a display name: the bar renders at
 * most one provider per topic, and a provider for topic `lanes` replaces the
 * bar's built-in lanes reading. Ordering in the bar is owned by the bar, not
 * by providers, so a provider cannot push itself to the front.
 */
export const sectionTopicSchema = z.enum(["usage", "lanes", "host", "spotify"]);
export type SectionTopic = z.infer<typeof sectionTopicSchema>;

/**
 * The order topics appear in the bar, left to right.
 *
 * Providers cannot influence this. It lives here rather than inside the bar's
 * server so a provider author can read the intended layout from the contract.
 */
export const SECTION_TOPIC_ORDER: readonly SectionTopic[] = [
  "usage",
  "lanes",
  "host",
  "spotify",
];

/**
 * How a section wants to be rendered.
 *
 * Providers return *data*, not React. A provider cannot ship UI into the bar:
 * that would make the bar's layout hostage to arbitrary plugin code, and the
 * bar's whole value is that it looks the same whatever is contributing.
 *
 * The bar therefore renders a small set of known shapes, and a provider picks
 * one and fills in the fields. `metrics` is the general-purpose shape: a short
 * glanceable row of labelled numbers, which is what every current section is.
 */
export const sectionPresentationSchema = z.enum([
  /** A row of labelled metrics, e.g. `CPU 34%  MEM 51%`. */
  "metrics",
  /** A single headline value with an optional caption, e.g. `$0.39 today`. */
  "headline",
  /** Free text only, e.g. `♪ Artist — Track`. */
  "text",
]);
export type SectionPresentation = z.infer<typeof sectionPresentationSchema>;

/** Severity of one number, mirroring the bar's own tone vocabulary. */
export const sectionToneSchema = z.enum(["neutral", "attention", "critical"]);
export type SectionTone = z.infer<typeof sectionToneSchema>;

/**
 * One labelled reading inside a `metrics` or `headline` section.
 *
 * `value` is a preformatted string, not a number. Formatting rules (currency
 * symbols, percent precision, unit suffixes) are presentation decisions the
 * provider is better placed to make than the bar, and sending a string avoids
 * the bar having to guess a provider's units from a bare float.
 */
export const sectionMetricSchema = z
  .object({
    /** Short uppercase label, e.g. `CPU`. Kept short: the bar is 24px tall. */
    label: z.string(),
    value: z.string(),
    tone: sectionToneSchema.default("neutral"),
    /**
     * Extra context. Rendered inline when the section is not compact, and as a
     * hover title always — the old per-section components showed their detail
     * inline, so this must stay visible rather than living in a tooltip alone.
     */
    detail: z.string().nullable().default(null),
    /**
     * Drop this metric first on a narrow window.
     *
     * `primary` metrics always render; `secondary` ones are dropped in compact
     * mode. The bar owns the decision but the provider knows which of its
     * numbers are load-bearing: DISK and load matter less than CPU and memory.
     */
    importance: z.enum(["primary", "secondary"]).default("primary"),
  })
  .strict();
export type SectionMetric = z.infer<typeof sectionMetricSchema>;

/**
 * A metric as a provider writes it: the schema's `.default()` fields are
 * optional on input and filled in when the payload is parsed.
 */
export type SectionMetricInput = z.input<typeof sectionMetricSchema>;

/** Transport controls a provider may ask the bar to render. */
export const sectionActionSchema = z
  .object({
    id: z.string(),
    /** Accessible name and hover hint for the button. */
    label: z.string(),
    /** A single glyph; the bar renders it in a 16px box. */
    glyph: z.string(),
    /** Disabled controls are rendered but not clickable. */
    enabled: z.boolean().default(true),
  })
  .strict();
export type SectionAction = z.infer<typeof sectionActionSchema>;
/** An action as a provider writes it; `enabled` defaults to true. */
export type SectionActionInput = z.input<typeof sectionActionSchema>;

/**
 * A section reading.
 *
 * Every section is independently degradable, exactly as in the original
 * single-plugin design: `status` travels with the data so one failing provider
 * renders a short muted label instead of blanking the bar.
 */
export const sectionPayloadSchema = z
  .object({
    topic: sectionTopicSchema,
    status: z.enum(["ok", "idle", "unavailable", "error"]),
    presentation: sectionPresentationSchema,
    /** Used by `metrics`. */
    metrics: z.array(sectionMetricSchema).default([]),
    /** Used by `headline`. */
    headline: z.string().nullable().default(null),
    /** Used by `text`. */
    text: z.string().nullable().default(null),
    /** Rendered as transport buttons next to the section. */
    actions: z.array(sectionActionSchema).default([]),
    /** Muted explanation shown when `status` is not `ok`, and inline context otherwise. */
    detail: z.string().nullable().default(null),
  })
  .strict()
  .refine(
    // An `ok` section with nothing visible in it would render as an empty gap:
    // the bar would look broken rather than degraded. Refusing it at the schema
    // means the bar falls back to its built-in instead of blanking the topic.
    (section) =>
      section.status !== "ok" ||
      section.metrics.length > 0 ||
      section.headline !== null ||
      section.text !== null,
    { message: "an `ok` section must carry at least one metric, headline, or text" },
  );
export type SectionPayload = z.infer<typeof sectionPayloadSchema>;

/** What `section.v1.snapshot` returns. */
export const sectionSnapshotResponseSchema = z
  .object({
    /** When the provider produced this reading. */
    generatedAt: z.string(),
    section: sectionPayloadSchema,
  })
  .strict();
export type SectionSnapshotResponse = z.infer<typeof sectionSnapshotResponseSchema>;

/** Input for `section.v1.snapshot`: no arguments. */
export const sectionSnapshotInputSchema = z.null();

/**
 * What the bar's own `bar.v1.describe` returns.
 *
 * A provider that wants to hide itself when no bar is installed can call this
 * first. It is also the version handshake: `protocolVersions` lists the
 * `section.vN` families the installed bar understands.
 */
export const barDescribeResponseSchema = z
  .object({
    /** The bar's own plugin version, for logs and diagnostics. */
    version: z.string(),
    protocolVersions: z.array(z.string()),
    topics: z.array(sectionTopicSchema),
  })
  .strict();
export type BarDescribeResponse = z.infer<typeof barDescribeResponseSchema>;

/** The `section.vN` families this build of the protocol understands. */
export const SUPPORTED_PROTOCOL_VERSIONS: readonly string[] = ["v1"];

/**
 * A provider action routed back to the plugin that owns the section.
 *
 * The bar does not know what `next` means for Spotify; it only knows a button
 * was pressed. Clicking one calls the owning provider's `section.v1.action`
 * method, so all knowledge of the action stays with the provider.
 */
export const SECTION_METHOD_ACTION = "section.v1.action";

export const sectionActionRequestSchema = z
  .object({
    topic: sectionTopicSchema,
    actionId: z.string(),
  })
  .strict();
export type SectionActionRequest = z.infer<typeof sectionActionRequestSchema>;

export const sectionActionResponseSchema = z
  .object({
    /** Shown as a toast. Providers may report a soft refusal here. */
    message: z.string(),
  })
  .strict();
export type SectionActionResponse = z.infer<typeof sectionActionResponseSchema>;

/**
 * Build an `ok` metrics section. Keeps provider code to one call.
 *
 * Parsed through the schema so the `.default()` fields (`tone`, `detail`,
 * `importance`, `enabled`) are actually filled in, rather than the caller
 * having to repeat them at every call site.
 */
export function metricsSection(args: {
  topic: SectionTopic;
  metrics: SectionMetricInput[];
  actions?: SectionActionInput[];
  detail?: string | null;
}): SectionPayload {
  return sectionPayloadSchema.parse({
    topic: args.topic,
    status: "ok",
    presentation: "metrics",
    metrics: args.metrics,
    actions: args.actions ?? [],
    detail: args.detail ?? null,
  });
}

/** Build a degraded section: a short muted label, never a blank bar. */
export function unavailableSection(args: {
  topic: SectionTopic;
  status?: "idle" | "unavailable" | "error";
  detail: string;
  presentation?: SectionPresentation;
}): SectionPayload {
  return sectionPayloadSchema.parse({
    topic: args.topic,
    status: args.status ?? "unavailable",
    presentation: args.presentation ?? "text",
    detail: args.detail,
  });
}
