// bb-plugin-statusbar — the bar itself.
//
// RESPONSIBILITIES
//
// This plugin owns exactly two things:
//
//   1. The bar's chrome, layout, compaction, and reserved space (in app.tsx).
//   2. A registry of section providers, discovered over plugin-to-plugin RPC.
//
// It owns NO SECTION DATA. Every reading in the bar is produced by a provider
// plugin; this file decides where each one sits and how it degrades. Screen real
// estate, ordering, and tone vocabulary are owned here; the numbers are not.
//
// HOW IT GOT HERE
//
// 0.1 computed every section itself, because BB then had no cross-plugin data
// channel. It does now, so each section moved to the plugin that already owned
// its data and credentials:
//
//   usage    -> the usage provider plugin
//   lanes    -> the lanes provider plugin
//   spotify  -> bb-statusbar-spotify
//   host     -> the host provider plugin
//
// Every one of those removals had the same motivation: a copy of another
// plugin's logic inside the bar drifts from its original, and the bar's job is
// to render sections, not to own them.
//
// NO FALLBACKS
//
// There is deliberately no built-in reader for any topic. A topic with no
// provider simply does not render: the bar shortens rather than inventing a
// placeholder for data nobody supplied. The practical consequence is that the
// bar is exactly as complete as the providers installed, and uninstalling a
// provider removes its section. That is intended, not a fault.
//
// Whether a topic is *known* is separate from whether it is *supplied*: a topic
// listed in the protocol's BUILTIN_TOPICS keeps its declared position in the
// row even while unprovided, and `snapshot` reports it in `sources` with a null
// pluginId so an unsupplied topic is distinguishable from an unknown one.

import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import {
  BAR_METHOD_DESCRIBE,
  SECTION_METHOD_ACTION,
  SECTION_METHOD_SNAPSHOT,
  SECTION_TOPIC_ORDER,
  orderTopics,
  sectionTopicSchema,
  barDescribeResponseSchema,
  sectionActionRequestSchema,
  sectionActionResponseSchema,
  sectionPayloadSchema,
  sectionSnapshotInputSchema,
  sectionSnapshotResponseSchema,
  type SectionPayload,
  type SectionTopic,
} from "@robcopeland/bb-statusbar-section-protocol";
import { createProviderRegistry } from "./providers.js";

export const PLUGIN_VERSION = "0.2.0";

// ---------------------------------------------------------------------------
// Wire schemas
// ---------------------------------------------------------------------------

/**
 * The bar's answer to its own frontend.
 *
 * The shape is unchanged from 0.1 apart from sections now being provider
 * payloads. `sources` says where each section came from, which is what makes
 * the split debuggable: `bb plugin rpc call statusbar snapshot` shows at a
 * glance whether a reading came from a provider or from the fallback.
 */
const snapshotSchema = z
  .object({
    generatedAt: z.string(),
    sections: z.array(sectionPayloadSchema),
    /**
     * Per-topic provenance, one entry per topic the bar considered.
     *
     * `pluginId: null` means nothing supplied that topic on this read. It is
     * kept distinct from a missing entry so a topic that is known but currently
     * unsupplied is visible rather than looking like the bar never knew it.
     */
    sources: z.array(
      z
        .object({
          topic: sectionTopicSchema,
          /**
           * Always "provider" now that every section belongs to a plugin. The
           * field is kept because it names the axis of provenance; a future
           * non-plugin source (a built-in that returns, a local file) would be
           * a new variant rather than a new field.
           */
          kind: z.literal("provider"),
          /** The plugin supplying it, or null when nothing does. */
          pluginId: z.string().nullable(),
        })
        .strict(),
    ),
  })
  .strict();

export type Snapshot = z.infer<typeof snapshotSchema>;
export type SectionSource = z.infer<typeof snapshotSchema>["sources"][number];

export const rpcContract = defineRpcContract({
  snapshot: { input: z.null(), output: snapshotSchema },
  /**
   * Routes a section's transport control back to the plugin that owns it.
   *
   * The bar knows only that a button was pressed; the provider knows what
   * `next` means. Every action belongs to a provider, so the bar only routes.
   */
  section_action: {
    input: sectionActionRequestSchema,
    output: sectionActionResponseSchema,
  },
  /** Advertises the bar so providers can detect that it is installed. */
  describe: {
    input: z.null(),
    output: barDescribeResponseSchema,
    experimental_description: "Which sections the statusbar renders and which protocol versions it understands.",
  },
  /** Diagnostics: the provider list as currently discovered. */
  providers: {
    input: z.null(),
    output: z.array(
      z.object({ pluginId: z.string(), displayName: z.string(), topic: z.string() }).strict(),
    ),
    experimental_description: "Section providers the statusbar has discovered, and the topic each one supplies.",
  },
});

// ---------------------------------------------------------------------------
// Plugin entry
// ---------------------------------------------------------------------------

