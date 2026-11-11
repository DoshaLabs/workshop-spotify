# Spotify

A Spotify tile for [workshop](https://github.com/DoshaLabs/workshop)'s tile column: what Spotify
(or Music) is playing, with its artwork, play, pause, skip and a position slider. Connect your
Spotify account and it also lists what you played lately and your playlists, and searches; a
click plays the pick in the Spotify app on your Mac.

Needs workshop with bridge 1.5 (`workshop.oauth`). An older workshop lists it in the Marketplace
but will not install it.

## What it asks for

- `music`: workshop reads and drives Spotify.app and Music.app for the tile. Workshop never opens
  either app. macOS asks once whether workshop may control them.
- `storage`: your Spotify sign-in (a refresh token, kept in the tile's own storage on your Mac),
  the tab you were on, and your own Spotify app's Client ID if you use one.
- `oauth: accounts.spotify.com`: Connect opens Spotify's sign-in page in your browser, and
  workshop catches the answer on 127.0.0.1, so you never copy and paste an address.
- `net: accounts.spotify.com, api.spotify.com`: the tile trades the sign-in for a token and reads
  your recent plays, playlists and search from Spotify's Web API. Nothing else is reached.

There is no client secret: the tile signs in with PKCE, which needs none. The Client ID in
`dist/spotify-api.js` is public by design.

## Connect

Press Connect and approve on Spotify's page. The shared Spotify app is in Spotify's development
mode, which admits only accounts its owner added. Anyone else uses "Use my own app": the tile
walks you through making a Spotify app of your own (a minute on Spotify's dashboard), with the
redirect address to copy.

Playing from the lists without bringing Spotify to the front needs Spotify Premium; without it the
tile falls back to asking the app itself, which comes forward.

## Install

In workshop, press `+` at the foot of the tile column, open Marketplace, and install Spotify.

## Develop

Plain HTML, CSS and JavaScript in `dist/`, no build step. Load the folder with
`workshop tile dev .` and it reloads on save. `CLAUDE.md` is the tile contract, written for the
Claude session that edits the tile. `docs/oauth-proposal.md` is how `workshop.oauth` came about.

## Licence

MIT. See `LICENSE`. Spotify is a trademark of Spotify AB; this tile is not made or endorsed by
Spotify.
