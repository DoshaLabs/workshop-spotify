// Spotify: a workshop tile. What Spotify (or Music) is playing, with its controls; and, once the
// user's account is connected, what they played lately, their playlists and search (account.js, spotify-api.js). Playback always goes through workshop.music.

import { mountAccount } from './account.js'
import * as sp from './spotify-api.js'

const ws = window.workshop
const $ = (id) => document.getElementById(id)

const ui = {
  art: $('art'), artPh: $('art-ph'), title: $('title'), artist: $('artist'), album: $('album'),
  pos: $('pos'), dur: $('dur'), seek: $('seek'), prev: $('prev'),
  play: $('play'), next: $('next'), modes: $('modes'), error: $('error'),
  refresh: $('refresh'), acct: $('acct'), own: $('own'), openApp: $('open-app'), connect: $('connect'), searchSlot: $('search-slot'), alist: $('alist')
}

function el(tag, props = {}, ...kids) {
  const e = document.createElement(tag)
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') e.className = v
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v)
    else e.setAttribute(k, v)
  }
  for (const k of kids.flat()) if (k != null && k !== false) e.append(k)
  return e
}

const fmt = (ms) => {
  if (!Number.isFinite(ms) || ms < 0) ms = 0
  const s = Math.floor(ms / 1000)
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = String(s % 60).padStart(2, '0')
  return h ? `${h}:${String(m).padStart(2, '0')}:${r}` : `${m}:${r}`
}

// ---------------------------------------------------------------- errors

let errTimer = 0
function showError(msg, sticky = false) {
  clearTimeout(errTimer)
  ui.error.textContent = msg || ''
  ui.error.hidden = !msg
  if (msg && !sticky) errTimer = setTimeout(() => (ui.error.hidden = true), 5000)
}
const run = (p) => p.catch((e) => showError(e?.message || String(e)))

// ---------------------------------------------------------------- now playing

ws.head.set({ title: 'Spotify', badge: '' }).catch(() => {})

let now = null              // the last reading from workshop.music
let readAt = 0              // when it arrived, for counting the position forward
let seeking = false         // the user is dragging the position slider
let stickyError = false
let lastTrack = ''
let account = null

function position() {
  if (!now?.track) return 0
  let p = now.positionMs || 0
  if (now.state === 'playing') p += performance.now() - readAt
  return Math.min(p, now.track.durationMs || p)
}

function drawProgress() {
  const d = now?.track?.durationMs || 0
  if (!seeking) {
    ui.seek.max = String(Math.max(d, 1))
    ui.seek.value = String(position())
    ui.pos.textContent = fmt(position())
  }
  ui.dur.textContent = fmt(d)
  ui.seek.style.setProperty('--p', d ? `${(Number(ui.seek.value) / d) * 100}%` : '0%')
}

function draw(m) {
  now = m
  readAt = performance.now()
  const noPlayer = !m || m.error || !m.player
  const t = m?.track

  if (m?.error) showError(m.message || 'Workshop could not reach the music app.', true)
  else if (stickyError) showError('')
  stickyError = !!m?.error

  if (m?.error) {
    ui.title.textContent = m.error === 'denied' ? 'Not allowed to control Spotify' : 'Could not reach Spotify'
    ui.artist.textContent = ''
    ui.album.textContent = ''
  } else if (!m?.player) {
    ui.title.textContent = 'Open Spotify'
    ui.artist.textContent = 'Workshop never opens it for you.'
    ui.album.textContent = ''
  } else if (!t) {
    ui.title.textContent = 'Nothing playing'
    ui.artist.textContent = 'Press play, or pick something below.'
    ui.album.textContent = ''
  } else {
    ui.title.textContent = t.title || 'Untitled'
    ui.artist.textContent = t.artist || ''
    ui.album.textContent = t.album || ''
  }
  ui.title.title = ui.title.textContent

  const status = m?.player ? (m.player === 'spotify' ? 'Spotify' : 'Music') + (m.state === 'playing' ? '' : ` · ${m.state}`) : ''
  ui.album.title = [ui.album.textContent, status].filter(Boolean).join(' — ')

  if (t?.art) {
    if (ui.art.getAttribute('src') !== t.art) ui.art.src = t.art
    ui.art.hidden = false
    ui.artPh.hidden = true
  } else {
    ui.art.hidden = true
    ui.art.removeAttribute('src')
    ui.artPh.hidden = false
  }

  const playing = m?.state === 'playing'
  ui.play.textContent = playing ? '⏸' : '▶'
  ui.play.title = ui.play.ariaLabel = playing ? 'Pause' : 'Play'
  for (const b of [ui.prev, ui.play, ui.next]) b.disabled = !!noPlayer
  ui.seek.disabled = !!noPlayer || !t

  const modes = []
  if (m?.shuffle) modes.push(el('span', { class: 'mode', title: 'Shuffle is on' }, '⤮'))
  if (m?.repeat && m.repeat !== 'off') modes.push(el('span', { class: 'mode', title: `Repeat ${m.repeat}` }, m.repeat === 'one' ? '↻1' : '↻'))
  ui.modes.replaceChildren(...modes)

  drawProgress()
  drawOpenApp()
  const key = trackKey(m)
  if (key && key !== lastTrack) { if (lastTrack) account?.trackChanged(); lastTrack = key }

}

// Count the position forward between readings so the bar moves smoothly.
setInterval(() => { if (now?.state === 'playing' && !document.hidden) drawProgress() }, 250)

// ---------------------------------------------------------------- controls

ui.play.onclick = () => run(ws.music.toggle())
ui.prev.onclick = () => run(ws.music.previous())
ui.next.onclick = () => run(ws.music.next())