export default async function plugin(bb: BbPluginApi) {
  const registry = createProviderRegistry(bb);

  /**
   * Reads one topic from its provider plugin.
   *
   * There is NO fallback. Every section belongs to a plugin, so a topic whose
   * provider is absent, disabled, or failing simply produces no section: the
   * bar shortens rather than inventing a reading for data nobody supplied.
   *
   * A failure is still reported in `sources` with the provider's id, so
   * `snapshot` never reads as though no provider was ever found for the topic.
   */
  async function readTopic(
    topic: SectionTopic,
  ): Promise<{ payload: SectionPayload | null; source: SectionSource }> {
    const discovered = registry.get(topic);

    // The bar knows this topic - it is in BUILTIN_TOPICS, so it has a declared
    // position in the row - but nothing is supplying it right now.
    if (discovered === null) {
      return { payload: null, source: { topic, kind: "provider", pluginId: null } };
    }

    try {
      const response = await registry.resolve(discovered).snapshot();
      // A provider that answers with a different topic than the one it was
      // discovered under would render its data into the wrong slot. Refuse it
      // rather than trusting the payload.
      if (response.section.topic !== topic) {
        bb.log.warn(
          `provider ${discovered.pluginId} was discovered for "${topic}" but returned "${response.section.topic}"; ignoring it`,
        );
        return { payload: null, source: { topic, kind: "provider", pluginId: discovered.pluginId } };
      }
      return {
        payload: response.section,
        source: { topic, kind: "provider", pluginId: discovered.pluginId },
      };
    } catch (error) {
      bb.log.warn(
        `provider ${discovered.pluginId} failed the "${topic}" section: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      // Not a silent drop: the provider id is recorded so a failed section is
      // distinguishable from a topic nobody supplies.
      return { payload: null, source: { topic, kind: "provider", pluginId: discovered.pluginId } };
    }
  }

  bb.rpc.register(
    rpcContract,
    {
      snapshot: async (): Promise<Snapshot> => {
        // Kick off a background re-scan at most every DISCOVERY_INTERVAL_MS.
        // Deliberately NOT awaited: a slow or hanging provider must not delay
        // the whole bar. A newly discovered provider is picked up on the next
        // read instead.
        registry.refresh();

        // Every topic the bar knows about: its own built-ins, plus whatever
        // providers have invented. Ordered so a provider cannot take the left
        // edge, and so the layout does not reshuffle as plugins load.
        const topics = orderTopics([
          ...new Set<string>([...SECTION_TOPIC_ORDER, ...registry.list().map((p) => p.topic)]),
        ]);

        // Every topic settles independently, and each one may come from a
        // different plugin. One failing source must never blank the bar.
        const readings = await Promise.all(topics.map((topic) => readTopic(topic)));

        return {
          generatedAt: new Date().toISOString(),
          sections: readings.flatMap((reading) =>
            reading.payload === null ? [] : [reading.payload],
          ),
          sources: readings.map((reading) => reading.source),
        };
      },

      section_action: async ({ topic, actionId }) => {
        const discovered = registry.get(topic);
        if (discovered !== null) {
          // An action is never silently rerouted on failure: the user pressed a
          // button that the provider advertised, so the provider's own error is
          // the honest answer.
          return registry.resolve(discovered).action(actionId);
        }
        // There are no built-in controls. Every action the bar renders belongs
        // to a provider, so reaching here means the click outlived the provider
        // that advertised it (a disabled or reloaded plugin).
        throw new Error(`No provider is supplying the "${topic}" section, so "${actionId}" cannot be run.`);
      },

      describe: () =>
        barDescribeResponseSchema.parse({
          version: PLUGIN_VERSION,
          protocolVersions: ["v1"],
          // The topics the bar renders right now: its built-ins, plus anything
          // a loaded provider has contributed. A provider can use this to see
          // whether a bar is present and what it is showing.
          topics: orderTopics([
            ...new Set<string>([
              ...SECTION_TOPIC_ORDER,
              ...registry.list().map((provider) => provider.topic),
            ]),
          ]),
        }),

      providers: () =>
        registry.list().map((provider) => ({
          pluginId: provider.pluginId,
          displayName: provider.displayName,
          topic: String(provider.topic),
        })),
    },
    {
      // The bar advertises itself so provider plugins can confirm it is
      // installed, and so `bb plugin rpc list` explains the surface.
      experimental_discoverable: true,
      experimental_description:
        "The statusbar's sections. Providers publish section.v1.snapshot and are preferred over the bar's built-ins.",
    },
  );

  bb.log.info(`ready (statusbar ${PLUGIN_VERSION}, ${SECTION_TOPIC_ORDER.length} topics)`);

  return () => {
    // Nothing long-lived to dispose: caches are in-memory, discovery is a
    // timer-free interval check, and every fetch is bounded by a timeout.
    bb.log.info("disposed");
  };
}

// Re-exported so the frontend imports its types from one place, exactly as in
// 0.1: `import type { Snapshot } from "./server"`.
export {
  BAR_METHOD_DESCRIBE,
  SECTION_METHOD_ACTION,
  SECTION_METHOD_SNAPSHOT,
  sectionSnapshotInputSchema,
  sectionSnapshotResponseSchema,
};
