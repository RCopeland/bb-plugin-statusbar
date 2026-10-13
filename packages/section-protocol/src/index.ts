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
// fallback inside the bar. Nothing installs out of order and nothing breaks when
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
 * most one provider per topic, and a topic is a slot that exactly one plugin
 * may occupy.
 *
 * Topics are OPEN, not a closed set. A plugin may contribute a topic the bar
 * has never heard of (see the in-repo `section-clock` example), which is what
 * makes "sections are separate plugins" mean something: adding a section does
 * not require a change to the bar. The four topics below are the ones the bar
 * knows by name; they are constants rather than an enum so a provider can name
 * its own.
 *
 * Ordering is still owned by the bar, so a provider cannot push itself to the
 * front of the row.
 */
export const sectionTopicSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  // Lowercase, digits, and dashes: kept to a shape that is safe as a DOM
  // attribute value and stable in logs. No dots, since the RPC layer already
  // uses dotted method names and mixing the two is confusing.
  .regex(/^[a-z0-9-]+$/, "a topic must be lowercase letters, digits, or dashes");
export type SectionTopic = z.infer<typeof sectionTopicSchema>;

/**
 * Topics the bar knows by name and gives a fixed position in the row.
 *
 * These are LAYOUT IDENTITY, not data ownership. The bar computes no readings
 * itself - every section is supplied by a provider plugin - so this constant
 * says only which slots exist and where they sit. A topic listed here keeps its
 * declared position in `SECTION_TOPIC_ORDER` even while nothing is supplying it.
 *
 * A topic a provider invents is equally renderable; it simply sorts after these,
 * alphabetically.
 */
export const KNOWN_TOPICS = ["usage", "lanes", "host", "spotify"] as const;
export type KnownTopic = (typeof KNOWN_TOPICS)[number];

function isKnownTopic(topic: string): topic is KnownTopic {
  return (KNOWN_TOPICS as readonly string[]).includes(topic);
}

/**
 * The order topics appear in the bar, left to right.
 *
 * A PREFERENCE, not an exhaustive list: the topics here render first, in this
 * order, and any topic a provider invents renders after them — see
 * `orderTopics`. Providers cannot influence this, which is why it lives in the
 * contract rather than in the bar: a provider author can read the intended
 * layout without guessing.
 */
export const SECTION_TOPIC_ORDER: readonly KnownTopic[] = [
  "usage",
  "lanes",
  "host",
  "spotify",
];

/**
 * Sorts topics for display: known topics in their declared order, then unknown
 * ones alphabetically.
 *
 * Unknown topics go last because the leftmost slots are the most load-bearing
 * (cost, headroom). A provider that invented a topic has not earned the left
 * edge, and making the position deterministic means the bar does not reshuffle
 * as plugins are installed in a different order.
 */
export function orderTopics(topics: readonly string[]): string[] {
  return [...topics].sort((left, right) => {
    const leftKnown = isKnownTopic(left);
    const rightKnown = isKnownTopic(right);
    if (leftKnown && rightKnown) {
      return SECTION_TOPIC_ORDER.indexOf(left) - SECTION_TOPIC_ORDER.indexOf(right);
    }
    if (leftKnown) return -1;
    if (rightKnown) return 1;
    return left.localeCompare(right);
  });
}

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
    /**
     * Whether this whole section can be dropped on a narrow window.
     *
     * `primary` sections always render; `secondary` ones go first when width is
     * tight. Set by the section's provider, because the provider knows whether
     * its numbers matter more than another section's — the bar cannot know
     * that for a topic it has never heard of.
     */
    importance: z.enum(["primary", "secondary"]).default("primary"),
    /**
     * Muted explanation rendered inline when the bar is not compact.
     *
     * Used both when `status` is not `ok` (why the section is degraded) and as
     * context on an `ok` section (e.g. "Latest data is 2026-10-05.").
     */
    detail: z.string().nullable().default(null),
  })
  .strict()
  .refine(
    // An `ok` section with nothing visible in it would render as an empty gap:
    // the bar would look broken rather than degraded. Refusing it at the schema
    // means the bar falls back to its built-in instead of blanking the topic.
    //
    // NOTE: `.refine()` has no JSON Schema equivalent, so this rule is enforced
    // at runtime but absent from the schema published for `experimental_discoverRpc`.
    // A provider reading only the published schema will not see it, which is why
    // the renderer also defends against the compact-mode variant of the same
    // problem rather than relying on validation alone.
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
  importance?: "primary" | "secondary";
}): SectionPayload {
  return sectionPayloadSchema.parse({
    topic: args.topic,
    status: "ok",
    presentation: "metrics",
    metrics: args.metrics,
    actions: args.actions ?? [],
    detail: args.detail ?? null,
    importance: args.importance ?? "primary",
  });
}

/** Build an `ok` text section, e.g. a clock or a now-playing line. */
export function textSection(args: {
  topic: SectionTopic;
  text: string;
  metrics?: SectionMetricInput[];
  actions?: SectionActionInput[];
  detail?: string | null;
  importance?: "primary" | "secondary";
}): SectionPayload {
  return sectionPayloadSchema.parse({
    topic: args.topic,
    status: "ok",
    presentation: "text",
    text: args.text,
    metrics: args.metrics ?? [],
    actions: args.actions ?? [],
    detail: args.detail ?? null,
    importance: args.importance ?? "primary",
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
