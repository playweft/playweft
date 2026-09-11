# playweft

An open platform for turning static web games into connected multiplayer experiences.

Playweft turns a static game page into a connected game client. Each room has
one authoritative Durable Object, persisted JSON state, and optional WebSocket
clients. The static page submits player actions and renders returned state and
events.

## Repository layout

```text
apps/web                 React room launcher, invitation host, and local game history
apps/rps-demo            Static Rock-Paper-Scissors example, bundled under /games/rps/
apps/worker              Cloudflare HTTP API, Durable Objects, deployment config
packages/game-protocol   JSON values and wire-message contract shared by both apps
packages/runtime-core    Runtime interface independent of Lua and Cloudflare
packages/runtime-lua     Lua 5.4 implementation of that interface
```

Third-party static-game authors should start with the [integration guide](docs/game-integration/README.md).

`apps/` are independently runnable applications. `packages/` is intentionally
small: code goes there only when it is used across an app boundary or is a
replaceable runtime implementation. Adding a QuickJS or direct-Wasm runtime
means implementing `GameRuntime` and registering it in
`apps/worker/src/runtime-registry.ts`; the Durable Object and React client do
not need to know interpreter-specific details.

## Trust boundary

The platform page is always top-level. A third-party game is loaded from a
separate game-content origin in a sandboxed iframe and communicates only
through a `MessageChannel`:

```text
platform page (same origin, HttpOnly session, WebSocket) -> Worker -> Durable Object
                  |
                  +-> sandboxed third-party iframe (game intents and state only)
```

The iframe never receives a platform account ID, session token, cookie, or
WebSocket URL. A game URL resolves to `playweft.json`; the browser fetches and
validates this Manifest, then the Worker fetches its same-origin Lua entry
server-side before opening `start_url`. After
the `MessagePort` handshake, every bridge message uses JSON-RPC 2.0. The
Durable Object atomically locks the Manifest game ID/version, runtime settings
and source hash: an identical repeat is harmless, while a different package
for an existing room is rejected. The iframe can subsequently
ask to perform a game action, but the Worker derives the user from its session
and maps it to a room-scoped opaque actor ID before invoking Lua. The public
room API deliberately has no CORS policy.

## Run locally

```sh
npm install
npm run dev:worker -- --var AUTH_SECRET:local-session-secret
npm run dev:rps
npm run dev:web
```

`AUTH_SECRET` signs the HttpOnly platform session and must be a Worker secret
in a real deployment. Without an X account, the platform issues a temporary
guest identity. The UI may copy its browser-local nickname into the signed
session as an optional display name. Browser-facing
mutations and WebSocket upgrades must have an `Origin` equal to the Worker
endpoint origin. Authenticated read requests remain usable in browsers that
omit `Origin` for a same-origin GET.

## Room API

| Request | Purpose |
| --- | --- |
| `POST /api/rooms` | Create a random room with `{ manifestUrl }`; room IDs default to 4-character friendly codes. |
| `GET /api/rooms/:roomId/launch` | Read the exact Manifest URL for the invitation page. |
| `PUT /api/rooms/:roomId/initialize` | Fetch the same-origin `serverUrl` and atomically install its source with the Manifest identity, player limits and persistence mode; repeating the same configuration is safe. |
| `POST /api/rooms/:roomId/join` | Join the platform-owned lobby. The room creator is the host; when every seat is taken, new arrivals join as spectators. |
| `POST /api/rooms/:roomId/seat` | Choose an empty numbered seat with `{ seat }`, or leave a seat to spectate with `{ seat: null }`. The host keeps their seat. |
| `POST /api/rooms/:roomId/ready` | Set a seated non-host player's readiness with `{ ready }`. |
| `POST /api/rooms/:roomId/leave` | Explicitly leave the room; ownership transfers immediately, and the room is deleted when its final member leaves. |
| `POST /api/rooms/:roomId/kick` | Room-host-only lobby action with `{ playerId }`. |
| `POST /api/rooms/:roomId/dissolve` | Room-host-only lobby action that closes the room for everyone and invalidates its invite link. |
| `POST /api/rooms/:roomId/start` | Room-host-only action; locks the seated roster and calls Lua `setup({ protocolVersion, match, players })`. |
| `POST /api/platform/guest` | Platform-only demo bootstrap; sets an HttpOnly guest session and accepts `{ name: string | null }`. |
| `GET /api/rooms/:roomId/state` | Read persisted state; requires a platform session. |
| `POST /api/rooms/:roomId/actions` | Submit `{ requestId, action }`; player identity comes from the platform session and `requestId` makes retries idempotent. |
| `GET /api/rooms/:roomId/connect` | Open a platform-owned WebSocket; requires a platform session. |

