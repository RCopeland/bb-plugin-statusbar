// bb-plugin-statusbar — the bar itself.
//
// RESPONSIBILITIES
//
// This plugin owns exactly three things:
//
//   1. The bar's chrome, layout, compaction, and reserved space (in app.tsx).
//   2. A registry of section providers, discovered over plugin-to-plugin RPC.
//   3. A built-in reader per topic, so the bar works with nothing installed.
//
// It does NOT own the meaning of any section. A section's numbers are produced
// either by a provider plugin (preferred) or by a fallback reader here. Screen
// real estate, ordering, and tone vocabulary are owned here; the data is not.
//
// WHAT CHANGED FROM 0.1 AND WHY
//
// 0.1 computed every section itself, because BB then had no cross-plugin data
// channel. It does now, so sections can be contributed by the plugins that
// already have the data and the credentials. That is the whole point of the
// split: bb-plugin-lanes can publish its own headroom instead of this plugin
// carrying a copy of its logic that silently drifts.
//
// The fallbacks remain for the topics this plugin still computes, so installing
// it alone still produces a full bar, and disabling a provider degrades to the
// built-in rather than to a gap.
//
// SPOTIFY
//
// There is no built-in Spotify reader or control path. That section is supplied
// entirely by bb-plugin-statusbar-spotify, a separate plugin that owns its own
// Spotify credentials. The bar's built-in previously read bb-spotify's
// credentials read-only, which made the Spotify slot depend on a second plugin
// being installed and authorized; removing it means the slot has no fallback,
// so uninstalling the provider leaves it empty rather than blanking the bar.

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
import { createBuiltins } from "./builtins.js";
import type { BuiltinTopic } from "@robcopeland/bb-statusbar-section-protocol";
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
     * Per-topic provenance. A topic missing here fell back to the built-in,
     * or produced nothing at all.
     */
    sources: z.array(
      z
        .object({
          topic: sectionTopicSchema,
          kind: z.enum(["provider", "builtin"]),
          /** Provider plugin id, when `kind` is "provider". */
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
   * `next` means. When the section is served by a built-in reader, the bar
   * handles the action itself.
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
  const builtins = createBuiltins(bb);
  const registry = createProviderRegistry(bb);

  /**
   * Reads one topic, preferring a discovered provider over the built-in.
   *
   * A provider that fails is not retried on this call: the built-in answers
   * instead and the failure is logged. That keeps a broken provider from
   * blanking a section it never previously supplied.
   *
   * A topic with no built-in reader (one a provider invented) has nothing to
   * fall back to, so a failing provider there produces no section at all
   * rather than an error placeholder: the bar simply loses a section nobody
   * promised it would have.
   */
  async function readTopic(
    topic: SectionTopic,
  ): Promise<{ payload: SectionPayload | null; source: SectionSource }> {
    const discovered = registry.get(topic);
    const builtin = builtinReader(topic);

    if (discovered !== null) {
      try {
        const response = await registry.resolve(discovered).snapshot();
        // A provider that answers with a different topic than the one it was
        // discovered under would render its data into the wrong slot. Refuse it
        // rather than trusting the payload.
        if (response.section.topic !== topic) {
          bb.log.warn(
            `provider ${discovered.pluginId} was discovered for "${topic}" but returned "${response.section.topic}"; ignoring it`,
          );
        } else {
          return {
            payload: response.section,
            source: { topic, kind: "provider", pluginId: discovered.pluginId },
          };
        }
      } catch (error) {
        bb.log.warn(
          `provider ${discovered.pluginId} failed the "${topic}" section${
            builtin === null ? "" : ", falling back to the built-in"
          }: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    if (builtin === null) {
      // No built-in to fall back to. Report the provider that was present (and
      // failed) rather than a bare null, so `snapshot` does not read as though
      // no provider was ever found for this topic.
      return {
        payload: null,
        source: { topic, kind: "provider", pluginId: discovered?.pluginId ?? null },
      };
    }
    return {
      payload: await builtin(),
      source: { topic, kind: "builtin", pluginId: null },
    };
  }

  /**
   * The built-in reader for a topic, or null when the bar ships none.
   *
   * Topics are open, so a provider-invented topic legitimately finds nothing
   * here. Readers are a separate map from the bar's other handles precisely so
   * a name collision cannot hand back something that is not a reader.
   */
  function builtinReader(topic: SectionTopic): (() => Promise<SectionPayload>) | null {
    return builtins.readers[topic] ?? null;
  }

  /**
   * Runs a built-in transport action.
   *
   * There are none any more. This existed for the Spotify section, which had
   * built-in controls because the bar computed that reading itself; the topic
   * is now supplied entirely by bb-plugin-statusbar-spotify, which owns its own
   * action handler. Kept as an explicit refusal rather than deleted, so a topic
   * reaching here is a visible error instead of a silently ignored click.
   */
  async function runBuiltinAction(topic: SectionTopic, actionId: string): Promise<{ message: string }> {
    throw new Error(`No built-in action "${actionId}" for the "${topic}" section.`);
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
