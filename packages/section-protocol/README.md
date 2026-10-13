# @robcopeland/bb-statusbar-section-protocol

The wire contract between the **Statusbar** BB plugin and any plugin that
contributes a section to it.

```sh
npm install @robcopeland/bb-statusbar-section-protocol
```

## Why this is a package

BB has no plugin dependency mechanism — no `dependsOn`, no load ordering, no way
for one plugin to require another. So a section provider cannot "require" the
statusbar. What it can do is speak a shared protocol, and this package is that
protocol, published once so the bar and every provider compile against the same
thing instead of each carrying a hand-copied schema.

## Shipping TypeScript source, not compiled JavaScript

`main` and `types` both point at `src/index.ts`. That is deliberate, not an
oversight:

- `bb plugin build` bundles a plugin's TypeScript from its own entry point, so a
  package that ships `.ts` is consumed normally.
- The alternative — a build step emitting `.js` plus `.d.ts` — would mean this
  package's published output could drift from its source, and would add a
  compilation step to a package whose entire job is to define types and schemas.

If a future consumer needs compiled output, change `main`/`types` and add a
build script; nothing else here depends on shipping source.

## What's in it

| Export | Purpose |
| --- | --- |
| `sectionSnapshotResponseSchema` | The output of `section.v1.snapshot` |
| `sectionPayloadSchema` | One section reading |
| `SECTION_METHOD_SNAPSHOT` / `SECTION_METHOD_ACTION` | Method names |
| `metricsSection`, `textSection`, `unavailableSection` | Builders for a payload |
| `orderTopics` | The bar's display ordering rule |
| `KNOWN_TOPICS` / `SECTION_TOPIC_ORDER` | Topics the bar gives a fixed position in the row |

## Quick start

```ts
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import {
  SECTION_METHOD_SNAPSHOT,
  sectionSnapshotResponseSchema,
  metricsSection,
} from "@robcopeland/bb-statusbar-section-protocol";

export default async function plugin(bb: BbPluginApi) {
  bb.rpc.register(
    {
      [SECTION_METHOD_SNAPSHOT]: {
        input: z.null(),
        output: sectionSnapshotResponseSchema,
      },
    },
    {
      [SECTION_METHOD_SNAPSHOT]: async () => ({
        generatedAt: new Date().toISOString(),
        section: metricsSection({
          topic: "lanes",
          metrics: [{ label: "Codex", value: "18%", tone: "neutral" }],
        }),
      }),
    },
    { experimental_discoverable: true },
  );
}
```

The `experimental_discoverable: true` is what lets the bar find your provider.

## License

MIT
