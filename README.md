# bb-plugin-statusbar

One status bar pinned to the bottom of the BB window:

```
$0.39 today $2.21 MTD │ OpenRouter 74% │ CPU 34% MEM 51% DISK 9% load 0.84 │ ▶ Artist — Track  ⏮ ❚❚ ⏭ ♥
```

The bar owns its chrome, layout, ordering, and tone vocabulary. It does **not**
own the meaning of any section: a section's numbers are produced by a provider
plugin. The only reading the bar computes itself is `host` — this machine's CPU
and memory, which no plugin owns.

## Layout

```
packages/
  statusbar/          the bar: overlay, layout, provider registry
  section-clock/      example provider: contributes a `clock` topic
  section-protocol/   the wire contract, PUBLISHED as
                      @robcopeland/bb-statusbar-section-protocol
```

`section-protocol` lives here for development but is published to npm, so a
provider in any other repo depends on it normally rather than vendoring a copy:

```sh
npm install @robcopeland/bb-statusbar-section-protocol
```

That is what keeps the bar and its providers from drifting. It is a private
workspace package locally and a public npm package externally — the same source,
built by whichever workspace consumes it.

`statusbar` and `section-clock` are separately installable BB plugins.
`section-protocol` is a workspace package compiled into both; it is not a plugin
and is not installed on its own.

The clock example is deliberately trivial — it reads nothing but `new Date()` —
so that what remains is purely the shape of a contribution, with no data source
to explain. It also claims a topic the bar has never heard of, which is the
point: **topics are open**, so adding a section does not require a change to the
bar.

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
3. Each topic renders whatever its provider returned.
4. Topics the bar has never heard of render too, ordered after the known ones.

Consequences, all of them intentional:

- Nothing installs in any particular order.
- With no providers installed the bar renders nothing; each provider adds its
  section. It never invents a reading for data nobody supplied.
- Disabling a provider removes its section. There is no fallback to degrade to,
  so dropping a section you uninstalled is correct behavior, not a fault.
- A provider that throws is logged and skipped for that topic; its section
  disappears from that read rather than going blank mid-render. Verified by
  simulating a provider crash.
- Two plugins claiming one topic is logged, and one wins. The bar never fails
  because of a collision.
- A topic the bar has never heard of appears when a provider for it is loaded,
  and disappears when that provider goes away.

`bb plugin rpc call statusbar snapshot` reports `sources`, so you can always tell
where a reading came from:

