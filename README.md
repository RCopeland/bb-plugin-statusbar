# bb-plugin-statusbar

One status bar pinned to the bottom of the BB window:

```
$0.39 today $2.21 MTD │ OpenRouter 74% │ CPU 34% MEM 51% DISK 9% load 0.84 │ ▶ Artist — Track  ⏮ ❚❚ ⏭ ♥
```

The bar owns its chrome, layout, ordering, and tone vocabulary. It does **not**
own the meaning of any section: a section's numbers are produced either by a
provider plugin or by a built-in fallback reader.

## Layout

```
packages/
  section-protocol/   the wire contract shared by the bar and its providers
  statusbar/          the bar: overlay, layout, registry, built-in fallbacks
  section-lanes/      example provider: contributes the `lanes` section
```

Each package is a separately installable BB plugin (except
`section-protocol`, which is a private workspace package compiled into both).

## Why sections are separate plugins

Sections used to be computed inside this plugin, because BB had no cross-plugin
data channel. It does now — plugin-to-plugin RPC (`bb.sdk.plugins.callRpc`, plus
`experimental_discoverRpc` for discovery) — so a section can be published by the
plugin that already owns its data and credentials, instead of the bar carrying a
copy that silently drifts.

That is the whole point of the split. `bb-plugin-lanes` knows how to read lane
headroom; the bar should not re-derive it.

## How contribution works

There is **no dependency mechanism** in BB: no `dependsOn`, no load ordering, no
way for one plugin to require another. So a section plugin cannot "require" the
statusbar, and it does not try to. Contribution is pull-based:

1. The bar calls `bb.sdk.plugins.experimental_discoverRpc()` every 10s and keeps
   the plugins that publish `section.v1.snapshot`.
2. It asks each candidate for a reading to learn which topic it supplies.
3. Per topic, a discovered provider **wins over the built-in**.

Consequences, all of them intentional:

- Nothing installs in any particular order.
- The bar works with zero providers installed.
- Disabling a provider silently returns that topic to the built-in — no gap.
- A provider that throws is logged and skipped for that topic; the section still
  renders from the built-in rather than going blank. Verified by simulating a
  provider crash.
- Two plugins claiming one topic is logged, and one wins. The bar never fails
  because of a collision.

`bb plugin rpc call statusbar snapshot` reports `sources`, so you can always tell
where a reading came from:

```json
"usage":   { "kind": "builtin",  "pluginId": null },
"lanes":   { "kind": "provider", "pluginId": "statusbar-section-lanes" }
```

## Writing a provider

Publish one discoverable method. The bar does the rest.

```ts
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import {
  SECTION_METHOD_SNAPSHOT,
  metricsSection,
  sectionSnapshotResponseSchema,
} from "bb-statusbar-section-protocol";

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
          metrics: [
            { label: "Codex", value: "18%", tone: "neutral", detail: "weekly window" },
            // `secondary` metrics drop first on a narrow window.
            { label: "OR", value: "$42", tone: "neutral", importance: "secondary" },
          ],
        }),
      }),
    },
    { experimental_discoverable: true },
  );
}
```

Rules worth knowing:

- **Return data, not UI.** A provider picks one of three presentations
  (`metrics`, `headline`, `text`) and fills in fields. Providers cannot ship
  React into the bar, and cannot choose their own position: ordering, layout, and
  colors are the bar's, so the bar looks the same whatever is contributing.
- **Preformat values.** `value` is a string, not a number, so the provider that
  knows its units owns its formatting (`$0.39`, `23%`, `2.00`).
- **Mark what can be dropped.** `importance: "secondary"` tells the bar which
  numbers to shed on a narrow window. Leave it off and the metric is treated as
  `primary`. Marking *everything* secondary is safe: the bar keeps them all
  rather than rendering a blank section.
- **Degrade locally.** A section carries its own `status`; return
  `unavailableSection({...})` rather than throwing when your source is down. An
  `ok` section with no visible metric, headline, or text is rejected and the bar
  falls back to its built-in.
- **`detail` is visible text**, not a tooltip. Use it to explain a degraded
  section or to qualify a number ("Latest data is 2026-10-05.").
- **Actions route back to you.** If your section has controls, list them in
  `actions` and implement `section.v1.action`; the bar only knows a button was
  pressed.
- **Do not check for the bar in your factory.** `bb.sdk` does not exist until the
  server is listening, and the bar may be installed or removed while you run.
  Just answer correctly when asked.

## Important constraints (verified against bb 0.44.0 / SDK 0.5.29)

These were confirmed by experiment, not by reading docs:

| Capability | Status |
| --- | --- |
| `experimental_discoverable` registration + JSON Schema publication | works |
| `bb plugin rpc list` / `inspect` / `call` | works |
| `bb.sdk.plugins.callRpc` between plugins | works |
| `experimental_discoverRpc` from a running plugin | works |
| `experimental_caller` (RPC handler context) | **not available** — needs SDK ≥ 0.6.3 |

