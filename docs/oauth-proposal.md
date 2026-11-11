# Proposal: `workshop.oauth`, one-click sign-in for tiles

> **Superseded.** What was built is in `~/workshop/docs/progress/2026-11-11-oauth.md`. It differs
> from this proposal in two ways: each tile has its own redirect
> (`http://127.0.0.1:47800/oauth/<tile-id>/callback`, not a shared `/oauth/callback`), and PKCE is
> required (`response_type=code`, `code_challenge_method=S256`). Kept for the reasoning.

From the Spotify tile (`~/workshop-tiles/spotify`). Proposed as bridge **1.5**.

## The problem

Any tile that signs in to a service with OAuth gets stuck at the same step. The tile builds the
authorize URL with PKCE and opens it with `workshop.openExternal`. The user approves, and the
provider sends the browser to the app's redirect URI with `?code=…&state=…`. For a desktop app
that is a loopback address, here `http://127.0.0.1:47821/callback`, and nothing is listening on
it: a tile cannot run a server, and `net` refuses `localhost` and IPs on purpose.

So the browser shows "can't connect to 127.0.0.1", and the Spotify tile asks the user to copy
that dead page's address (⌘L ⌘C) and paste it back into the tile. It works, but it is the worst
part of the tile, and every OAuth tile (GitHub, Google, Linear, Spotify…) will hit the same wall.

Core is a trusted Electron process. It can do the one thing the sandbox forbids: listen on
127.0.0.1 for a few minutes while a sign-in is in flight.

## The proposal

### Manifest

```json
"workshop": "^1.5",
"permissions": {
  "oauth": ["accounts.spotify.com"],
  "net": ["accounts.spotify.com", "api.spotify.com"]
}
```

`oauth` lists the hosts whose authorize page the tile may send the user to. The host rules are
the same as `net` (no IPs, no `localhost`, no bare `*`; `*.x.com` does not include `x.com`).
`net` still has to name the token endpoint, because the tile does the code exchange itself.

- Permission words: `sign you in at accounts.spotify.com`
- Permission keys: `oauth:accounts.spotify.com`, one per host, so adding a host asks again
  (`needsAsking`), the same as `net:`.
- `OAUTH_SINCE = '1.5.0'`: a tile that asks for `oauth` must set `"workshop"` to `^1.5` or later.
  This is the same check `LAUNCH_SINCE` makes for `sessions: "launch"`.

### Page API

```js
workshop.oauth.redirectUri
// 'http://127.0.0.1:47800/oauth/callback': the same for every tile and every Mac.
// This is what the user (or the tile's author) registers with the provider.

const { query } = await workshop.oauth.authorize(url)
// url: the provider's authorize URL, built by the tile, with PKCE and with
//      redirect_uri=workshop.oauth.redirectUri. Core adds its own `state`.
// Resolves with the callback's query string, the provider's own `state` removed:
//   'code=AQB…'   or   'error=access_denied'
// Rejects with: 'oauth: <host> is not in permissions.oauth', 'oauth: needs a click in the tile',
//   'oauth: timed out' (5 min), 'oauth: cancelled', 'oauth: port 47800 is in use'

await workshop.oauth.cancel()   // ends this tile's pending sign-in, if any
```

The tile then exchanges the code exactly as it does now: a `fetch` to the token endpoint, with
its PKCE verifier, allowed through `net`.

### What core does on `authorize(url)`

1. **Check the call.** It must come within 5 s of a click or key press in the page (the same
   rule as `openOverlay`). `url` must be `https:`, its host must be in `permissions.oauth`, and
   its `redirect_uri` must equal `redirectUri` exactly.
2. **One sign-in per tile.** A new `authorize` cancels this tile's earlier one, which rejects
   with `cancelled`.
3. **Add the state.** Core sets `state` in the URL to 32 random bytes of its own and replaces
   any `state` the tile put there. Core keeps a table from state to tile id, instance and expiry.
4. **Start the listener.** If no sign-in is pending yet, core binds `127.0.0.1:47800` (IPv4
   loopback only, never `0.0.0.0`) and opens the URL in the browser (`shell.openExternal`).
