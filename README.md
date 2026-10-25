# Sticker Showdown

A real-time, one-versus-one sticker battle that runs in the browser. Two players
share a room code, both hammer a send control, and the server keeps the official
score and clock. No accounts, no installs, no framework on the client.

- Stack: Node.js, Express, Socket.IO, vanilla HTML, CSS and JavaScript
- Storage: in-memory rooms on the server, `localStorage` for personal records
- Hosting target: a single Render Web Service that serves the app and the WebSocket endpoint from the same origin

## Contents

1. [Product overview](#product-overview)
2. [Screens](#screens)
3. [Architecture](#architecture)
4. [Local setup](#local-setup)
5. [Configuration](#configuration)
6. [Sticker assets](#sticker-assets)
7. [Game rules and server authority](#game-rules-and-server-authority)
8. [Testing](#testing)
9. [Security design](#security-design)
10. [Personal records](#personal-records)
11. [Accessibility](#accessibility)
12. [Legal pages](#legal-pages)
13. [Render deployment](#render-deployment)
14. [Git and GitHub workflow](#git-and-github-workflow)
15. [Known limitations](#known-limitations)
16. [Uploading to GitHub and deploying, step by step](#uploading-to-github-and-deploying-step-by-step)

## Product overview

| Item | Detail |
| --- | --- |
| Players per room | Exactly 2 |
| Round lengths | 30, 60 or 90 seconds, chosen by the host |
| Scoring | One point per accepted sticker send, computed only by the server |
| Send rate | 10 per second sustained with a burst allowance of 14 (configurable) |
| Accounts | None |
| Payments | None |
| Data stored on the server | Temporary room state in memory only |
| Data stored in the browser | Personal best, opponent name, round length, display name, tab session token |

The interface is mobile first and works in portrait, landscape and on desktop.
Two devices on different networks can play as long as both can reach the same
deployment.

## Screens

**Home.** Title, short rules, display name, create room, join by code, personal
best with previous opponent, compact legal links.

**Lobby.** Room code, invitation link with a working copy button, both player
slots with host and ready labels, host-only round length selector, ready toggle,
host start control that unlocks only when two connected players are both ready.

**Arena.** Both names and scores, large countdown, sticker tray with actual
artwork, a large send control that supports tapping and press-and-hold, a compact
feed of recent sends from both players, connection status, leave control.

**Results.** Final scores for both players, win, lose or draw, margin, personal
best banner, rematch, copy invitation for a new match, return home.

**Records and information.** Personal best detail, explanation of local storage,
clear-record action, links to every legal page.

## Architecture

```
public/                 static frontend served by Express
  index.html            single page shell with the five screens
  css/styles.css        design system, responsive rules, a11y styles
  js/app.js             screen router, match UI, socket actions
  js/socket-client.js   acknowledgement based Socket.IO wrapper
  js/records.mjs        validated localStorage record (ES module, unit tested)
  js/time-sync.mjs      server clock offset helper (ES module, unit tested)
  js/legal.js           local-data removal on the cookie page
  stickers/             sticker files plus manifest.json and licence notice
  legal/                readable legal pages, rendered with config placeholders
src/
  index.js              production entry point, port binding, graceful shutdown
  server.js             HTTP + Socket.IO composition, origin policy, tick loop
  config.js             all environment configuration and defaults
  logger.js             structured logs with no payload dumps
  http/app.js           Express app, helmet CSP, static files, APIs, 404 and errors
  socket/index.js       socket events, acknowledgements, broadcasts, replay guard
  game/rooms.js         authoritative room and match state machine
  game/names.js         display name and room code validation
  game/rate-limiter.js  token buckets and fixed windows
  stickers/catalog.js   local or remote catalogue discovery and validation
  security/origin.js    same-origin and allowlist policy
  legal/pages.js        legal page rendering and placeholders
assets/source-stickers/ untouched original sticker uploads, not served
tests/                  node:test suites, including two-client end to end
scripts/                syntax lint and sticker manifest generator
render.yaml             Render Blueprint
```

### Server state machine

```
WAITING --(second player joins)--> READY
READY --(host starts, both ready)--> COUNTDOWN
COUNTDOWN --(server start time)--> PLAYING
PLAYING --(server end time)--> FINISHED
FINISHED --(both request rematch)--> READY
any --(idle or result expiry)--> CLOSED
```

Room fields: random room id, six character code, host id, two player slots with
server generated tokens, phase, duration, start and end timestamps, scores, ready
and connection state, rematch state, final result, expiry.

### Realtime protocol

Client to server, every call returns an acknowledgement:

| Event | Purpose |
| --- | --- |
| `room:create` | Create a room with a validated display name |
| `room:join` | Join by code |
| `session:resume` | Reattach to a player slot after refresh or reconnect |
| `room:duration` | Host sets 30, 60 or 90 seconds |
| `room:ready` | Toggle ready |
| `room:start` | Host starts the round |
| `sticker:send` | Send one sticker with a unique event id |
| `match:rematch` | Request a rematch after a finished round |
| `room:leave` | Leave intentionally |
| `state:request` | Read-only resync |
| `time:sync` | Clock offset measurement |

Server to client: `room:state`, `scores`, `sticker:event`, `match:started`,
`match:ended`, `notice`, `room:closed`, `session:replaced`.

## Local setup

Requirements: Node.js 20 or newer (built and tested on Node 22), npm 10.

```bash
git clone https://github.com/myapps112233/App1.git
cd App1
npm ci
cp .env.example .env      # optional, defaults work without it
npm start
```

Open <http://localhost:3000>. To play against yourself, open a second browser
profile or a private window, create a room in one window and paste the
invitation link into the other. Different browsers are the clearest test because
`sessionStorage` is per tab, so each tab gets its own player slot.

Development commands:

```bash
npm run dev        # node --watch restart on change
npm test           # full node:test suite
npm run lint       # syntax check every JS file, no dependencies
npm run manifest   # rebuild public/stickers/manifest.json
npm run audit      # npm audit for production dependencies
```

`npm start` runs the real production server. It reads `PORT` and binds `HOST`
(default `0.0.0.0`).

## Configuration

All settings live in `src/config.js` and are documented in `.env.example`.

| Variable | Default | Meaning |
| --- | --- | --- |
| `NODE_ENV` | `development` | `production` enables HSTS, strict framing and proxy trust |
| `PORT` | `3000` | Render provides this |
| `HOST` | `0.0.0.0` | Bind address |
| `ALLOWED_ORIGINS` | empty | Extra allowed origins, comma separated |
| `PUBLIC_ORIGIN` | empty | Canonical public origin, optional |
| `REQUIRE_ORIGIN` | `false` | Reject connections that send no `Origin` header |
| `TRUST_PROXY` | `1` in production | Number of proxy hops in front of the app |
| `EMBED_ORIGINS` | empty | Extra origins allowed to frame the game |
| `DEV_ALLOW_ANY_ORIGIN` | `false` | Development only escape hatch for preview proxies; ignored in production |
| `COUNTDOWN_MS` | `3200` | Pre-round countdown |
| `ROOM_IDLE_TTL_MS` | `1200000` | Lobby inactivity expiry (20 minutes) |
| `ROOM_FINISHED_TTL_MS` | `300000` | Result window (5 minutes) |
| `DISCONNECT_GRACE_MS` | `30000` | Grace before a lobby slot is released |
| `MAX_ROOMS` | `500` | Instance-wide room cap |
| `MAX_ROOMS_PER_IP` | `15` | Active rooms per address and creation rate |
| `MAX_SOCKETS_PER_IP` | `12` | Concurrent sockets per address |
| `JOIN_ATTEMPTS_PER_MINUTE` | `30` | Join attempts per address |
| `SEND_PER_SECOND` | `10` | Sustained sticker rate per player |
| `SEND_BURST` | `14` | Token bucket capacity |
| `STICKER_MANIFEST_URL` | empty | Remote catalogue JSON |
| `STICKER_ASSET_BASE` | empty | Base URL for remote sticker files |
| `PRIVACY_CONTACT_EMAIL` | empty | Contact shown on legal pages |
| `CONTACT_URL` | repository issues | Fallback contact channel |
| `OPERATOR_NAME` | generic | Entity named in legal pages |

The game is same-origin by default. A browser request must come from the host
that served the page, or from an origin in `ALLOWED_ORIGINS`. Set
`ALLOWED_ORIGINS` on Render to the exact service URL once you know it, for
example `https://sticker-showdown.onrender.com`, especially if the service is
also reachable at a custom domain.

## Sticker assets

Assets are served from `public/stickers` on the same origin. The server builds
the catalogue at boot: it lists the directory, keeps `.webp`, `.png`, `.jpg`
and `.jpeg`, rejects files under 512 bytes or over 2 MB, and reads descriptive
alt text from `public/stickers/manifest.json`. Clients fetch the sanitised
catalogue from `/api/stickers`, and every send is validated against it, so an
unknown or forged sticker id scores nothing.

Manifest shape:

```json
{
  "version": 1,
  "stickers": [
    { "file": "STK-20260825-WA0079.webp", "alt": "Reaction sticker 1" }
  ]
}
```

The served API shape is `{ "version": 1, "stickers": [{ "id", "src", "alt" }] }`.

After adding or removing files run `npm run manifest`, then restart the server.

### This repository's collection

The twelve WebP stickers that were uploaded to this repository were resized for
mobile play (384 px, quality controlled) and two animated files were flattened
to their first frame, because 40 to 64 frame animations at ten sends per second
are too heavy for low-end phones. The total sticker payload is about 172 KB. The
untouched originals are preserved in `assets/source-stickers` and are not served
by the game.

Descriptive alt text is currently generic ("Reaction sticker 1"). Edit
`public/stickers/manifest.json` if you want better descriptions. See
`public/stickers/LICENSE.md` for the asset notice: these are personal reaction
images supplied by the repository owner, and the owner must confirm the right to
publish them before making the game public. Stickers taken from messaging apps
are usually not licensed for redistribution.

### Hosting the collection in another GitHub repository

Point the server at a manifest and an asset base instead of the local folder:

```env
STICKER_MANIFEST_URL=https://raw.githubusercontent.com/OWNER/REPO/main/stickers/manifest.json
STICKER_ASSET_BASE=https://cdn.jsdelivr.net/gh/OWNER/REPO@main/stickers/
```

Rules for remote mode:

- The manifest must return JSON with a `stickers` array, each entry having a
  string `id` and a relative `src` or `file` path ending in `.webp`, `.png`,
  `.jpg` or `.jpeg`.
- `STICKER_ASSET_BASE` is optional. If set, relative paths are resolved against
  it. If omitted, paths must start with `/` and be served by this app.
- Absolute URLs and arbitrary hosts are rejected. The manifest fetch does not
  follow redirects and times out after six seconds.
- If the remote manifest fails validation, the server logs a warning and falls
  back to the local directory.
- Add the asset host to the CSP automatically by keeping `STICKER_ASSET_BASE`
  set; the app derives `img-src` from it.
- Raw GitHub URLs are fine for small manifests but are rate limited and are not
  a CDN. jsDelivr works for pinned tags. Neither is hardcoded in the app.

## Game rules and server authority

1. Players choose a name locally, then create or join a room.
2. The creator is the host. The host selects 30, 60 or 90 seconds.
3. Both players mark ready. The host can start only with exactly two connected,
   ready players.
4. The server records `startsAt` and `endsAt`, then broadcasts them. The countdown
   shown in the browser is derived from those timestamps plus an offset measured
   with round trips.
5. Before `startsAt`, sends are rejected. From `startsAt` up to but excluding
   `endsAt`, each valid send adds exactly one point.
6. Sends after `endsAt` are rejected, and the server finalises the round at the
   official end time even if both browsers are asleep.
7. The server builds the result, with winner, draw and margin, and sends the same
   object to both players. A round finalises once.
8. Either player can request a rematch. When both request it, the room returns to
   the lobby with scores cleared. The room keeps the same code.

Rejected events never change a score: duplicate event ids, unknown sticker ids,
sends from a socket that does not own the slot, sends for another room, sends in
the wrong phase, and rate-limited bursts.

### Press and hold

Tapping sends one sticker. Pressing and holding starts repeat sending after
320 ms at eight sends per second, which stays under the server limit. Repeats are
still ordinary `sticker:send` events with unique ids, so nothing is scored
without the server accepting it. Keyboard activation sends once per press.

### Disconnects

- A short disconnect does not end the match and does not award a victory.
- Reconnecting with the tab's session token restores the same player slot and
  server state. An older socket for the same slot is disconnected, so two tabs
  cannot both score for one player.
- During a round, a disconnected player simply cannot score. The round finishes
  on time and the result stands.
- In the lobby, a disconnected player is kept for 30 seconds, then the slot is
  released so the other player is not stuck. If the host leaves, the remaining
  player becomes host.
- If a round already finished, a returning player receives the stored result
  rather than a new round.
- Abandoned rooms expire: 20 minutes of inactivity in the lobby, 5 minutes after
  a result. Both values are configurable.

A refresh during a live round reconnects and shows the round in progress with the
current server scores. Closing the tab behaves like a disconnect.

## Testing

```bash
npm test
```

The suite uses the built-in Node test runner against the real Express and
Socket.IO server, with an injected clock so round timing is deterministic.

Coverage highlights (90 tests):

- Room creation, joining, invalid, expired, full and started rooms, duplicate
  names, code collisions, host-only actions, cross-room isolation, member checks,
  capacity limits, session replacement and lobby disconnect grace.
- Match lifecycle: readiness gating, allowed durations only, identical state for
  both players, countdown transition, official end time, single finalisation,
  blocked restart, rematch reset.
- Scoring: one point per accepted event, duplicate ids, malformed ids, unknown
  stickers, wrong phase, late sends at the exact end time, forged score or winner
  fields, rate limiting with recovery, simultaneous events, draw and margin.
- Security: security headers, blocked development paths, path traversal attempts,
  oversized JSON, origin rejection and allowlist, unauthenticated events,
  malformed payloads, payload field spoofing, third competitor, token guessing,
  per-IP socket cap, disconnect storms, room isolation.
- Browser modules: record save and replace rules, corrupt and unavailable
  storage, field minimisation, name handling, clock offset maths.

What is not automated: pixel level layout in real browsers, and physical device
testing. The layout was written mobile first and uses dynamic viewport units,
safe area insets and a landscape layout for short screens, but it should be
checked on the devices you care about before a public launch.

### Manual test script for two players

1. Open the site in two different browsers, or one normal and one private window.
2. Enter two names, create a room in the first window, copy the link, open it in
   the second window, and join.
3. Confirm both windows show both names and that only the host can change the
   round length.
4. Mark both players ready, start the round, and check that both countdowns
   start together. Send with both windows and confirm each score matches on both
   screens.
5. Let the clock reach zero and confirm both windows show the same result and
   margin, and that your own record updates only in your own browser.
6. Reload one window during a round and confirm it returns to the live round with
   the correct score.
7. Request a rematch from both windows and confirm scores return to zero and the
   round number increases.

## Security design

The client is treated as untrusted.

- **Server authority.** Scores, timestamps, winners and identities are server
  values. A `score` or `winnerId` sent by a client is ignored. There is no client
  side increment that survives reconciliation.
- **Slot ownership.** Each socket is bound to a room and player at create, join
  or resume time. Scoring checks that the socket id matches the slot. Room ids
  and player ids in payloads are ignored.
- **Event validation.** Every event checks payload shape, key count, phase,
  membership and rate limits. Sticker ids must exist in the catalogue. Event ids
  must match `[A-Za-z0-9_-]{8,64}` and are deduplicated in a bounded window.
- **Timing.** Acceptance compares the server clock with the official end time, so
  a stopped or modified browser clock cannot extend a round.
- **Rate limits.** Per-player token bucket for sends, per-socket bucket for room
  actions, per-IP socket cap, per-IP join attempts, per-IP active rooms and
  creation rate, instance room cap, and an HTTP request limiter.
- **Origin policy.** Handshakes with an `Origin` header must be same-host or in
  the allowlist. Set `REQUIRE_ORIGIN=true` if non-browser clients are not needed.
- **Headers.** Helmet sets CSP, nosniff, referrer policy, permissions defaults and
  HSTS in production. There is no inline script and no inline style.
- **Input handling.** Names are Unicode normalised, limited to 16 characters,
  restricted to letters, numbers, spaces and simple punctuation, and rendered
  with `textContent`. Room codes are normalised to six characters.
- **No uploads, no remote URLs from clients.** Sticker files are read from an
  approved directory or a configured manifest. There is no upload route, no
  admin route and no debug route.
- **Errors.** Clients receive a code and a short message. Stack traces stay in
  server logs. Logs record event names, counts and error codes, not payloads.
- **Privacy of logs.** No display names, room codes, message bodies or session
  tokens are logged.
- **Transport.** Render terminates HTTPS. The app trusts one proxy hop in
  production so the client IP is correct for rate limits.
- **Dependencies.** Four production dependencies (Express, Socket.IO, Helmet,
  Compression) and a committed lockfile. Run `npm audit --omit=dev`.

### Findings and residual risks

- **Room codes are short.** Six characters from a 32 symbol alphabet give about
  one billion combinations, but codes are shareable and not secret. A determined
  attacker could guess an active code. Mitigations: rate limited joins, a join
  attempt cap per address, at most two players, no listing of rooms. A guessed
  code only joins an empty seat before the host starts, and cannot read scores or
  the other player's token.
- **Session tokens are bearer tokens.** They live in `sessionStorage`, are random
  32 byte values, and are invalidated on intentional leave. Two tabs sharing one
  token fight for the slot by design. There is no account recovery, which is
  acceptable for an anonymous casual game.
- **In-memory state.** A restart destroys rooms and results. This is documented
  and matches the single instance design.
- **No database.** No SQL, no RLS claims, no stored personal history.
- **Local records are not integrity protected.** Anyone with device access can
  edit `localStorage`. Scores shown during play are server verified, but the
  personal best is a convenience value, not a leaderboard.
- **Not immune to denial of service.** Limits are proportionate to a small game,
  but a distributed flood can still exhaust a free Render instance. Render's
  platform protections and the room cap reduce the impact.
- **CSP allows framing in development.** Production uses `frame-ancestors
  'self'` unless `EMBED_ORIGINS` is set. Development allows framing so hosted
  previews work.

No credentials are committed. `.env` is ignored. `render.yaml` references
secrets only with `sync: false`.

## Personal records

Stored in `localStorage` under `sticker-showdown:record:v1`:

```json
{ "bestScore": 42, "opponentName": "Bo", "roundDurationSeconds": 60 }
```

- A first match creates the record. A higher score replaces it. A lower or equal
  score does not.
- Reads re-validate the shape. Corrupt values are ignored and reported, and the
  next good match overwrites them.
- If storage is blocked, the game still runs and simply does not save a record.
- Clear it from Records, or from the Cookie Preferences page.
- Records are per browser and per device. They are not synced, not transferable
  and not tamper proof.

The display name is kept separately in `sticker-showdown:name:v1` for
convenience. The live session token is kept in `sessionStorage` so a refresh can
rejoin the same slot.

## Accessibility

Semantic landmarks and headings, visible labels, a skip link, visible focus
rings, rectangular targets of at least 44 px, no colour-only status, no audio or
vibration, reduced motion support, and a native confirmation dialog for leaving.
Scores are not announced on every point: a polite live region reads the score at
most every six seconds and the final result once. The sticker feed is hidden from
assistive technology because it changes many times per second. Keys 1 to 6 select
stickers.

Known gaps are listed on `/legal/accessibility`. No third-party audit has been
done.

## Legal pages

`/legal/privacy`, `/legal/terms`, `/legal/cookies`, `/legal/accessibility` and
`/legal/contact` are real pages with substantive copy. They are rendered from
`public/legal/*.html` with these placeholders filled at request time:
`{{CONTACT}}`, `{{EFFECTIVE_DATE}}`, `{{OPERATOR}}`, `{{REPO_URL}}`,
`{{CONTACT_URL}}`, `{{YEAR}}`.

Before a public launch:

1. Set `PRIVACY_CONTACT_EMAIL` to a real, monitored address. Until it is set the
   pages point at the issue tracker and state that no private contact address is
   configured. No address is invented.
2. Set `OPERATOR_NAME` to the person or entity running the deployment.
3. Review the pages with someone qualified for your jurisdiction. The text
   describes the actual implementation but is not legal advice or a guarantee of
   compliance.
4. Confirm the age notice matches your audience.
5. Re-check the asset licensing statement against your sticker collection.

Cookies: the app sets no cookies and uses no analytics. Only essential local and
session storage is used, so there is no consent banner. The Cookie Preferences
page explains this and provides a working removal control. If optional tracking
is ever added, a functioning consent mechanism must be added first.

There are no payments, subscriptions or purchases in this version.

## Render deployment

The repository includes `render.yaml`. Manual dashboard steps are below, and a
longer walkthrough is in the final section.

### Option A: Blueprint

1. Push the repository to GitHub.
2. In Render, choose **New**, then **Blueprint**.
3. Select the repository. Render reads `render.yaml`.
4. Supply values for `ALLOWED_ORIGINS` (can be blank on the first deploy),
   `PRIVACY_CONTACT_EMAIL` and `OPERATOR_NAME` when prompted.
5. Apply. Render runs `npm ci`, then `npm start`, and probes `/healthz`.

### Option B: Web Service

1. **New**, then **Web Service**, then connect the repository.
2. Runtime: Node. Region: closest to your players. Branch: `main`.
3. Build command: `npm ci`. Start command: `npm start`.
4. Health check path: `/healthz`.
5. Environment variables:
   - `NODE_ENV=production`
   - `HOST=0.0.0.0`
   - `TRUST_PROXY=1`
   - `ALLOWED_ORIGINS=https://YOUR-SERVICE.onrender.com` (add your custom domain too)
   - `PRIVACY_CONTACT_EMAIL=you@example.com`
   - `OPERATOR_NAME=Your name`
6. Instance count: **1**. Do not scale horizontally; rooms are in memory.
7. Choose the free plan for a trial, or a paid instance for fewer cold starts.
8. Deploy, wait for "Live", then open the URL and check `/healthz`.

Post-deploy check:

1. `/healthz` returns `{"status":"ok", ...}`.
2. Home loads with the parchment theme and the sticker tray appears after joining.
3. Two browsers complete a match, both scores match, both results match.
4. A refresh during a round returns to the live round.
5. Personal best appears on the home screen after a win.

Render notes:

- WebSockets are supported on Render Web Services without extra configuration.
- Free instances sleep after inactivity; the first request wakes the service and
  in-memory rooms are lost while asleep. State is also lost on every deploy.
- HTTPS is provided by Render. The app redirects nothing itself and does not need
  to, because Render serves HTTPS and forwards the original protocol.
- Health checks hit `/healthz`, which does not create rooms or sockets.
- If you later add multiple instances, rooms and rate limits must move to shared
  storage, and Socket.IO needs a Redis adapter. Neither is implemented.

### Troubleshooting

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| Build fails on `npm ci` | Lockfile out of sync | Run `npm install` locally, commit `package-lock.json` |
| Health check fails | Wrong start command or port | Start command must be `npm start`; never hardcode a port, use `process.env.PORT` |
| Page loads, sockets fail | Origin mismatch | Set `ALLOWED_ORIGINS` to the exact `https://` origin |
| "Cannot reach the game server" | Server asleep or restarting | Wait for the instance, then retry |
| Rooms vanish | Process restarted or free instance slept | Expected with in-memory rooms |
| Sticker tray empty | Catalogue missing or files too large | Check the deploy logs for `sticker_catalog_loaded`, keep files under 2 MB |

## Git and GitHub workflow

```bash
git status                 # confirm no unrelated local changes
npm test                   # must be green
npm run lint
git add .
git commit -m "Build Sticker Showdown realtime game"
git push origin main
```

This build was produced on the branch `arena/5f65dace-app1`, which is based on
`main` of `myapps112233/App1`. Merge it into `main` through a pull request if you
want Render to auto-deploy from `main`, or point the Render service at the branch
you choose. Never force push and never overwrite unrelated repository files.

## Known limitations

- Rooms are in memory on one instance. A deploy or restart ends live matches.
- No database, no accounts, no spectator mode, no chat, no friend list.
- Six character room codes are shareable, not secrets.
- Personal records are per browser and editable by the device owner.
- Sticker alt text is generic until edited in the manifest.
- Two source stickers were animated and are served as static first frames.
- No automated visual regression or real-device testing was run in this
  environment, because no browser binaries were available. Server behaviour and
  the browser flow are covered by 90 automated tests, including a two-client
  match and a jsdom run of the real interface.
- The free Render plan sleeps, so the first visitor waits for a cold start.

## Uploading to GitHub and deploying, step by step

These steps assume the code is in this repository and the Render account is
yours.

### 1. Put the code on GitHub

The build is already committed on `arena/5f65dace-app1`. To bring it into `main`:

```bash
git fetch origin
git checkout main
git merge --ff-only arena/5f65dace-app1   # or open a pull request
git push origin main
```

If you prefer a pull request, open it from `arena/5f65dace-app1` to `main` and
merge it after the checks pass. There are no GitHub Actions checks committed, so
verify locally with `npm test` first.

### 2. Create the Render service

1. Sign in at <https://dashboard.render.com>.
2. Select **New**, then **Web Service**.
3. Connect GitHub and choose `myapps112233/App1`.
4. Name it, for example `sticker-showdown`.
5. Branch: `main`. Runtime: Node.
6. Build command: `npm ci`.
7. Start command: `npm start`.
8. Health check path: `/healthz`.
9. Instance count: `1`.
10. Plan: Free to try, Starter for a always-warm instance.
11. Add environment variables before the first deploy:

```
NODE_ENV=production
HOST=0.0.0.0
TRUST_PROXY=1
ALLOWED_ORIGINS=https://sticker-showdown.onrender.com
PRIVACY_CONTACT_EMAIL=your-real-address@example.com
OPERATOR_NAME=Your name or project name
CONTACT_URL=https://github.com/myapps112233/App1/issues
LEGAL_EFFECTIVE_DATE=24 October 2026
```

Replace the hostname with the URL Render shows for your service. If the URL
differs, update `ALLOWED_ORIGINS` and redeploy. If you attach a custom domain,
append it as a second comma separated value.

12. Select **Create Web Service**, then watch the logs. A successful boot ends
    with `server_listening` and `sticker_catalog_loaded` records.
13. Open the URL. Check `/healthz` in the browser, then play a match in two
    browsers.
14. After the first deploy, confirm the service URL and set `ALLOWED_ORIGINS` to
    that exact value if you have not already, then redeploy.

### 3. First-run checklist

- [ ] `/healthz` returns ok
- [ ] Home loads and shows the sticker count in the rules panel
- [ ] A room can be created and the invitation link copies
- [ ] A second browser can join with the code and the link
- [ ] Both ready states appear, and start is enabled only when both are ready
- [ ] Scores match on both screens during the round
- [ ] The round ends by itself and both results match
- [ ] A personal best appears on the home screen after a match
- [ ] Refresh during a round returns to the live round
- [ ] Privacy page shows your real contact address
- [ ] Legal review completed, especially the asset licensing statement

### 4. Ongoing maintenance

- `npm audit --omit=dev` after dependency updates.
- Keep one instance until shared room state exists.
- Watch the Render logs for `socket_origin_rejected` if players cannot connect.
- Re-run `npm run manifest` whenever stickers change.
- Review the legal pages whenever features or providers change.