Two things follow:

- Discovery and cross-plugin calls only work from a **handler, service, or
  timer**. `bb.sdk` does not exist during the plugin factory, which is why the
  bar discovers on a poll tick rather than at startup.
- The bar **cannot authenticate providers**. `experimental_caller` arrived in SDK
  0.6.3; this host bundles 0.5.29, where the handler context argument is
  `undefined`. That is acceptable because a section is not a privilege — anyone
  who can register a plugin is already full-trust. If you later want to restrict
  contributions, that check needs SDK 0.6.x and is not implemented.

## Sections

Each topic reads from a provider when one is present, otherwise from the built-in:

| Section | Built-in source | Caches for |
| --- | --- | --- |
| Usage | `~/.bb/plugins/usage/data.db` (read-only, `node:sqlite`) | 60s |
| Lanes | `bb.sdk.system.usageLimits()` + OpenRouter `/api/v1/credits` | 60s |
| Host | In-plugin sampling (`node:os`, `df -Pk`) | 5s |
| Spotify | Spotify Web API, using bb-spotify's credentials | 3s |

The bar polls `snapshot()` every 3 seconds. Each section is cached server-side
with its own TTL, so a tick is mostly memory reads.

### Built-in fallbacks are duplicated on purpose

The usage and lanes readers are still copies of the logic in
`bb-plugin-usage-footer` and `bb-plugin-lanes`. They exist so the bar is useful
alone and so disabling a provider degrades gracefully. If those plugins publish
their own sections, the copies stop being the live path — but they are not
deleted, because a fallback that has been removed is not a fallback.

**Known cost:** until then, a schema or provider change in those plugins does not
propagate here.

## Spotify

### Transport controls

The bar carries previous, play/pause, next, and save-to-Liked-Songs. They defer
to bb-spotify's own gating rather than inventing a second policy:

- **Play/resume requires bb-spotify's `allowDisruptiveActions` setting.** It is
  off by default. When off, the bar surfaces a toast naming the setting instead
  of failing silently. Enable it with:

  ```sh
  bb plugin config spotify set allowDisruptiveActions true
  ```

- Playback targets bb-spotify's configured `defaultDeviceId` when set.
- Pause, skip, previous, and like are never gated.
- Save-to-Liked-Songs uses `PUT /me/library`. The older `PUT /me/tracks?uris=…`
  now answers 403 Forbidden even with the `user-library-modify` scope.

These controls belong to the built-in Spotify reader. When Spotify is served by
a provider, that provider owns its own actions — the bar just renders the buttons
it advertises and routes clicks to it.

### Credentials

Spotify credentials are per-plugin (`<dataDir>/plugins/<id>/secrets/`, mode
0600). Duplicating them would mean two independent refresh flows racing on token
rotation. The built-in reader therefore reads **bb-spotify's own credentials,
read-only**:

| Input | Location |
| --- | --- |
| `clientId` (not a secret) | `bb.db` → `plugin_settings`, `plugin_id='spotify'`, `key='clientId'` |
| `clientSecret` | `~/.bb/plugins/spotify/secrets/clientSecret` |
| `refreshToken` | `~/.bb/plugins/spotify/secrets/refreshToken` |

Rules followed:

- **Read-only.** It never writes bb-spotify's files.
- **Rotation is ignored.** A rotated `refresh_token` is used for the current
  access token but not persisted; bb-spotify owns that value.
- **Values stay server-side.** No credential is logged, written to disk,
  returned over RPC, or placed in KV.
- **Fails soft.** Missing or unreadable credentials render `not connected`.

BB's install prompt states the trust model: *"Plugins are full-trust code running
inside the BB server. They can read all local BB data, including other plugins'
secrets."*

## Development

```sh
npm install                        # links the workspace packages
npm run typecheck

cd packages/statusbar
bb plugin build && bb plugin install . --yes
bb plugin reload statusbar
bb plugin rpc call statusbar snapshot --json
bb plugin rpc call statusbar providers --json   # which providers are discovered
```

Same flow in `packages/section-lanes` for the provider.

## Known limitations

- Depends on BB's secret file layout and on the plugin server having read access
  to it. If either changes, the Spotify section degrades to `not connected`.
- Built-in usage and lanes logic is duplicated and can drift from its originals.
- Providers cannot be authenticated on this BB version (see above).
- The bar is a fixed overlay. `experimental_appOverlay` supplies no chrome,
  positioning, or responsive behavior, so re-verify against the composer, the
  terminal panel, and narrow windows after BB upgrades.
- Section discovery is a 10s poll, so a provider appearing or disappearing takes
  up to that long to take effect.
