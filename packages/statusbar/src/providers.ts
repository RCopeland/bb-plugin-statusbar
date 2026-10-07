// Provider discovery for the statusbar.
//
// The bar renders one section per topic. A topic reads from, in order of
// preference:
//
//   1. a loaded provider plugin that advertises that topic, or
//   2. the bar's own built-in reader (see ./builtins.ts).
//
// There is no manifest dependency between the bar and a provider. The bar
// discovers providers by asking the host which plugins publish the section
// protocol's methods, then calls the matching one. A provider that is absent,
// disabled, slow, or throwing simply loses to the built-in: the bar never goes
// blank because a neighbour is missing.
//
// VERIFIED CONSTRAINT (bb 0.44.0 / SDK 0.5.29)
//
// Discovery and cross-plugin calls are only available from a handler, service,
// or timer — never from the plugin factory, because `bb.sdk` does not exist
// until the server is listening. So discovery runs on a timer and its result is
// cached; nothing here is called during registration.
//
// The installed host bundles SDK 0.5.29, which does NOT pass an rpc handler
// context. Caller identity (`experimental_caller`) arrived in SDK 0.6.3. This
// module therefore never assumes it can tell which plugin called it. That is
// fine for contributions (a section is not a privilege), but it is why the bar
// does not try to authenticate providers.

import { z } from "zod";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import {
  DISCOVERY_INTERVAL_MS,
  SECTION_METHOD_ACTION,
  SECTION_METHOD_SNAPSHOT,
  sectionActionResponseSchema,
  sectionSnapshotResponseSchema,
  type SectionTopic,
} from "@robcopeland/bb-statusbar-section-protocol";

/** One plugin that advertises a section, as the host reports it. */
export interface DiscoveredProvider {
  pluginId: string;
  displayName: string;
  /** Topic the provider claims. */
  topic: SectionTopic;
}

/**
 * The provider surface the bar resolves per topic.
 *
 * `pluginId` is carried so actions route back to the plugin that owns the
 * section, rather than to the bar.
 */
export interface ResolvedProvider {
  pluginId: string;
  displayName: string;
  snapshot(): Promise<z.infer<typeof sectionSnapshotResponseSchema>>;
  action(actionId: string): Promise<z.infer<typeof sectionActionResponseSchema>>;
}

/**
 * Reads the topic out of a published schema, without trusting it.
 *
 * Discovery publishes JSON Schema, not a value, so the topic has to come from
 * the method's own input schema. Rather than parse the published schema (whose
 * shape is an implementation detail of the SDK's schema export), the bar asks
 * each candidate directly and reads the topic off its response. Discovery is
 * therefore only a *candidate list*; the authoritative topic comes from a
 * validated `section.v1.snapshot` call.
 */
function isSectionSnapshotMethod(method: string): boolean {
  return method === SECTION_METHOD_SNAPSHOT;
}

/**
 * Tracks which plugins currently advertise a section.
 *
 * Discovery is deliberately slow (10s): it is a scan over loaded plugins, and
 * the failure mode of a stale list is a provider arriving or leaving a few
 * seconds late, which nobody notices on a 24px bar. Section readings themselves
 * are fetched on the bar's own faster poll.
 */
export function createProviderRegistry(bb: BbPluginApi) {
  let providers: DiscoveredProvider[] = [];
  let lastScanAt = 0;
  let scanning = false;

  /**
   * Candidate plugin ids that publish `section.v1.snapshot`.
   *
   * A failure here is not fatal: an unreadable discovery list means "no
   * providers", and every topic falls back to its built-in reader.
   */
  async function scan(): Promise<DiscoveredProvider[]> {
    const published = await bb.sdk.plugins.experimental_discoverRpc();
    const candidates = published.filter((entry) => isSectionSnapshotMethod(entry.method));

    // Ask each candidate for a reading to learn its topic. A candidate that
    // fails here is dropped for this scan rather than listed and then failing
    // on every poll afterwards.
    const resolved = await Promise.all(
      candidates.map(async (entry): Promise<DiscoveredProvider | null> => {
        try {
          const response = await callSnapshot(entry.pluginId);
          return {
            pluginId: entry.pluginId,
            displayName: entry.displayName,
            topic: response.section.topic,
          };
        } catch (error) {
          bb.log.warn(
            `provider ${entry.pluginId} advertises ${SECTION_METHOD_SNAPSHOT} but did not answer: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
          return null;
        }
      }),
    );

    // Last one wins if two plugins claim a topic. This is arbitrary but stable
    // within a scan; the alternative (failing the whole bar) is worse, and the
    // collision is logged so it can be seen.
    const byTopic = new Map<SectionTopic, DiscoveredProvider>();
    for (const provider of resolved) {
      if (provider === null) continue;
      const existing = byTopic.get(provider.topic);
      if (existing !== undefined) {
        bb.log.warn(
          `two plugins provide the "${provider.topic}" section: ${existing.pluginId} and ${provider.pluginId}; using ${provider.pluginId}`,
        );
      }
      byTopic.set(provider.topic, provider);
    }
    return [...byTopic.values()];
  }

  /** Calls a provider's snapshot method with the bar's own output validation. */
  async function callSnapshot(pluginId: string): Promise<z.infer<typeof sectionSnapshotResponseSchema>> {
    return bb.sdk.plugins.callRpc({
      pluginId,
      method: SECTION_METHOD_SNAPSHOT,
      input: null,
      outputSchema: sectionSnapshotResponseSchema,
    });
  }

  return {
    /**
     * Refreshes the provider list if the discovery interval has lapsed.
     *
     * Never throws, and NEVER blocks a read. The scan is kicked off in the
     * background and its result is used from the next call onwards: awaiting it
     * here would let one slow or hanging provider delay the entire bar, which
     * is exactly the failure mode the built-in fallbacks exist to avoid.
     */
    refresh(now: number = Date.now()): void {
      if (scanning) return;
      if (now - lastScanAt < DISCOVERY_INTERVAL_MS) return;
      scanning = true;
      // Claim the window immediately so a slow scan is not restarted on every
      // poll tick while it is still in flight.
      lastScanAt = now;
      void scan()
        .then((next) => {
          providers = next;
        })
        .catch((error: unknown) => {
          bb.log.warn(
            `section discovery failed: ${error instanceof Error ? error.message : String(error)}`,
          );
        })
        .finally(() => {
          scanning = false;
        });
    },

    /** The provider for a topic, or null so the caller uses its built-in. */
    get(topic: SectionTopic): DiscoveredProvider | null {
      return providers.find((provider) => provider.topic === topic) ?? null;
    },

    /** Resolves a discovered provider into callable operations. */
    resolve(provider: DiscoveredProvider): ResolvedProvider {
      return {
        pluginId: provider.pluginId,
        displayName: provider.displayName,
        snapshot: () => callSnapshot(provider.pluginId),
        action: async (actionId: string) =>
          bb.sdk.plugins.callRpc({
            pluginId: provider.pluginId,
            method: SECTION_METHOD_ACTION,
            input: { topic: provider.topic, actionId },
            outputSchema: sectionActionResponseSchema,
          }),
      };
    },

    /** For diagnostics: the current provider list. */
    list(): DiscoveredProvider[] {
      return [...providers];
    },
  };
}