Before start, HTTP/WebSocket updates use `type: "room.presence"` with a
monotonic `revision`, the opaque player list, `spectators` entries containing
`{ id, name?, avatarUrl? }`, host, phase, and player limits. `avatarUrl` is
reserved for platform-authenticated profiles; clients should show a fallback
avatar when it is absent. Presence updates continue during play and are
independent from game snapshots. After start snapshots contain `type`,
`matchId`, the requesting player's visible `state` and `events`, `version`,
`serverTime`, and `scriptHash`. The required `view(state, events, context)`
callback runs separately for each recipient at every state-delivery boundary,
so neither authoritative state nor private events have an unfiltered delivery
path. The platform shows the lobby itself, then makes the untrusted iframe fill
the viewport once the roster is locked.

`game.initialize` exposes the current local profile as `player`, containing the
room actor `id` when applicable and the optional `name`. Room-mode Lua also
receives player names in `setup({ players })` and actor callbacks, so a game can
display the same nickname without trusting iframe-supplied identity.

## Rock-Paper-Scissors example

The game page is a static entry in `apps/rps-demo`, bundled with the platform at
`/games/rps/`. It has no direct API access and cannot be meaningfully opened as
a standalone game page. The platform homepage creates an ordinary room for it;
there is no dedicated demo route.

```sh
# Terminal 1: the trusted Worker. No game script needs pre-seeding.
npm run dev:worker -- --var AUTH_SECRET:local-session-secret

# Terminal 2: the static game example.
npm run dev:rps

# Terminal 3: trusted platform page.
npm run dev:web
```

For local development, open `http://localhost:9133`, enter
`http://localhost:9139`, then create a room. In a deployed build, select the
built-in game from the homepage, which resolves to `/games/rps/`. Copy the
resulting `/r/<roomId>` link to another browser or device. Each browser receives
an anonymous platform session. The first player chooses one of three buttons;
the server reveals both choices only after a second player chooses. A draw clears
both choices and starts the next round.

The platform keeps a browser-local list of recently used game Manifests. Names,
translations, icons and modes all come from the validated Manifest; protected
features are requested at runtime, and the iframe cannot replace catalogue
metadata. The room Durable Object
stores only the Manifest URL, fixed package identity, Lua configuration and player limits, game
state, the room creator, and opaque room-scoped player membership.

## Recommended games

Recommended games can be supplied at deployment time without changing tracked
source. Copy the example to the ignored local configuration and edit it:

```sh
cp apps/web/featured-games.example.json apps/web/featured-games.local.json
npm run deploy:platform
```

Vite reads `apps/web/featured-games.local.json` while building and embeds its
contents into the frontend bundle. The file is not uploaded separately and
changes take effect only after rebuilding. Do not put secrets in it: all
embedded configuration is public in the browser.

The JSON root is an array. Each item explicitly references either a game
Manifest or another JSON list:

```json
[
  {
    "manifestUrl": "/games/rps/playweft.json"
  },
  {
    "listUrl": "https://catalog.example.com/playweft-games.json"
  }
]
```

Remote lists use the same array format and may reference more lists. Relative
URLs resolve against the containing list. Both remote lists and game Manifests
must allow the Playweft frontend origin through CORS. Card metadata is fetched
from each Manifest; the deployment list does not duplicate it. The loader
deduplicates games by Manifest ID and limits recursion, total list requests,
response size, and request duration.

When the deployment file is elsewhere, set
`PLAYWEFT_FEATURED_GAMES_FILE=/path/to/games.json`. A configured path that does
not exist or contains invalid JSON fails the build. Without a configuration
file, the built-in RPS recommendation remains as the default.

## Room cleanup

Durable Object instances may hibernate automatically, but persisted storage is
not removed by hibernation. Each room therefore schedules a one-hour idle
alarm. Creating, opening, initializing, connecting, or acting in a room moves
the expiry forward. When the alarm finds no connected WebSockets and no activity
for an hour, it calls `storage.deleteAll()` and the invite link becomes invalid.

## Deploy to Cloudflare

Use one public origin, `https://play.example.com`, for the trusted platform
app, Worker API, WebSocket, Durable Object, and the bundled RPS sample at
`/games/rps/`. `npm run build:web` builds both frontend entries into
`apps/web/dist`, which is uploaded by the Worker configuration.

