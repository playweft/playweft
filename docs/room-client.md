# Room client architecture

`apps/web/src/features/room/RoomHost.tsx` composes the room page. Room lifetime,
network lifetime and game iframe lifetime have separate owners.

| Module                                             | Responsibility                                                                                    |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `RoomSession`                                      | Entry, initialization, membership, authoritative presence and snapshots, commands and termination |
| `RoomConnection`                                   | Active WebSocket, bounded retries, visibility recovery, heartbeat and latency probes              |
| `useRoomSession`                                   | React subscription and session disposal; current nickname, translations and navigation callbacks  |
| `useRoomGameBridge`                                | Iframe RPC, permission access, state/profile/latency notifications and bridge cancellation        |
| `useRoomControls`                                  | Page dialogs, favorites, copy feedback, start tooltip and orientation actions                     |
| `RoomLobby`, `RoomSeats`, `RoomHeader`             | Lobby presentation and local menu state                                                           |
| `RoomGameView`                                     | Game viewport, frame, information and help                                                        |
| `RoomDialogs`, `RoomPermissions`, `RoomEntryState` | Room confirmations, game permissions and entry states                                             |

## State and entry

The session publishes an immutable state object. Its lifecycle (`entering`,
`joined`, `failed`, `ended`), connection state and server-owned game phase
(`lobby`, `playing`) are independent. A connection failure never implies that
the room was deleted.

Entry creates the platform identity, reads the launch URL and loads the game
manifest. `activate()` initializes and joins the room once per loaded game,
after the orientation gate permits loading. The WebSocket starts after joining.
Games do not need to implement the iframe bridge to participate in a room.

HTTP results and socket presence updates share revision filtering. Snapshots
are ordered by match ID and version and are discarded outside the playing
phase. Returning to the lobby clears the snapshot and advances the frame
revision, so even batched lobby/playing transitions create a fresh iframe.

## Resource lifetimes

Hosts may spectate in the lobby, retain management permissions, and transfer
ownership to either a player or a spectator. Ownership changes and returning
to the lobby preserve seat choices. Only seated players count toward the
starting roster and readiness requirements. Hosts keep an idle heartbeat even
when spectating, so their room is not treated as abandoned while they are online.

- A room route owns one session. Ending or unmounting disposes its connection,
  retry/heartbeat/probe timers, visibility listener and pending live actions.
- Successful leave/dissolve, a missing room on those operations, a server
  dissolution notification and socket close codes `4003` (removed) / `4004`
  (room closed) share one terminal
  path. Navigation happens at most once; unmounting alone does not navigate.
- `ROOM_NOT_FOUND` identifies missing rooms. Older backends remain compatible
  through the exact `404` / `room does not exist` response. Room operations
  during an active session share the terminal path for a confirmed missing
  room, including seat/ready/start, game changes and HTTP game actions.
  Leaving also ends
  the session for `ROOM_MEMBER_NOT_FOUND` or the legacy exact `404` /
  `player is not in this room` response. This exception does not apply to
  dissolving the room. Other 404 errors,
  permission errors and network failures retain the room and show an error.
- Socket callbacks check that their socket is still active before changing any
  timers, state or retry counters. Resuming a disposed session does nothing.
- Returning to the foreground and reconnecting verify room existence through
  the uncached HTTP membership endpoint, which also verifies that the caller
  still belongs to the room without rejoining it. A confirmed missing room
  or missing member ends the session; network, authentication and unrelated
  errors retain recovery.
  Concurrent checks are coalesced, and responses from a previous game or a
  disposed session cannot navigate.
- Changing games invalidates old asynchronous work, reloads configuration and
  joins the new game using the same room connection. No old game response may
  replace the new game's state.
- Refreshing or replacing an iframe only disposes its bridge and pending game
  requests. Returning to the lobby also cancels game permission prompts. Neither
  operation recreates the room connection.
- Bridge handlers read current permission callbacks without reconnecting when
  React rerenders. Own-avatar publication is a session operation, separate from
  the bridge's permission decision.

## Validation

