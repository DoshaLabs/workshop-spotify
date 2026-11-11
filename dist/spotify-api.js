// The account side: the user's playlists, what they played lately, and search, read through
// Spotify's Web API. Authorization Code with PKCE: there is no client secret anywhere.
//
// Signing in: workshop.oauth (bridge 1.5) catches Spotify's redirect, so Connect is one click
// and an Approve.

const ws = window.workshop

/** The tile's own Spotify app (deck's). A PKCE client id is public by design. In Spotify's
 *  development mode it only admits accounts its owner added, so anyone else brings their own app.
 *  Both register REDIRECT_URI below. */
export const SHARED_CLIENT_ID = '079c0f1f46bd48019a0fb7892a66f57f'
/** Where workshop catches Spotify's redirect: http://127.0.0.1:47800/oauth/spotify/callback.
 *  What to register under Redirect URIs on the Spotify app. */
export const REDIRECT_URI = ws.oauth.redirectUri
export const DASHBOARD = 'https://developer.spotify.com/dashboard/create'

const AUTHORIZE = 'https://accounts.spotify.com/authorize'
const TOKEN = 'https://accounts.spotify.com/api/token'
const API = 'https://api.spotify.com/v1'
// user-modify-playback-state: start a playlist through the Web API, which leaves Spotify in the
// background (workshop.music.playUri brings Spotify to the front).
const SCOPES = ['playlist-read-private', 'playlist-read-collaborative', 'user-read-recently-played', 'user-modify-playback-state']
const PLAY_SCOPE = 'user-modify-playback-state'
const EARLY_MS = 60_000
const LIBRARY_TTL_MS = 5 * 60_000
const RECENT_CONTEXTS = 8
const RECENT_SONGS = 20
const PLAYLIST_PAGES = 4
const KEY = 'auth'
// stored: { ownClientId?,
//           account?: { clientId, refresh, access, expiresAt, user } }

let st = {}
const listeners = new Set()
const emit = () => { for (const f of listeners) f() }

export async function load() {
  st = (await ws.storage.get(KEY).catch(() => null)) || {}
  ws.storage.watch(KEY, (v) => {
    const was = `${st.account?.clientId}|${st.account?.user}|${state()}`
    st = v || {}
    // A token refresh writes here too; only a different account (or none) drops what was read.
    if (`${st.account?.clientId}|${st.account?.user}|${state()}` !== was) { library = null; emit() }
  })
}
export const onChange = (f) => (listeners.add(f), () => listeners.delete(f))
// 'signing': workshop is waiting for Spotify's redirect.
let signing = null      // { clientId } while workshop.oauth.authorize is pending
export const state = () => (st.account?.refresh ? 'connected' : signing ? 'signing' : 'none')
export const user = () => st.account?.user || ''
export const ownClientId = () => st.ownClientId || ''
export const usingShared = () => (st.account?.clientId || signing?.clientId || st.ownClientId || SHARED_CLIENT_ID) === SHARED_CLIENT_ID

async function store(next) {
  st = next
  library = null
  await ws.storage.set(KEY, next)
  emit()
}

export const isClientId = (s) => /^[0-9a-f]{32}$/i.test(String(s).trim())

/** Keep (or with '' forget) the user's own Spotify app; the shared one is used without it. */
export async function setOwnClientId(id) {
  id = String(id || '').trim().toLowerCase()
  if (id && !isClientId(id)) throw new Error('A Client ID is 32 letters and digits. It is on your app’s page, under Basic Information.')
  const { ownClientId: _, ...rest } = st
  await store(id ? { ...rest, ownClientId: id } : rest)
}

// ---------------------------------------------------------------- connecting

const b64url = (bytes) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
const random = (n) => { const a = new Uint8Array(n); crypto.getRandomValues(a); return b64url(a) }
async function sha256(text) {
  const data = new TextEncoder().encode(text)
  if (crypto.subtle) return new Uint8Array(await crypto.subtle.digest('SHA-256', data))
  return sha256js(data)
}

/**
 * Sign in: Spotify's consent page in the browser, workshop catches the redirect, the tile trades
 * the code. Must run from a click (workshop.oauth.authorize refuses otherwise). Resolves once the
 * account is in, or quietly if the user cancelled.
 */
