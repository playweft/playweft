# Platform HTTP API

These endpoints are used by the trusted platform client. Games should use the
[SDK and iframe bridge](game-integration/README.md), rather than call them directly.

| Request | Purpose |
| --- | --- |
| `POST /api/rooms` | Create a random room with `{ manifestUrl }`; room IDs default to 4-character friendly codes. |
| `GET /api/rooms/:roomId/launch` | Read the exact Manifest URL for the invitation page. |
| `PUT /api/rooms/:roomId/initialize` | Fetch the same-origin `serverUrl` and atomically install its source with the Manifest identity, player limits and persistence mode; repeating the same configuration is safe. |
| `POST /api/rooms/:roomId/join` | Join the room. New arrivals take an available seat in the lobby; when seats are full or the game has started, they join as spectators. Existing members retain their role and seat. |
| `POST /api/rooms/:roomId/seat` | Choose an empty numbered seat with `{ seat }`, or leave a seat to spectate with `{ seat: null }`. The host can also spectate without losing management permissions. |
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
path. The platform can show its unified lobby, or a game can manage its own lobby
through the room SDK. See the [game integration guide](game-integration/README.md).

`game.initialize` exposes the current local profile as `player`, containing the
room actor `id` when applicable and the optional `name`. Room-mode Lua also
receives player names in `setup({ players })` and actor callbacks, so a game can
display the same nickname without trusting iframe-supplied identity.

[Back to README](../README.md)