Run `npm run test:room-session` for deterministic lifetime and bridge regression
tests using actual TypeScript modules, fake sockets and a controllable clock.
`npm run check` includes those tests, the existing worker activity/AI cancellation
tests, worker type checking and production builds.

For browser smoke testing, join a local room with two distinct platform
identities, prepare/start, refresh the game, return to the lobby, then leave and
dissolve. The iframe should initialize after refresh, both players should see
the lobby transition, and each termination should return to the homepage.


## Experimental browser host connections

The owner-only Room settings menu exposes two lobby-only choices. `platform`
keeps the existing Worker authority. `local-host` executes the game's existing
Lua script in the browser that starts the match, prefers WebRTC DataChannels,
and automatically falls back to platform WebSocket relay. The choices apply to
Lua room games, without game-specific rules or URL checks. The legacy
`local-relay` mode remains supported for existing rooms and transport tests,
but is no longer offered in the settings UI.

Only the pinned host dynamically imports the Lua runtime and downloads its WASM
when a local match starts. Neither lobby entry nor joining as a player or
spectator loads Lua. The PWA precache also excludes the Lua chunk and WASM.
`GET /api/rooms/:roomId/local-runtime?instanceId=...` authenticates the pinned
host and returns the room's already validated script, script hash and setup
context. Other members obtain only their projected snapshots from that host.
The Worker stores match metadata and manages membership; it does not execute
local setup, actions, departure hooks or timers.

The browser and Worker reuse `@playweft/runtime-lua` and the setup/action
contexts, actor construction, per-viewer projections, timer operations and
quota rules in `@playweft/runtime-core`. Action request IDs remain unchanged
when retried over relay, preventing duplicate execution during a transport
switch. Member departures use the game's `player_left` hook; ownership changes
update `actor.isOwner` and `viewer.isOwner` without moving simulation authority.

The first version uses a star topology with Cloudflare's public STUN server
(`stun:stun.cloudflare.com:3478`) to discover additional direct connection
candidates. No TURN server is configured. A direct connection may fail even on
the same Wi-Fi; relay works while
negotiation is pending and after a channel fails. Relay fallback keeps the same
browser authority and state, rather than starting a second match on the Worker.
The room owner selects the connection method from the lobby menu; the game
view has no floating connection status overlay.

This is an opt-in experiment: the simulation host has the full game state.
Browser timers may run late while backgrounded. Refreshing or closing that
browser loses the local match state; there is no authority migration or restore
in this version. The room owner can return to the lobby to restart even if the
simulation host is unavailable. While the authority is available, returning
checks `on_return_to_room` in that browser; unavailable or faulted authority can
be restarted through room management. Stale cloud state is never used for this
permission check.

For a smoke test, use the built-in Rock Paper Scissors demo with two browser
sessions. Play a round in `local-host`, then interrupt the DataChannel and play
another round over relay; the round and version should continue. No game asset
changes are needed.


### Game latency

`platform.latency` reflects RTT to the selected game authority, not the room
management socket when a browser hosts the game. The pinned local host reports
0; other members use a correlated ping/pong over either DataChannel or the full
platform relay path. Responses remain on the request's path. Host-to-member
health probes never overwrite the host game's local latency. Route switches,
connection loss and sample expiry clear the old reading. The notification adds
`transport` and `status`, omitting `rttMs` while measuring or unavailable.


## Solo entry and room creation

`game-launch-mode.ts` resolves declared capabilities, the optional `auto`/`solo`
Manifest entry preference and explicit URL mode in one place. Library metadata
preserves `launchMode` without changing storage keys or invalidating legacy
entries. Shared solo-first games replace the generic entry with `mode=solo`;
room invites and explicit modes take precedence.

`room-creation.ts` owns the authenticated create-room sequence used by Home and
SoloHost. `SoloRoomCreation` coalesces calls, binds requests to one game, and
invalidates pending work on exit, refresh or bridge replacement. SoloHost
advertises `room.create` only when the loaded Manifest includes a room mode.
The RPC dispatcher posts the result before its internal `afterReply` hook
schedules navigation. App replaces the solo history entry with the created
lobby; the game is mounted in room mode only after starting a new match.