export async function connect() {
  const clientId = st.ownClientId || SHARED_CLIENT_ID
  const verifier = random(64)
  const challenge = b64url(await sha256(verifier))
  const q = new URLSearchParams({
    response_type: 'code', client_id: clientId, scope: SCOPES.join(' '), redirect_uri: REDIRECT_URI,
    code_challenge_method: 'S256', code_challenge: challenge
  })
  // Workshop sets its own state and hands back the redirect's query without it.
  signing = { clientId }
  emit()
  let query
  try {
    ({ query } = await ws.oauth.authorize(`${AUTHORIZE}?${q}`))
  } catch (e) {
    signing = null
    emit()
    if (/oauth: cancelled/.test(e?.message)) return
    if (/oauth: timed out/.test(e?.message)) throw new Error('The sign-in waited 5 minutes for you to approve. Press Connect again.')
    if (/oauth: port .* in use/.test(e?.message)) throw new Error('Something else on this Mac is using port 47800, which workshop needs for signing in. Quit it and press Connect again.')
    throw e
  }
  try {
    await exchange(new URLSearchParams(query), { clientId, verifier, redirectUri: REDIRECT_URI })
  } finally {
    signing = null
    emit()
  }
}

/** The redirect's query (code or error) to a stored account. */
async function exchange(q, { clientId, verifier, redirectUri }) {
  const err = q.get('error')
  if (err) {
    throw new Error(err === 'access_denied' ? 'You pressed Cancel on Spotify’s page. Connect again when you’re ready.' : `Spotify said: ${err}`)
  }
  const code = q.get('code')
  if (!code) throw new Error('Spotify sent no code back. Press Connect again.')
  const t = await tokenRequest({ grant_type: 'authorization_code', code, redirect_uri: redirectUri, client_id: clientId, code_verifier: verifier })
  if (!t.refresh_token) throw new Error('Spotify returned no refresh token. Press Connect again.')
  const account = { clientId, refresh: t.refresh_token, access: t.access_token, expiresAt: Date.now() + t.expires_in * 1000, user: '', scope: t.scope || '' }
  st = { ...dropPending(), account }
  try {
    const me = await api('/me')
    account.user = me.display_name || me.id || ''
  } catch (e) {
    if (e.notAllowed) { await store(dropAccount()); throw e }
    /* the name is decoration */
  }
  await store({ ...dropPending(), account })
}

export async function cancel() {
  if (signing) await ws.oauth.cancel().catch(() => {})   // its authorize() rejects 'cancelled'
}
export async function disconnect() { await store(dropAccount()) }

// `pending` was the paste flow's (before workshop.oauth): dropped wherever it is still stored.
function dropPending() { const { pending: _, ...rest } = st; return rest }
function dropAccount() { const { account: _, pending: __, ...rest } = st; return rest }

async function tokenRequest(form) {
  const r = await fetch(TOKEN, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(form).toString(),
    signal: AbortSignal.timeout(10_000)
  })
  const j = await r.json().catch(() => ({}))
  if (!r.ok || !j.access_token || !j.expires_in) {
    const e = new Error(explainTokenError(j))
    e.code = j.error
    throw e
  }
  return j
}
function explainTokenError(j) {
  if (j.error === 'invalid_client') return 'Spotify does not know that Client ID. Check it on your app’s page.'
  if (j.error === 'invalid_grant' && /redirect/i.test(j.error_description || '')) return `Add ${REDIRECT_URI} under Redirect URIs on your Spotify app, save, and connect again.`
  if (j.error === 'invalid_grant') return 'That sign-in has expired or was used already. Press Connect again.'
  return `Spotify sign-in failed: ${j.error_description || j.error || 'no reply'}`
}

let refreshing = null
async function token() {
  const a = st.account
  if (!a) throw Object.assign(new Error('Spotify account not connected.'), { signedOut: true })
  if (a.access && Date.now() < a.expiresAt - EARLY_MS) return a.access
  refreshing ??= (async () => {
    try {
      const t = await tokenRequest({ grant_type: 'refresh_token', refresh_token: a.refresh, client_id: a.clientId })
      const account = { ...a, access: t.access_token, refresh: t.refresh_token || a.refresh, expiresAt: Date.now() + t.expires_in * 1000, scope: t.scope || a.scope || '' }
      st = { ...st, account }
      ws.storage.set(KEY, st).catch(() => {})
      return account.access
    } catch (e) {
      // A revoked grant (the user removed the app in their Spotify settings) ends the connection.
      if (e.code === 'invalid_grant') {
        await store(dropAccount())
        throw Object.assign(new Error('Spotify disconnected (access was removed). Connect again.'), { signedOut: true })
      }
      throw e
    } finally { refreshing = null }
  })()
  return refreshing
}

