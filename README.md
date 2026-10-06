# bb-plugin-statusbar

One status bar pinned to the bottom of the BB window:

```
$0.39 today · $2.21 MTD │ OpenRouter 74% │ CPU 34% MEM 51% DISK 9% load 0.84 │ ♪ Artist — Track ▶
```

Four sections — AI usage cost, model lane headroom, host resources, and Spotify
now playing — in a single row, so they stay glanceable while you work instead of
competing for BB's one sidebar-footer disclosure slot.
- `server.ts` — the backend: one RPC method, `snapshot()`, returning all four sections.
- `app.tsx` — the frontend: the bar itself, registered through
  `app.slots.experimental_appOverlay`.

## Why this plugin computes everything itself

BB has **no cross-plugin data channel**, so this is not a shell that other plugins
register into. Two facts, verified against the running source rather than the docs:

1. **`bb.storage.kv` is plugin-scoped.** In
   `apps/server/src/services/plugins/plugin-api.ts`, every KV call closes over the
   *calling* plugin's id (`getPluginKvValue(db, pluginId, key)`), and `plugin_kv`
   is `PRIMARY KEY (plugin_id, key)`. A plugin cannot read another plugin's key.
2. **There is no plugin-to-plugin RPC.** `useRpc<Contract>()` infers from a
   type-only contract and takes no plugin id.

So the usage and lanes logic here is **duplicated on purpose** from
`bb-plugin-usage-footer` and `bb-plugin-lanes`, and the host sampler is its own
minimal implementation rather than a read of `host-monitor`'s database.

**This is the known cost of the design:** if any of those plugins changes its
schema or provider handling, this file does not follow automatically.

## Spotify: shared credentials, read-only

### Transport controls

The bar carries previous, play/pause, next, and save-to-Liked-Songs. They defer
to bb-spotify's own gating rather than inventing a second policy:

- **Play/resume requires bb-spotify's `allowDisruptiveActions` setting.** It is
  off by default in that plugin. When off, the bar surfaces a toast naming the
  setting instead of failing silently. Enable it with:

  ```sh
  bb plugin config spotify set allowDisruptiveActions true
  ```

- Playback targets bb-spotify's configured `defaultDeviceId` when set, matching
  that plugin's behavior; otherwise Spotify uses the active device.
- Pause, skip, previous, and like are never gated.
- Save-to-Liked-Songs uses `PUT /me/library`. The older
  `PUT /me/tracks?uris=…` now answers 403 Forbidden even with the
  `user-library-modify` scope, so it is not used.

### Credentials

Spotify needs credentials, which are per-plugin (`<dataDir>/plugins/<id>/secrets/`,
mode 0600). Duplicating them here would mean two independent refresh flows racing
on token rotation — each one invalidating the other.

Instead this plugin reads **bb-spotify's own credentials, read-only**:

| Input | Location |
| --- | --- |
| `clientId` (not a secret) | `bb.db` → `plugin_settings`, `plugin_id='spotify'`, `key='clientId'` |
| `clientSecret` | `~/.bb/plugins/spotify/secrets/clientSecret` |
| `refreshToken` | `~/.bb/plugins/spotify/secrets/refreshToken` |

Rules this plugin follows:

- **Read-only.** It never writes bb-spotify's files.
- **Rotation is ignored.** If Spotify returns a new `refresh_token`, this plugin
  uses it for the current access token but does *not* persist it — bb-spotify owns
  that value and persists rotation on its own path.
- **Values stay server-side.** No credential is logged, written to disk, returned
  over RPC, or placed in KV.
- **Fails soft.** Missing or unreadable credentials render `♪ not connected`,
  never a crash.

BB's own install prompt states the trust model: *"Plugins are full-trust code
running inside the BB server. They can read all local BB data, including other
plugins' secrets."* That is why this works — and why it needs re-checking if
secrets ever move to a non-root or differently-pathed layout.

## Sections

### How updates reach the bar

The bar polls `snapshot()` every 3 seconds. Each section is cached server-side
with its own TTL, so a tick is mostly memory reads and only hits the network
when a section has actually expired.

Spotify is deliberately the shortest TTL (3s). Playback changes from **outside**
this bar — pausing in the Spotify app, a track ending, another device taking
over — so its TTL is the worst-case delay for noticing that. Transport controls
call `invalidate()` on the Spotify cache, so a click is reflected on the very
next read rather than waiting out the TTL.

| Section | Source | Refresh |
| --- | --- | --- |
| Usage | `~/.bb/plugins/usage/data.db` (read-only, `node:sqlite`) | 60s |
| Lanes | `bb.sdk.system.usageLimits()` + OpenRouter `/api/v1/credits` | 60s |
| Host | In-plugin sampling (`node:os`, `df -Pk`) | 5s |
| Spotify | Spotify Web API, using bb-spotify's credentials | 3s |

Each section carries its own `status`, so one failing source never blanks the
other three. Numbers are labelled honestly: if the usage store's newest day is
older than today, the bar says so rather than presenting a stale figure as
today's.

## Configuration

None. The plugin has no settings by design — it reads what the other plugins and
the host already know.

## Development

```sh
bb plugin build          # emits dist/
bb plugin install . --yes
bb plugin reload statusbar
bb plugin logs statusbar
bb plugin rpc call statusbar snapshot
```

## Known limitations

- Depends on BB's secret file layout and on the plugin server having read access
  to it. If either changes, the Spotify section degrades to `not connected`.
- Usage and lanes logic is duplicated (see above) and can drift from its originals.
- The bar is a fixed overlay. `experimental_appOverlay` supplies no chrome,
  positioning, or responsive behavior, so re-verify against the composer, the
  terminal panel, and narrow windows after BB upgrades.