Third-party games should still use a separate origin. That keeps untrusted game
content out of the platform cookie's same-site context; the Worker's same-origin
check remains the second defence.

Write the Worker session secret interactively. Do not put it in Git; `secret
put` immediately creates a new Worker version:

```sh
npx wrangler secret put AUTH_SECRET --config apps/worker/wrangler.jsonc
npx wrangler secret put X_CLIENT_ID --config apps/worker/wrangler.jsonc
npx wrangler secret put X_CLIENT_SECRET --config apps/worker/wrangler.jsonc
npx wrangler secret put CLOUDFLARE_OAUTH_CLIENT_SECRET --config apps/worker/wrangler.jsonc
```

To enable the optional Cloudflare connection, configure its OAuth client as a
confidential Authorization Code client with `client_secret_basic`. Enable both
the `authorization_code` and `refresh_token` grant types, then register this
exact redirect URL:

```text
https://play.example.com/api/auth/cloudflare/callback
```

`CLOUDFLARE_OAUTH_CLIENT_ID` is a non-secret Worker variable, while the client
secret is a Worker secret. Playweft derives a separate AES key from
`AUTH_SECRET` with a Cloudflare-specific context, then encrypts the Cloudflare
access token into an HttpOnly, SameSite cookie scoped only to
`/api/platform/cloudflare`; it keeps no per-user Durable Object, KV, or D1
record for it. The short-lived access token is refreshed only when a protected
Cloudflare request needs it. Playweft explicitly requests the protocol scope
`offline_access`; configure `user-details.read` as a required scope. `ai.write`
may be configured as an optional scope for a future Workers AI integration.

To enable Sign in with X, configure the X App as an OAuth 2.0 Web App and
register this exact Callback URL, replacing the example host with the deployed
platform origin:

```text
https://play.example.com/api/auth/x/callback
```

The Worker derives this URL from the incoming request origin. The flow uses
Authorization Code with PKCE and requests only `tweet.read` and `users.read`.

Room ID generation is optional to configure. By default, the Worker uses
`ROOM_ID_FORMAT=code:4` with the friendly alphabet
`23456789ABCDEFGHJKMNPQRSTUVWXYZ`, and retries up to
`ROOM_ID_MAX_ATTEMPTS=8` collisions. Supported formats are `code:N`,
`digits:N`, `base64url:N`, and `uuid`. If the frontend is separately
configured, set `VITE_ROOM_ID_FORMAT` to the same value so the home input can
recognize room codes without an extra config request.

Deploy the platform. The Worker configuration uploads `apps/web/dist`, including
the RPS files under `/games/rps/`; `/api/*` runs the Worker first while other
navigation requests are handled by the React SPA.

```sh
npm run deploy:platform
```

After the first Worker deployment, bind `play.example.com` to that Worker in
the Cloudflare Dashboard. Browser requests are accepted only when their origin
matches the Worker endpoint they reach.

The built-in game uses relative paths, so no game-origin environment variable is
required. Redeploy the platform whenever its frontend, bundled game, or Worker
code changes.

## Lua game contract

```lua
function setup(context)
  return {
    state = {
      score = 0,
      players = context.players,
      match = context.match,
    },
    events = {},
  }
end

function on_action(state, action, context)
  if action.type ~= "add" then
    return {
      accepted = false,
      error = { code = "INVALID_ACTION", message = "Expected add" },
    }
  end
  state.score = state.score + action.amount
  return {
    accepted = true,
    state = state,
    events = { { player = context.actor.id, score = state.score } },
  }
end

function view(state, events, context)
  return {
    state = {
      score = state.score,
      ownHand = state.hands[context.viewer.id],
    },
    events = events,
  }
end
```

`view(state, events, context)` is required. It returns `{ state, events }` for
one `context.viewer`, which contains `{ id, role, seat?, name?, isOwner }`.
Games without hidden information may return both inputs unchanged. The result
is used for HTTP action responses, state reads, initial WebSocket snapshots,
and WebSocket broadcasts.

An optional `on_player_left(state, context)` callback runs when a player uses
the platform's **Leave game** action during play. It receives the leaving
`actor`, `matchId`, `version`, `leftAt`, and `serverTime`, then returns a
transition result.

An optional `on_return_to_room(state, context)` callback controls whether the
room host may end the current session and return every player to the lobby. It
must return `true` to permit the transition; omitted callbacks deny it.

`setup`, accepted `on_action`, `on_player_left`, and optional `on_timer` return
`{ state, events, timerOps? }`. `timerOps` is a list of authoritative timer
mutations committed together with the new state:

