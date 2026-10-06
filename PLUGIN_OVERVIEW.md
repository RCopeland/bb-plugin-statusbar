AI usage cost, model lane headroom, host resources, and Spotify now playing —
in one bar at the bottom of the BB window.

## What you get

A single row that stays visible while you work:

- **Usage** — today's AI spend and the month-to-date total, read from the same
  store the Usage plugin writes.
- **Lanes** — headroom on every model lane. Subscription lanes (Claude, Codex)
  show when they refill; metered lanes (OpenRouter) show the balance and never
  pretend it comes back on its own.
- **Host** — CPU, memory, disk, and load for the machine BB is running on.
- **Spotify** — what is playing right now, with transport controls.

Each section degrades on its own: a source that is missing or failing shows a
short muted label and never blanks the rest of the bar.

## Why a bar

BB's sidebar footer shows one disclosure at a time across all plugins, so
several small readouts end up competing for a single popup slot. A bar puts
them side by side where they stay readable without a click.

## How a section gets into the bar

The bar owns the strip, the ordering, and the look. It does not own the numbers.

Every topic reads from a **provider plugin** when one is loaded, and otherwise
from a **built-in reader** inside the bar:

1. The bar asks the host which loaded plugins publish `section.v1.snapshot`
   (discoverable plugin-to-plugin RPC).
2. It asks each one for a reading and learns which topic it supplies.
3. Per topic, a provider wins over the built-in.

There is no manifest dependency and no install order. The bar works with nothing
else installed, and a provider that is missing, disabled, or crashing just means
the built-in answers instead — the section never goes blank.

`bb plugin rpc call statusbar snapshot` reports where each section came from, so
this is never guesswork:

```json
"lanes": { "kind": "provider", "pluginId": "statusbar-section-lanes" }
```

The protocol lives in `packages/section-protocol`, shared by the bar and every
provider so the two cannot drift.

## Why this is split into several plugins

BB now has a cross-plugin RPC channel, which it did not when this bar was first
written. That means the plugin that already owns a piece of data can publish it,
instead of the bar carrying a copy that goes stale.

- `statusbar` — the bar, its registry, and the built-in fallbacks.
- `section-lanes` — example provider, publishing lane headroom.
- `section-protocol` — the shared contract (not installed on its own).

The built-in usage and lanes readers are still copies of the logic in the Usage
Footer and Lanes plugins. They exist so the bar stands alone; they are the
fallback, not the ambition.

For Spotify, the built-in reader reads the Spotify plugin's credentials
read-only rather than duplicating them, so there is still exactly one owner of
the refresh token. Credentials never leave the server.

Nothing is sent anywhere except the Spotify and OpenRouter APIs you already use
for those features.
