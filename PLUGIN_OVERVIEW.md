AI usage cost, model lane headroom, and host resources — in one bar at the
bottom of the BB window. Other sections, Spotify included, are contributed by
provider plugins.

## What you get

A single row that stays visible while you work:

- **Usage** — today's AI spend and the month-to-date total, read from the same
  store the Usage plugin writes.
- **Lanes** — headroom on every model lane. Subscription lanes (Claude, Codex)
  show when they refill; metered lanes (OpenRouter) show the balance and never
  pretend it comes back on its own.
- **Host** — CPU, memory, disk, and load for the machine BB is running on.
- **Extensible** — any plugin can claim a topic, including the known ones.
  Spotify is supplied this way, by `bb-statusbar-spotify`.

Each section degrades on its own: a source that is missing or failing shows a
short muted label and never blanks the rest of the bar.

## Why a bar

BB's sidebar footer shows one disclosure at a time across all plugins, so
several small readouts end up competing for a single popup slot. A bar puts
them side by side where they stay readable without a click.

## How a section gets into the bar

The bar owns the strip, the ordering, and the look. It owns no numbers at all.

Every section comes from a **provider plugin**:

1. The bar asks the host which loaded plugins publish `section.v1.snapshot`
   (discoverable plugin-to-plugin RPC).
2. It asks each one for a reading and learns which topic it supplies.
3. Each topic renders whatever its provider returned.

There is no manifest dependency and no install order. With no providers loaded
the bar renders nothing; each provider you install adds its section.

There are **no built-in fallbacks**. A provider that is missing, disabled, or
crashing means its section does not render — the bar shortens rather than
degrading to a reading computed inside the bar. That is the tradeoff for having
exactly one implementation of each reading.

**Topics are open.** A provider may contribute a topic the bar has never heard
of (the clock example does exactly this), so adding a section never requires a
change to the bar. The known topics render first, in a fixed order; contributed
topics render after them.

`bb plugin rpc call statusbar snapshot` reports where each section came from, so
this is never guesswork:

```json
"clock": { "kind": "provider", "pluginId": "statusbar-section-clock" }
```

The protocol lives in `packages/section-protocol`, shared by the bar and every
provider so the two cannot drift.

## Why this is split into several plugins

BB now has a cross-plugin RPC channel, which it did not when this bar was first
written. That means the plugin that already owns a piece of data can publish it,
instead of the bar carrying a copy that goes stale.

- `statusbar` — the bar and its provider registry. It computes no readings at
  all.
- `section-clock` — example provider, adding a clock. It reads nothing but the
  system time on purpose: with no data source to explain, what remains is purely
  the shape of a contribution.
- `section-protocol` — the shared contract (not installed on its own).

`usage`, `lanes`, and `spotify` are each supplied by a dedicated provider plugin,
and the bar no longer computes any of them. Each was removed from the bar once
its provider existed, so there is no second copy of that logic to drift.

Spotify is a separate plugin (`bb-statusbar-spotify`) which owns its own
credentials, so the refresh token has exactly one owner and no two refresh flows
race. Credentials never leave the server.

The bar itself talks to no network service. Anything a section fetches, it
fetches on its own behalf.
