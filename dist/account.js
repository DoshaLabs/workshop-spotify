// The Recent, Playlists and Search tabs: connecting a Spotify account, then lists that play in
// Spotify.app on a click. The connect steps are drawn here so anyone, not only the shared app's
// owner, gets from nothing to connected inside the tile.

import * as sp from './spotify-api.js'

/**
 * @param o.el        the DOM helper
 * @param o.box       where the connect steps go
 * @param o.searchSlot where the search box goes (beside the Search tab)
 * @param o.list      the <ul> the items go in
 * @param o.play      (item) => void: play a { uri, kind, name, by }
 * @param o.showError (message) => void
 */
export async function mountAccount(o) {
  const { el, box, list } = o
  await sp.load()

  let tab = null              // 'recent' | 'playlists' | 'search' while shown, else null
  let setupOpen = false       // the "use my own Spotify app" steps are showing
  let query = ''
  let results = null          // last search results
  let searchSeq = 0
  let loadSeq = 0

  const fail = (e) => {
    o.showError(e?.message || String(e))
    if (e?.notAllowed && sp.usingShared()) { setupOpen = true; draw() }
  }

  const tellState = () => o.onState?.(sp.state(), sp.user())
  sp.onChange(() => { draw(); tellState() })
  tellState()

  // ------------------------------------------------------------ pieces

  const button = (text, onclick, cls = '') => el('button', { class: cls, type: 'button', onclick }, text)
  const link = (text, onclick) => el('button', { class: 'link', type: 'button', onclick }, text)

  function copyField(value) {
    const input = el('input', { type: 'text', class: 'copy-value', readonly: '', value, spellcheck: 'false' })
    input.addEventListener('focus', () => input.select())
    const btn = button('Copy', async () => {
      try {
        await navigator.clipboard.writeText(value)
        btn.textContent = 'Copied'
        setTimeout(() => (btn.textContent = 'Copy'), 1500)
      } catch {
        input.focus()
        input.select()
        btn.textContent = '⌘C'
      }
    })
    return el('span', { class: 'copy' }, input, btn)
  }

  // A pill: the name on top, who made it beneath (artist, owner). Click plays it.
  function itemRow(item) {
    const name = item.name || 'Untitled'
    return el('li', { class: 'item' },
      el('button', { class: 'go', title: [name, item.by].filter(Boolean).join(' · '), 'aria-label': `Play ${name}`, onclick: () => o.play(item) },
        el('span', { class: 'name' }, name),
        el('span', { class: 'by' }, item.by || (item.kind[0].toUpperCase() + item.kind.slice(1)))
      )
    )
  }

  const note = (text) => el('li', { class: 'empty' }, text)

  // ------------------------------------------------------------ connect steps

  function connectView() {
    const s = sp.state()
    if (s === 'signing') return [
      el('p', {}, 'Approve in your browser. Workshop brings you back here by itself.'),
      el('div', { class: 'row' }, link('Cancel', () => sp.cancel().catch(fail)))
    ]

    const own = sp.ownClientId()
    const parts = []
    // Connect and "Use my own app" are in the tab bar; the panel only holds the own-app steps.
    if (!setupOpen && !own) return parts

    // Bring-your-own-app, in three steps, everything to copy right there.
    const idInput = el('input', { type: 'text', placeholder: 'Paste the Client ID here', spellcheck: 'false', autocomplete: 'off', value: own })
    const take = async () => {
      const v = idInput.value.trim()
      if (v === own) return
      if (!v) return sp.setOwnClientId('').catch(fail)
      if (!sp.isClientId(v)) return o.showError('A Client ID is 32 letters and digits. It is on your app’s page, under Basic Information.')
      await sp.setOwnClientId(v).catch(fail)
    }
    idInput.addEventListener('input', () => { if (sp.isClientId(idInput.value)) take() })
    idInput.addEventListener('change', take)

    parts.push(el('ol', { class: 'steps' },
      el('li', {},
        button('Open Spotify’s dashboard', () => ws().openExternal(sp.DASHBOARD).catch(fail)),
        el('span', { class: 'muted' }, ' and sign in.')),
      el('li', {}, 'Create an app: any name and description. Under Redirect URIs add ', copyField(sp.REDIRECT_URI),
        ' and tick ', el('b', {}, 'Web API'), '. Save.'),
      el('li', {}, 'Open the app’s Settings and copy its ', el('b', {}, 'Client ID'), ':', idInput)
    ))
    parts.push(el('div', { class: 'row' },
      own ? button('Connect Spotify', () => sp.connect().catch(fail), 'primary') : null,
      link(own ? 'Use the shared app instead' : 'Back', async () => { setupOpen = false; if (own) await sp.setOwnClientId('').catch(fail); draw(); tellState() })
    ))
    return parts
  }

  // ------------------------------------------------------------ connected

  function searchBox() {
    const input = el('input', { type: 'search', class: 'search', placeholder: 'Search songs, playlists, albums, artists', spellcheck: 'false', value: query })
    let t = 0
    input.addEventListener('input', () => {
      query = input.value
      clearTimeout(t)
      t = setTimeout(runSearch, 350)
    })
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { clearTimeout(t); runSearch() } })
    queueMicrotask(() => { if (document.activeElement === document.body) input.focus() })
    return input
  }

  async function runSearch() {
    const seq = ++searchSeq
    if (!query.trim()) { results = null; drawList(); return }
    try {
      const r = await sp.search(query)
      if (seq === searchSeq) { results = r; drawList() }
    } catch (e) { if (seq === searchSeq) fail(e) }
  }

  async function drawList() {
    if (tab === 'search') {
      if (!results) return list.replaceChildren()
      if (!results.length) return list.replaceChildren(note('Nothing found.'))
      return list.replaceChildren(...results.map(itemRow))
    }
    const seq = ++loadSeq
    if (!list.children.length || list.dataset.tab !== tab) list.replaceChildren(note('Loading…'))
    list.dataset.tab = tab
    let lib
    try { lib = await sp.libraryOf() } catch (e) {
      if (seq !== loadSeq) return
      list.replaceChildren(note(e.message))
      if (e.notAllowed) fail(e)
      return
    }
    if (seq !== loadSeq || !tab) return
    if (tab === 'recent') {
      // Most recently played first, so at the far left.
      list.replaceChildren(...(lib.songs.length ? lib.songs.map(itemRow) : [note('Nothing played lately.')]))
    } else {
      list.replaceChildren(...(lib.playlists.length ? lib.playlists.map(itemRow) : [note('No playlists in this account.')]))
    }
  }

  // ------------------------------------------------------------ the panel

  function draw() {
    if (!tab) return
    if (sp.state() !== 'connected') {
      o.searchSlot.replaceChildren()
      list.replaceChildren()
      list.dataset.tab = ''
      box.replaceChildren(el('div', { class: 'connect-steps' }, ...connectView()))
      return
    }
    setupOpen = false
    box.replaceChildren()
    // Keep the box (and what's typed, and the caret) if it is already there.
    if (tab !== 'search') o.searchSlot.replaceChildren()
    else if (!o.searchSlot.firstChild) o.searchSlot.replaceChildren(searchBox())
    drawList()
  }

  return {
    connect: () => sp.connect().catch(fail),
    cancel: () => sp.cancel().catch(fail),
    /** Show the steps for signing in through the user's own Spotify app. */
    ownApp() { setupOpen = true; draw() },
    tellState,
    setupShowing: () => setupOpen || !!sp.ownClientId(),
    disconnect: () => sp.disconnect().catch(fail),
    show(next) { tab = next; draw() },
    hide() { tab = null; loadSeq++; o.searchSlot.replaceChildren() },
    refresh() { sp.invalidate(); if (tab) drawList() },
    connected: () => sp.state() === 'connected',
    /** A new track started: what was played lately has changed. */
    trackChanged() {
      sp.invalidate()
      if (tab === 'recent') setTimeout(() => tab === 'recent' && drawList(), 4000)
    },
    redrawMarks() { if (tab && sp.state() === 'connected') drawList() }
  }
}

const ws = () => window.workshop
