// Spotify transport controls, for when the built-in Spotify reader is the one
// answering.
//
// These are kept separate from ./builtins.ts so the control path and the read
// path can be reviewed independently: the read path never mutates anything,
// and everything that talks to Spotify's write endpoints lives here.
//
// The policy is deliberately inherited from bb-spotify rather than reinvented:
// play/resume is gated behind that plugin's `allowDisruptiveActions` setting
// (checked by the caller), and playback is addressed to its configured
// `defaultDeviceId` when one is set, so the bar behaves like the plugin it is
// reading credentials from.

const FETCH_TIMEOUT_MS = 20_000;

async function fetchWithTimeout(url: string, init: RequestInit = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/** One request against the Spotify Web API. */
async function spotifyApi(
  token: string,
  method: "GET" | "PUT" | "POST",
  path: string,
  args: { query?: Record<string, string> } = {},
): Promise<Response> {
  const url = new URL(`https://api.spotify.com/v1${path}`);
  for (const [key, value] of Object.entries(args.query ?? {})) {
    url.searchParams.set(key, value);
  }
  return fetchWithTimeout(url.toString(), {
    method,
    headers: { authorization: `Bearer ${token}` },
  });
}

async function spotifyErrorText(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as any;
    return String(body?.error?.message ?? `HTTP ${response.status}`);
  } catch {
    return `HTTP ${response.status}`;
  }
}

export async function controlSpotify(args: {
  action: "pause" | "play" | "next" | "previous";
  token: () => Promise<string | null>;
  invalidate: () => void;
  deviceId: string | null;
}): Promise<string> {
  const token = await args.token();
  if (token === null) {
    throw new Error("Spotify is not connected. Run `bb spotify auth start`.");
  }

  const query = args.deviceId === null ? undefined : { device_id: args.deviceId };

  const request: Record<typeof args.action, () => Promise<Response>> = {
    pause: () => spotifyApi(token, "PUT", "/me/player/pause", { query }),
    play: () => spotifyApi(token, "PUT", "/me/player/play", { query }),
    next: () => spotifyApi(token, "POST", "/me/player/next", { query }),
    previous: () => spotifyApi(token, "POST", "/me/player/previous", { query }),
  };

  const response = await request[args.action]();
  // Spotify answers 204 No Content on success for these endpoints.
  if (!response.ok && response.status !== 204) {
    throw new Error(`Spotify refused ${args.action}: ${await spotifyErrorText(response)}`);
  }

  // Drop the cached reading so the bar reflects the click on its next read
  // rather than waiting out the TTL.
  args.invalidate();

  const label =
    args.action === "pause" ? "Paused"
    : args.action === "play" ? "Resumed"
    : args.action === "next" ? "Skipped to the next track"
    : "Went back to the previous track";
  return args.deviceId === null ? `${label}.` : `${label} on ${args.deviceId}.`;
}

/** Saves the loaded track to Liked Songs. */
export async function likeSpotifyTrack(args: {
  token: () => Promise<string | null>;
  invalidate: () => void;
}): Promise<string> {
  const token = await args.token();
  if (token === null) {
    throw new Error("Spotify is not connected. Run `bb spotify auth start`.");
  }

  const playback = await spotifyApi(token, "GET", "/me/player");
  if (playback.status === 204) {
    throw new Error("Nothing is playing, so there is no track to save.");
  }
  if (!playback.ok) {
    throw new Error(`Spotify refused the request: ${await spotifyErrorText(playback)}`);
  }

  const body = (await playback.json()) as { item?: { uri?: string; name?: string } };
  const uri = body?.item?.uri;
  const name = body?.item?.name ?? "the current track";
  if (typeof uri !== "string" || uri.length === 0) {
    throw new Error("Nothing is playing, so there is no track to save.");
  }

  // Spotify moved "Save to Liked Songs" to /me/library. The older
  // PUT /me/tracks?uris=... now answers 403 Forbidden even with the
  // user-library-modify scope, so it must not be used here.
  const save = await spotifyApi(token, "PUT", "/me/library", { query: { uris: uri } });
  // Spotify answers 200 here; 204 is also documented.
  if (!save.ok && save.status !== 204 && save.status !== 200) {
    throw new Error(`Spotify refused to save the track: ${await spotifyErrorText(save)}`);
  }

  args.invalidate();
  return `Saved ${name} to Liked Songs.`;
}