ui.seek.addEventListener('input', () => {
  seeking = true
  ui.pos.textContent = fmt(Number(ui.seek.value))
  drawProgress()
})
ui.seek.addEventListener('change', () => {
  const ms = Math.round(Number(ui.seek.value))
  if (now) { now.positionMs = ms; readAt = performance.now() }
  seeking = false
  run(ws.music.seek(ms))
})

document.addEventListener('keydown', (e) => {
  // Typing anywhere (search, the connect steps) is typing, not a shortcut. Sliders keep theirs.
  const t = e.target
  if (t instanceof HTMLTextAreaElement || t?.isContentEditable) return
  if (t instanceof HTMLInputElement && t.type !== 'range') return
  if (e.metaKey || e.ctrlKey || e.altKey) return
  if (e.key === ' ' && !ui.play.disabled) { e.preventDefault(); ui.play.click() }
  else if (e.key === 'ArrowRight' && e.shiftKey && !ui.next.disabled) ui.next.click()
  else if (e.key === 'ArrowLeft' && e.shiftKey && !ui.prev.disabled) ui.prev.click()
})

// ---------------------------------------------------------------- playing from the lists

function trackKey(m) { return m?.track ? `${m.track.title}\u0000${m.track.artist}\u0000${m.track.album}` : '' }

function checkSpotify() {
  if (now?.player === 'spotify') return true
  showError(now?.player === 'music' ? 'These play in Spotify; Music is the app in use. Quit Music or open Spotify.' : 'Open Spotify first: workshop never opens it for you.')
  return false
}

// An item from the lists: { uri, kind, name, by }.
// Through the Web API first, which leaves Spotify in the background; if that can't (no Premium,
// a connection made before this, Spotify not reachable), workshop's playUri, which brings it forward.
let hinted = false
async function playItem(item) {
  if (!checkSpotify()) return
  if (sp.canPlay()) {
    try { await sp.play(item.uri); return } catch { /* fall through */ }
  } else if (sp.state() === 'connected' && !hinted) {
    hinted = true
    showError('Disconnect and Connect again to play without Spotify jumping to the front.')
  }
  await run(ws.music.playUri(item.uri))
}

// The row of pills scrolls sideways; a mouse wheel's up/down scrolls it too.
ui.alist.addEventListener('wheel', (e) => {
  if (Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return
  e.preventDefault()
  ui.alist.scrollLeft += e.deltaY
}, { passive: false })

// ---------------------------------------------------------------- tabs

const tabs = [...document.querySelectorAll('.tab')]
let tab = (await ws.storage.get('tab').catch(() => null)) || 'recent'
if (!tabs.some((b) => b.dataset.tab === tab)) tab = 'recent'

function showTab(next, remember = true) {
  tab = next
  for (const b of tabs) {
    b.classList.toggle('on', b.dataset.tab === tab)
    b.setAttribute('aria-selected', String(b.dataset.tab === tab))
  }
  ui.refresh.hidden = tab === 'search' || !account?.connected()
  account?.show(tab)
  if (remember) ws.storage.set('tab', tab).catch(() => {})
}
for (const b of tabs) b.addEventListener('click', () => showTab(b.dataset.tab))
ui.refresh.addEventListener('click', () => account?.refresh())

// Connect / Disconnect, at the end of the tab bar.
let acctState = 'none'
function drawAcct(state, who) {
  acctState = state
  drawOpenApp()
  ui.acct.hidden = false
  ui.acct.textContent = state === 'connected' ? 'Disconnect' : state === 'signing' ? 'Cancel' : 'Connect Account (beta)'
  ui.acct.title = state === 'connected' ? (who ? `Spotify: ${who}` : 'Spotify connected')
    : state === 'signing' ? 'Stop waiting for the sign-in' : 'Connect your Spotify account'
  ui.refresh.hidden = tab === 'search' || state !== 'connected'
  // The tabs only once there is an account to read: before that, just the way to connect.
  for (const b of tabs) b.hidden = state !== 'connected'
  ui.own.hidden = state !== 'none' || !!account?.setupShowing()
  ui.acct.classList.toggle('primary', state === 'none')
  // Nothing below the player yet: let the player have the tile's height.
  document.body.classList.toggle('solo', state === 'none' && !account?.setupShowing())
}

// Open Spotify, at the left of the bar while there is no account: brings the app in use to the
// front (workshop.music.show, bridge 1.6). Core never opens a closed app, so it shows only while
// Spotify or Music is running; it must be called in the click itself.
function drawOpenApp() {
  ui.openApp.hidden = acctState === 'connected' || !now?.player || !!now?.error
  ui.openApp.textContent = now?.player === 'music' ? 'Open Music' : 'Open Spotify'
}
ui.openApp.addEventListener('click', () => run(ws.music.show()))
ui.own.addEventListener('click', () => { account?.ownApp(); drawAcct(acctState) })
ui.acct.addEventListener('click', () => {
  if (acctState === 'connected') return account?.disconnect()
  if (acctState === 'signing') return account?.cancel()
  account?.connect()      // in the click itself: workshop.oauth.authorize needs it
})

// ---------------------------------------------------------------- start

try {
  account = await mountAccount({ el, box: ui.connect, searchSlot: ui.searchSlot, list: ui.alist, play: playItem, showError, onState: drawAcct })
  account.tellState()     // again, now that `account` is set (the bar asks it about the own-app steps)
} catch (e) { showError(`Account tabs failed to start: ${e.message}`) }
showTab(tab, false)
let stopWatch = ws.music.watch(draw)
document.addEventListener('visibilitychange', () => {
  // Workshop only reads the app while some page watches: stop while hidden, resume when shown.
  if (document.hidden) { stopWatch?.(); stopWatch = null }
  else if (!stopWatch) stopWatch = ws.music.watch(draw)
})