For compatibility, an older game whose `setup(context)` returns only the raw
state is normalized to `{ state = returnedValue, events = {} }`. Such a game
does not schedule timers unless it opts into the transition form and defines
`on_timer`.

```lua
timerOps = {
  {
    op = "schedule",
    id = "ai:seat-2",
    afterMs = 1000,
    payload = { seat = 2, turn = state.turn },
  },
  { op = "cancel", id = "turn" },
}
```

Each timer `id` is a single replaceable slot: scheduling an existing id replaces
it, while cancelling a missing id is harmless. A callback may contain only one
operation for each id. IDs are 1-64 characters matching
`[A-Za-z][A-Za-z0-9._:-]*`. `afterMs` is measured from the server time of the
transition, must be an integer from 100 milliseconds through 1 hour, and timer payloads
are server-only JSON values (8 KiB each, 32 KiB total). There may be up to 32
pending timers per persisted room. `view` must not return `timerOps`.
Any callback returning `timerOps` requires the game to define `on_timer`.
Timer execution uses a lazy per-room token budget: it starts with 16 tokens,
refills one token every 5 seconds, and is capped at 2,000 executions per UTC
day. Waiting for tokens does not schedule background work; the next timer is
simply deferred to the first allowed time.

When a timer becomes due, the platform calls the optional callback:

```lua
function on_timer(state, timer, context)
  -- timer = { id = "ai:seat-2", payload = { seat = 2, turn = 4 } }
  -- context contains matchId, version, dueAt, firedAt, and lateByMs.
  if timer.payload.turn ~= state.turn then
    return { state = state, events = {} }
  end
  return { state = state, events = {} }
end
```

Timers are durable, authoritative, and execute serially with actions. They are
best-effort rather than a millisecond-precise clock: games should use `dueAt`
for deadline rules, not `firedAt`. Before an action is handled, timers due when
that action reached the room are processed first. A pending timer keeps a
persisted room alive until it fires. Timers are unavailable to `persistence:
"live"` rooms because those rooms intentionally do not preserve game state.
Use a browser animation or `setTimeout` for presentation-only delays.
If `on_timer` exceeds a runtime boundary or returns an invalid transition, the
platform cancels the room's timers and pauses the match rather than silently
dropping or repeatedly running the event; the host can return it to the lobby.

Values crossing the Lua boundary must be JSON-compatible: null, booleans,
finite numbers, strings, arrays, and objects with string keys. `setup` receives
`{ protocolVersion, serverTime, match, players }` after the roster locks. `players` is the
seat-ordered `{ id, seat, name? }` roster. `match` contains `{ id, ownerId,
startedAt, randomSeed }`; `randomSeed` is a platform-generated 128-bit random
value encoded as a fixed 32-character lowercase hexadecimal string, and is
regenerated whenever the room starts another game. Action context contains
`{ protocolVersion, matchId, actionId, actionAt, serverTime, version, actor }`.
`actionAt` is the time the request reached the room; `serverTime` is the time
the transition runs and anchors `afterMs`. `actor` has `{ id, role, seat?,
name?, isOwner }`.

`on_action` must explicitly return either `{ accepted = true, state, events,
timerOps? }`
or `{ accepted = false, error = { code, message } }`. Rejected actions do not
change state or increment the version. `actionId` is scoped to the actor:
repeating the same ID and action returns the stored result without executing
Lua again, while reusing it for different content is rejected. The platform
keeps the most recent 256 results for the active match.

## Runtime boundaries

Lua runs from a build-time imported Wasm module, rather than fetching or
compiling Wasm inside a request. `patches/wasmoon+1.16.0.patch` is source
control, not build output: `patch-package` applies it after every install so
Wasmoon's generated loader accepts the Worker-provided `WebAssembly.Module`.

The runtime enforces a 256 KiB source limit, 64 KiB state limit, 8 KiB action
limit, 16 KiB event limit, 32 levels of nesting, 2,048 table entries, and 50,000 Lua
instructions per invocation. Lua does not receive I/O, OS, package/require,
coroutines, random, or debug APIs. The current generic Wasm build cannot impose
a separate hard Lua heap cap without invoking a dynamically generated callback
Wasm module, which Workers disallow; the serialized input/output limits are the
memory boundary for this initial version. A production high-tenant runtime
should use a custom Lua Wasm build with a statically linked quota allocator.

## Verify

```sh
npm run check
npm run build:web
npx wrangler deploy --config apps/worker/wrangler.jsonc --dry-run
```
