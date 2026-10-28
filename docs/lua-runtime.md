# Lua runtime

## Game contract

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

[Back to README](../README.md)
