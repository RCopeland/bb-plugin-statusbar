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
- **Spotify** — what is playing right now, with a progress bar.

Each section degrades on its own: a source that is missing or failing shows a
short muted label and never blanks the rest of the bar.

## Why a bar

BB's sidebar footer shows one disclosure at a time across all plugins, so
several small readouts end up competing for a single popup slot. A bar puts
them side by side where they stay readable without a click.

## How it works

Everything is computed inside this plugin, because BB has no cross-plugin data
channel — neither shared key-value reads nor plugin-to-plugin RPC. The usage and
lane logic is a deliberate copy of the Usage Footer and Lanes plugins; the host
reading is sampled directly.

For Spotify, this plugin reads the Spotify plugin's existing credentials
read-only rather than duplicating them, so there is still exactly one owner of
the refresh token. Credentials never leave the server.

Nothing is sent anywhere except the Spotify and OpenRouter APIs you already use
for those features.