async function api(path, retry = true, init = {}) {
  const headers = { Authorization: `Bearer ${await token()}` }
  if (init.body) headers['content-type'] = 'application/json'
  const r = await fetch(path.startsWith('http') ? path : API + path, {
    method: init.method || 'GET', body: init.body, headers, signal: AbortSignal.timeout(10_000)
  })
  if (r.status === 401 && retry && st.account) { st.account.expiresAt = 0; return api(path, false, init) }
  if (r.status === 204 || r.status === 202) return null
  if (!r.ok) {
    const j = await r.json().catch(() => null)
    const msg = j?.error?.message || `HTTP ${r.status}`
    if (r.status === 403 && /registered|developer|dashboard/i.test(msg)) {
      throw Object.assign(new Error(usingShared()
        ? 'The shared Spotify app only lets in the accounts its owner added. Use your own Spotify app instead: it takes a minute.'
        : 'Your Spotify app does not let this account in. On its page, User Management, add the email of the Spotify account you signed in with.'), { notAllowed: true })
    }
    if (r.status === 429) throw new Error('Spotify says too many requests. Try again in a minute.')
    throw Object.assign(new Error(`Spotify: ${msg}`), { status: r.status, reason: j?.error?.reason })
  }
  return r.json()
}

// ---------------------------------------------------------------- playing

/** May this connection start playback through the Web API? (Older connections lack the scope.) */
export const canPlay = () => state() === 'connected' && (st.account?.scope || '').split(' ').includes(PLAY_SCOPE)

/**
 * Start a song, playlist, album or artist on the Spotify app on this Mac, without bringing it to the
 * front. Needs Premium. Throws when it can't, so the caller can fall back to workshop.music.playUri.
 */
export async function play(uri) {
  const body = JSON.stringify(/^spotify:(track|episode):/.test(uri) ? { uris: [uri] } : { context_uri: uri })
  try {
    await api('/me/player/play', true, { method: 'PUT', body })
  } catch (e) {
    // No active device: Spotify is open but idle. Aim at this computer's player and try once more.
    if (e.status !== 404) throw e
    const d = await api('/me/player/devices')
    const devs = d?.devices || []
    const dev = devs.find((x) => x.is_active) || devs.find((x) => x.type === 'Computer') || devs[0]
    if (!dev?.id) throw e
    await api(`/me/player/play?device_id=${encodeURIComponent(dev.id)}`, true, { method: 'PUT', body })
  }
}

// ---------------------------------------------------------------- reading

const artists = (a) => (a || []).map((x) => x.name).join(', ')
let library = null                  // { at, value: Promise<{ contexts, songs, playlists }> }
const contextNames = new Map()      // uri -> Promise<item | null>

/** Recent contexts and songs, then the playlists. Cached 5 minutes; `fresh` skips the cache. */
export function libraryOf(fresh = false) {
  if (!fresh && library && Date.now() - library.at < LIBRARY_TTL_MS) return library.value
  const value = Promise.all([recent(), playlists()]).then(([r, playlists]) => ({ ...r, playlists }))
  library = { at: Date.now(), value }
  value.catch(() => (library = null))
  return value
}
/** Something new was played: the next read is fresh. */
export function invalidate() { library = null }

async function playlists() {
  const out = []
  let url = '/me/playlists?limit=50'
  for (let i = 0; url && i < PLAYLIST_PAGES; i++) {
    const page = await api(url)
    for (const p of page?.items || []) {
      if (p?.uri) out.push({ uri: p.uri, kind: 'playlist', name: p.name || 'Untitled', by: p.owner?.display_name || '' })
    }
    url = page?.next || null
  }
  return out
}

