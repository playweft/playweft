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

- A room route owns one session. Ending or unmounting disposes its connection,
  retry/heartbeat/probe timers, visibility listener and pending live actions.
- Successful leave/dissolve, a missing room on those operations, a server
  dissolution notification and socket close code `4004` share one terminal
  path. Navigation happens at most once; unmounting alone does not navigate.
- `ROOM_NOT_FOUND` identifies missing rooms. Older backends remain compatible
  through the exact `404` / `room does not exist` response. Other 404 errors,
  permission errors and network failures retain the room and show an error.
- Socket callbacks check that their socket is still active before changing any
  timers, state or retry counters. Resuming a disposed session does nothing.
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