5. **Answer the callback.** On `GET /oauth/callback?…`, core looks up `state`:
   - Unknown or expired: a 400 page that says "This sign-in has expired. Try again from the tile."
   - Known: core resolves that tile's promise with the query minus `state`, and the browser
     shows a page of core's own: "Signed in to accounts.spotify.com. You can close this tab."
     Fixed HTML: no tile content and nothing from the query is echoed back.
6. **Close the listener** when nothing is pending: after the last callback, the last
   timeout or cancel, or when the tile unloads.

Any other path, method or host header gets a 404. The listener serves nothing but the callback.

## Why this design

- **Core never holds tokens.** It sees only the authorization code, and with PKCE the code is
  useless without the verifier, which stays in the tile. Refresh tokens live in the tile's own
  `workshop.storage`, as they do now.
- **Tiles cannot catch each other's sign-ins.** Core makes the state, so a callback can only
  reach the tile that started that sign-in. A tile cannot read another tile's callback by
  guessing or reusing a state.
- **A tile cannot use this to open arbitrary pages.** The host must be declared and shown to
  the user, the call needs a click, and the redirect is pinned to core's own callback.
  `openExternal` can already open any https URL, so the only new power is "get the callback's
  query back", and only for declared hosts.
- **One fixed redirect URI for everyone.** It is something a tile author can register once on a
  shared app, and that a user can copy from the tile's setup steps. Spotify, and most providers,
  compare redirect URIs exactly, port included, so the port must not move between Macs or runs.
  If `47800` is taken, `authorize` rejects with a clear message instead of picking another port.
- **It works for every provider that allows a loopback redirect** (RFC 8252 §7.3): Spotify,
  GitHub, Google desktop clients, Linear, Dropbox, and more. Nothing in it is Spotify-specific.

## Considered and not chosen

- **Paste the address** (today): it works with no core change, but it is two key combinations
  and a paste, on a page that looks broken.
- **Read the clipboard on focus** (the Spotify tile does this now as a fallback): it saves the
  paste, not the copy, and depends on the page being allowed `navigator.clipboard.readText`.
- **A hosted relay** (an https redirect on a server that keeps the code until the tile fetches
  it): no core change, but someone has to run a server that sees every sign-in code, and each tile
  needs its host in `net`.
- **A custom scheme** (`workshop://oauth/…`): about as much core work (register the scheme,
  route by state), and some providers refuse non-https, non-loopback redirects. Loopback is the
  standard for desktop apps.
- **Core does the whole flow, tokens included:** core would then have to store and refresh
  third-party tokens. It's more code, and core would hold secrets it does not need.

## Where it goes (from reading core at 93235cc)

- `src/shared/manifest.ts`: `oauth?: string[]` on `Permissions`, `'oauth'` in `KNOWN`, the host
  checks shared with `net`, `OAUTH_SINCE`, and `BRIDGE_VERSION` → `1.5.0` (add it to the
  version comment).
- `src/shared/permissions.ts`: the words and the `oauth:<host>` keys, handled in
  `permissionWords`, `permissionKeys` and `permissionChange` the same way as `net:`.
- `src/main/oauth.ts` (new): the state table, the listener and its life, the two fixed pages.
  Unit-testable apart from Electron, like `music.ts`.
- `src/main/index.ts`: IPC handlers next to `openExternal` (around line 574), reusing the
  gesture check from `openOverlay` and `openForTile`'s once-a-second limit.
- `src/preload/tile.ts`: `workshop.oauth`, present only when the permission is declared, as
  `workshop.music` is.
- `template/` and the tile CLAUDE.md: a row in the permission table and a short "Signing in"
  section. `tile check` reports the new errors.
- Tests: manifest validation (hosts, the version range); the state table (unknown state,
  expiry, one per tile, cancel on unload); and a smoke test that runs a fake provider: it opens
  the URL, fetches the callback the way a browser would, and checks the tile gets `code=`.

## The Spotify tile once it ships

The connect flow goes from:

> Connect → approve in the browser → the page says it can't connect to 127.0.0.1 → ⌘L ⌘C →
> back to workshop → paste

to:

> Connect → approve in the browser → "You can close this tab" → the tile is connected.

The tile would change `REDIRECT_URI` to `workshop.oauth.redirectUri`, replace `openExternal`
plus the paste box with `authorize()`, and keep the paste box only for cores older than 1.5.
The tile's shared Spotify app and the user's-own-app steps would both register the one
workshop redirect URI.
