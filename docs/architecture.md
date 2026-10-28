# Architecture

## Repository layout

```text
apps/web                 React room launcher, invitation host, and local game history
apps/rps-demo            Static Rock-Paper-Scissors example, bundled under /games/rps/
apps/worker              Cloudflare HTTP API, Durable Objects, deployment config
packages/game-protocol   JSON values and wire-message contract shared by both apps
packages/runtime-core    Runtime interface independent of Lua and Cloudflare
packages/runtime-lua     Lua 5.4 implementation of that interface
```

Third-party static-game authors should start with the [integration guide](game-integration/README.md).

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
server-side when a room is created or initialized. Direct game launches do not require Lua execution. After
the `MessagePort` handshake, every bridge message uses JSON-RPC 2.0. The
Durable Object atomically locks the Manifest game ID/version, runtime settings
and source hash: an identical repeat is harmless, while a different package
for an existing room is rejected. The iframe can subsequently
ask to perform a game action, but the Worker derives the user from its session
and maps it to a room-scoped opaque actor ID before invoking Lua. The public
room API deliberately has no CORS policy.

## Web feature modules

The web client separates the game library from game execution:

- `features/library`: game shelves and menus, recommendations, favorites,
  recent games, and stored game URL normalization.
- `features/game`: Manifest discovery and validation, launch links, game
  information and help, iframe RPC, viewport controls, and solo execution.
- `features/home`: homepage layout and coordination of game and room entry,
  including launch choices and unsupported URL feedback.
- `features/room`: room codes, lobby membership, connections, and match
  lifecycle, including the room-specific iframe bridge.

Library and entry UI use the `DiscoveredGame` model from `game-manifest`.
Favorites and recent games keep their existing browser storage keys; moving
their modules does not require a data migration. Shared game information and
help remain in `game` because both the library and running games use them.

## Room cleanup

Durable Object instances may hibernate automatically, but persisted storage is
not removed by hibernation. Each room therefore schedules a one-hour idle
alarm. Creating, opening, initializing, connecting, or acting in a room moves
the expiry forward. When the alarm finds no connected WebSockets and no activity
for an hour, it calls `storage.deleteAll()` and the invite link becomes invalid.

[Back to README](../README.md)
