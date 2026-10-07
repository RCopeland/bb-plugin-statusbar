// bb-plugin-statusbar-section-clock — the reference section provider.
//
// This plugin is an EXAMPLE, and it is deliberately the smallest thing that
// demonstrates the protocol end to end. It reads nothing but the system clock:
//
//   - no other plugin's data
//   - no credentials, files, or network
//   - no SDK calls
//
// A real provider (lane headroom, Spotify, host resources) has to explain where
// its numbers come from; this one has nothing to explain, so what remains is
// purely the shape of a contribution. Read this file top to bottom and you have
// seen the whole protocol.
//
// It also contributes a topic the bar has never heard of (`clock`), which is the
// point: sections are open. The bar does not need a release to render this.
//
// WHAT THE BAR OWES YOU, AND WHAT YOU OWE THE BAR
//
//   You owe it:  one discoverable RPC method returning a valid section payload.
//   It owes you: a slot in the row, and correct degradation if you fail.
//
// There is nothing to register with the bar, no dependency to declare, and no
// order to install in. If a bar is installed and running, it finds this. If not,
// nothing ever calls this code and it costs nothing.

import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import {
  SECTION_METHOD_ACTION,
  SECTION_METHOD_SNAPSHOT,
  sectionActionRequestSchema,
  sectionActionResponseSchema,
  sectionSnapshotResponseSchema,
  textSection,
} from "@rcopeland/bb-statusbar-section-protocol";

/**
 * The topic this provider claims.
 *
 * `clock` is not one of the bar's built-in topics, and that is fine — topics
 * are open. Any well-formed lowercase name works. Claiming a built-in topic
 * (`usage`, `lanes`, `host`, `spotify`) would instead REPLACE that section,
 * which is how a provider takes over a reading the bar would otherwise compute
 * itself.
 */
const TOPIC = "clock";

export const rpcContract = defineRpcContract({
  [SECTION_METHOD_SNAPSHOT]: {
    input: z.null(),
    output: sectionSnapshotResponseSchema,
    experimental_description: "The current time and date, as a statusbar section.",
  },
  /**
   * The bar routes a click on one of this section's controls back here, so the
   * provider keeps all knowledge of what its own actions mean.
   *
   * This section advertises no actions, so this exists only to satisfy the
   * contract. See the README for a worked example with real controls.
   */
  [SECTION_METHOD_ACTION]: {
    input: sectionActionRequestSchema,
    output: sectionActionResponseSchema,
  },
});

/** `14:32` in the server's local time. */
function clockTime(now: Date): string {
  return [
    String(now.getHours()).padStart(2, "0"),
    String(now.getMinutes()).padStart(2, "0"),
  ].join(":");
}

/** `Mon 6 Oct`, short enough to survive a narrow window. */
function clockDate(now: Date): string {
  return now.toLocaleDateString(undefined, {
    weekday: "short",
    day: "numeric",
    month: "short",
  });
}

export default async function plugin(bb: BbPluginApi) {
  bb.rpc.register(
    rpcContract,
    {
      [SECTION_METHOD_SNAPSHOT]: async () => {
        const now = new Date();
        return {
          generatedAt: now.toISOString(),
          section: textSection({
            topic: TOPIC,
            // `14:32 Mon 6 Oct`. The bar renders this verbatim, so the provider
            // owns its own formatting rather than sending a number for the bar
            // to guess at.
            text: `${clockTime(now)} ${clockDate(now)}`,
            // A clock is the least load-bearing thing in the bar, so it yields
            // its slot first when the window is narrow. Marking it here means
            // the bar does not need a hardcoded rule about clocks.
            importance: "secondary",
          }),
        };
      },

      [SECTION_METHOD_ACTION]: ({ actionId }) => {
        // Reachable only if the section advertises actions, which it does not.
        // Returning a clear error beats pretending the click worked.
        throw new Error(`The clock section has no "${actionId}" action.`);
      },
    },
    {
      // THE ONE LINE THAT MAKES THIS A PROVIDER. Without it the method is still
      // callable by id, but the bar cannot find it by asking the host which
      // plugins publish section methods.
      experimental_discoverable: true,
      experimental_description: "A clock section for the Statusbar plugin.",
    },
  );

  bb.log.info(`ready (clock provider; claims topic "${TOPIC}")`);
}