```json
"lanes":  { "kind": "provider", "pluginId": "statusbar-lanes" }
"host":   { "kind": "provider", "pluginId": null }   <- known, nothing supplying it
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

To claim a topic the bar does not ship, just name it: `topic` accepts any
lowercase name (letters, digits, dashes). `section-clock` contributes `clock`.
Claiming a built-in topic instead (`usage`, `lanes`, `host`, `spotify`) replaces
that section rather than adding one.

Renderer helpers: `metricsSection`, `textSection`, and `unavailableSection`.

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
  rather than rendering a blank section. A section can also mark *itself*
  `importance: "secondary"`, which makes it the first to lose its whole slot —
  that is how the clock and Spotify sections yield to cost and headroom.
- **Degrade locally.** A section carries its own `status`; return
  `unavailableSection({...})` rather than throwing when your source is down, so
  the bar can show a muted explanation. An `ok` section with no visible metric,
  headline, or text is rejected as invalid, and the section does not render.
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

**Every section is supplied by a provider plugin.** The bar computes none of
them.

| Section | Supplied by |
| --- | --- |
| Usage | usage provider plugin |
| Lanes | lanes provider plugin |
| Host | host provider plugin |
| Spotify | `bb-statusbar-spotify` |

`statusbar snapshot` reports where each section came from:

```
usage   -> provider statusbar-usage
lanes   -> provider statusbar-lanes
host    -> provider statusbar-host
spotify -> provider statusbar-spotify
```

The bar polls `snapshot()` every 3 seconds. Sections are cached by the plugin
that produces them, so a tick is mostly memory reads.

### Why the bar owns no readings

Each of `usage`, `lanes`, `spotify`, and `host` was once computed here. Every one
was removed once the plugin that owns that data published a provider, for the
same reason in each case: a copy of another plugin's logic inside the bar drifts
from its original, and the bar's job is to render sections, not to own them.

**There are no fallbacks.** A topic with no provider does not render — the bar
shortens rather than inventing a placeholder for data nobody supplied. So
uninstalling a provider removes its section. That is the intended behavior, not a
fault, and it is the tradeoff for having exactly one implementation of each
reading.

Known-but-unsupplied is still distinguishable from never-heard-of: a topic listed
in the protocol's `BUILTIN_TOPICS` keeps its declared position in the row, and
`snapshot` reports it in `sources` with a null `pluginId`.

## Spotify

The Spotify section is **not built in**. It is contributed by a separate plugin,
[`bb-statusbar-spotify`](https://github.com/RCopeland/bb-statusbar-spotify),
which claims the `spotify` topic and owns its own Spotify credentials.

Installing that plugin is what puts Spotify in the bar. Without it the topic has
no reader and produces no section at all.

### Why it moved out

The bar previously shipped a built-in Spotify reader. To avoid two independent
refresh flows racing on one token, that reader borrowed bb-spotify's credentials
read-only and deliberately refused to persist a rotated refresh token. The
result was that the Spotify slot depended on a *third* plugin being installed and
authorized.

Moving the section into its own plugin fixed that: it owns its credentials, so it
can persist rotation safely. The tradeoff is that the topic now has no fallback —
uninstalling the provider leaves the slot empty rather than degrading to a
reading computed here. That is accepted deliberately; a fallback that has to
borrow another plugin's secrets is not really a fallback.

### Setup

See that plugin's README. In short: create a Spotify developer app, register its
redirect URI, set the client ID and secret, then run its auth flow.

### Why `BUILTIN_TOPICS` still lists these four

The name is historical. It used to mean "the bar ships a reader for these", but
the bar now computes no readings at all.

What the constant still means is *layout identity*: the bar knows this slot
exists and where it goes in the row. Removing an entry would reclassify that
topic as provider-invented and sort it to the right-hand end, which is not what
anyone wants. It is not a statement about data ownership.

Renaming it (`KNOWN_TOPICS` would be more honest) is not worth doing yet: it is
part of the published contract and every existing provider imports it, so the
rename is a breaking change for a cosmetic gain.

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

Same flow in `packages/section-clock` for the provider.

### Publishing the protocol

Publishing is automated by `.github/workflows/publish-protocol.yml` and uses
**staged publishing** plus **npm trusted publishing (OIDC)**. To release:

1. Bump `version` in `packages/section-protocol/package.json`.
2. Merge to `main`.
3. Review and approve the staged version with 2FA.

Step 3 is the point of staged publishing: the version does **not** go live until
a maintainer has looked at it and approved it. A compromised workflow, a bad
dependency, or a commit that slipped through review therefore produces a pending
release rather than a live one that people install.

```sh
npm stage list                 # what is waiting
npm stage view <stage-id>      # inspect it
npm stage approve <stage-id>   # 2FA prompt; this is the step that publishes
```

You can also approve from the **Staged Packages** tab on npmjs.com.

Approval cannot be automated: npm requires proof of presence, so an OIDC token is
not accepted for `npm stage approve`. That is deliberate.

The version is bumped by hand and committed, so what is on npm always corresponds
to a commit, and a version is never published that nobody chose. The workflow is
**idempotent** — if the version is already published it exits successfully, so
merging code that did not touch the version is a no-op rather than a failure. It
tags the commit `protocol-v<version>` after a successful stage.

Authentication is OIDC, so no token is stored in this repo. GitHub mints a
short-lived identity token for the job and npm exchanges it for publish rights,
which is why there is no long-lived secret to leak or rotate.

#### One-time npm setup (required)

Trusted publishing is configured once per package on npmjs.com, and it only works
if the repository and workflow filename match exactly. Renaming the workflow file
breaks publishing until the npm setting is updated — the filename is part of the
trust relationship.

**Bootstrapping a package that does not exist yet.** npm requires a package to
exist before its settings page offers a Trusted Publisher section, but
`npm stage publish` can create a new package (since npm CLI 11.15.0). Since
staging only needs a *stage-only* trusted publisher, the bootstrap path is:

1. Create the package with one local staged publish from this directory:

   ```sh
   npm install -g npm@latest    # `npm stage` needs CLI >= 11.15.0
   cd packages/section-protocol
   npm stage publish --access public
   ```

   This creates the package and leaves the first version in the staged queue.

2. The package now appears on npmjs.com. Open it and go to
   **Settings → Trusted publishing** → **GitHub Actions**:

   | Field | Value |
   | --- | --- |
   | Organization or user | `RCopeland` |
   | Repository | `bb-plugin-statusbar` |
   | Workflow filename | `publish-protocol.yml` |
   | Environment | *(leave blank)* |
   | Allowed actions | leave **Allow npm publish** UNCHECKED |

   Leaving direct publishing unchecked is what restricts the workflow to
   staging, so every release needs your 2FA approval.

3. Approve the first staged version (`npm stage approve <stage-id>`). From then
   on, merges to `main` stage automatically.

A newly created trusted publisher must complete its **first successful stage
within 2 days** or it expires and cannot be edited; you would have to delete and
recreate it. Configure it when you are ready to release, not in advance.

Trusted publisher connections cannot be edited after creation. To change one,
delete it and create a new one.

#### Why not a token

An `NPM_TOKEN` secret would work, but it is a long-lived credential that can
publish as you until revoked, and it must be rotated. OIDC tokens are minted per
run, bound to this repo and this workflow file, and expire in minutes. Combined
with staging, a leaked credential has nothing durable to steal.

Providers depend on the protocol with a normal semver range. Because the bar and
the protocol ship from the same repo, bump the protocol version whenever the
contract changes, and note it in the bar's release notes.

## Known limitations

- There are no fallbacks. Uninstalling a provider removes its section; the bar
  does not degrade to a reading computed here, because it computes none.
- The bar is therefore exactly as complete as the providers installed. Its own
  contribution is the layout: position, ordering, compaction, and tone.
- Every section's data is fetched by the plugin that owns it, so each provider is
  an additional plugin to install and keep working.
- Providers cannot be authenticated on this BB version (see above).
- The bar is a fixed overlay. `experimental_appOverlay` supplies no chrome,
  positioning, or responsive behavior, so re-verify against the composer, the
  terminal panel, and narrow windows after BB upgrades.
- Section discovery is a 10s poll, so a provider appearing or disappearing takes
  up to that long to take effect.
