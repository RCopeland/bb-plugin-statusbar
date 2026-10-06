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
// The fallbacks remain, so installing this plugin alone still produces a full
// bar, and disabling a provider degrades to the built-in rather than to a gap.
//
// SPOTIFY CREDENTIALS
//
// The built-in Spotify reader still reads bb-spotify's credentials read-only
// (clientId from plugin_settings, clientSecret/refreshToken from its 0600
// secret files) rather than duplicating them: two independent refresh flows
// would race on token rotation. Credential values stay server-side and are
// never returned over RPC. The preferred path is for bb-spotify to publish the
// section itself, at which point this reader becomes the offline fallback.

import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import {
  BAR_METHOD_DESCRIBE,
  SECTION_METHOD_ACTION,
  SECTION_METHOD_SNAPSHOT,
  SECTION_TOPIC_ORDER,
  barDescribeResponseSchema,
  sectionActionRequestSchema,
  sectionActionResponseSchema,
  sectionPayloadSchema,
  sectionSnapshotInputSchema,
  sectionSnapshotResponseSchema,
  type SectionPayload,
  type SectionTopic,
} from "bb-statusbar-section-protocol";
import { createBuiltins, spotifyDefaultDeviceId, spotifyDisruptiveActionsAllowed } from "./builtins.js";
import { createProviderRegistry } from "./providers.js";
import { controlSpotify, likeSpotifyTrack } from "./spotify-controls.js";

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
          topic: z.enum(["usage", "lanes", "host", "spotify"]),
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
   */
  async function readTopic(
    topic: SectionTopic,
  ): Promise<{ payload: SectionPayload | null; source: SectionSource }> {
    const discovered = registry.get(topic);
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
          `provider ${discovered.pluginId} failed the "${topic}" section, falling back to the built-in: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
    return {
      payload: await builtins[topic](),
      source: { topic, kind: "builtin", pluginId: null },
    };
  }

  /**
   * Runs a built-in transport action.
   *
   * Only the Spotify section has built-in controls; every other action id is a
   * programming error rather than a user-visible failure.
   */
  async function runBuiltinAction(topic: SectionTopic, actionId: string): Promise<{ message: string }> {
    if (topic !== "spotify") {
      throw new Error(`No built-in action "${actionId}" for the "${topic}" section.`);
    }

    if (actionId === "like") {
      const message = await likeSpotifyTrack({
        token: builtins.spotifyToken,
        invalidate: builtins.invalidateSpotify,
      });
      return { message };
    }

    if (!["pause", "play", "next", "previous"].includes(actionId)) {
      throw new Error(`Unknown Spotify action "${actionId}".`);
    }

    if (actionId === "play" && !spotifyDisruptiveActionsAllowed()) {
      // Starting playback is the disruptive case: bb-spotify gates it behind an
      // explicit opt-in, so honor the same setting rather than overriding it.
      throw new Error(
        'Starting playback is disabled. Enable "Allow agents to start/resume playback" in the Spotify plugin settings, or use the Spotify plugin\'s own controls.',
      );
    }

    const message = await controlSpotify({
      action: actionId as "pause" | "play" | "next" | "previous",
      token: builtins.spotifyToken,
      invalidate: builtins.invalidateSpotify,
      deviceId: spotifyDefaultDeviceId(),
    });
    return { message };
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

        // Every topic settles independently, and each one may come from a
        // different plugin. One failing source must never blank the bar.
        const readings = await Promise.all(SECTION_TOPIC_ORDER.map((topic) => readTopic(topic)));

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
          // Unlike a read, an action is not silently rerouted to the built-in on
          // failure: the user pressed a button that the provider advertised, so
          // the provider's own error is the honest answer. Rerouting a Spotify
          // click to a different plugin's control path would be worse than
          // reporting the failure.
          return registry.resolve(discovered).action(actionId);
        }
        return runBuiltinAction(topic, actionId);
      },

      describe: () =>
        barDescribeResponseSchema.parse({
          version: PLUGIN_VERSION,
          protocolVersions: ["v1"],
          topics: [...SECTION_TOPIC_ORDER],
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