/** The distinct playlists / albums / artists of the last 50 plays (named), and the distinct songs. */
async function recent() {
  const j = await api('/me/player/recently-played?limit=50')
  const uris = [], songs = [], seen = new Set()
  for (const it of j?.items || []) {
    const c = it?.context?.uri
    if (c && /^spotify:(playlist|album|artist):[A-Za-z0-9]+$/.test(c) && !uris.includes(c) && uris.length < RECENT_CONTEXTS) uris.push(c)
    const t = it?.track
    if (t?.uri?.startsWith('spotify:track:') && !seen.has(t.uri) && songs.length < RECENT_SONGS) {
      seen.add(t.uri)
      songs.push({ uri: t.uri, kind: 'track', name: t.name, by: artists(t.artists), at: Date.parse(it.played_at) || 0 })
    }
  }
  const contexts = (await Promise.all(uris.map(contextItem))).filter(Boolean)
  return { contexts, songs }
}

function contextItem(uri) {
  let p = contextNames.get(uri)
  if (!p) {
    const [, kind, id] = uri.split(':')
    p = (async () => {
      if (kind === 'playlist') {
        const j = await api(`/playlists/${id}?fields=name,owner.display_name`)
        return { uri, kind, name: j.name, by: j.owner?.display_name || '' }
      }
      if (kind === 'album') {
        const j = await api(`/albums/${id}`)
        return { uri, kind, name: j.name, by: artists(j.artists) }
      }
      const j = await api(`/artists/${id}`)
      return { uri, kind, name: j.name, by: '' }
    })().catch(() => { contextNames.delete(uri); return null })
    contextNames.set(uri, p)
  }
  return p
}

export async function search(q) {
  const query = q.trim()
  if (!query) return []
  const params = new URLSearchParams({ q: query, type: 'track,playlist,album,artist', limit: '6' })
  const j = await api(`/search?${params}`)
  const out = []
  for (const t of (j.tracks?.items || []).slice(0, 4)) if (t) out.push({ uri: t.uri, kind: 'track', name: t.name, by: artists(t.artists) })
  for (const p of (j.playlists?.items || []).slice(0, 4)) if (p) out.push({ uri: p.uri, kind: 'playlist', name: p.name, by: p.owner?.display_name || '' })
  for (const a of (j.albums?.items || []).slice(0, 3)) if (a) out.push({ uri: a.uri, kind: 'album', name: a.name, by: artists(a.artists) })
  for (const a of (j.artists?.items || []).slice(0, 3)) if (a) out.push({ uri: a.uri, kind: 'artist', name: a.name, by: '' })
  return out
}

// ---------------------------------------------------------------- SHA-256, if crypto.subtle is missing

function sha256js(bytes) {
  const K = new Uint32Array([0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2])
  const H = new Uint32Array([0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19])
  const len = bytes.length, total = ((len + 9 + 63) >> 6) << 6
  const m = new Uint8Array(total)
  m.set(bytes); m[len] = 0x80
  const dv = new DataView(m.buffer)
  dv.setUint32(total - 4, (len * 8) >>> 0); dv.setUint32(total - 8, Math.floor(len / 0x20000000))
  const W = new Uint32Array(64)
  const r = (x, n) => (x >>> n) | (x << (32 - n))
  for (let o = 0; o < total; o += 64) {
    for (let i = 0; i < 16; i++) W[i] = dv.getUint32(o + i * 4)
    for (let i = 16; i < 64; i++) {
      const s0 = r(W[i-15], 7) ^ r(W[i-15], 18) ^ (W[i-15] >>> 3), s1 = r(W[i-2], 17) ^ r(W[i-2], 19) ^ (W[i-2] >>> 10)
      W[i] = W[i-16] + s0 + W[i-7] + s1
    }
    let [a, b, c, d, e, f, g, h] = H
    for (let i = 0; i < 64; i++) {
      const t1 = (h + (r(e, 6) ^ r(e, 11) ^ r(e, 25)) + ((e & f) ^ (~e & g)) + K[i] + W[i]) >>> 0
      const t2 = ((r(a, 2) ^ r(a, 13) ^ r(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) >>> 0
      h = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0
    }
    H[0] += a; H[1] += b; H[2] += c; H[3] += d; H[4] += e; H[5] += f; H[6] += g; H[7] += h
  }
  const out = new Uint8Array(32), ov = new DataView(out.buffer)
  for (let i = 0; i < 8; i++) ov.setUint32(i * 4, H[i])
  return out
}
