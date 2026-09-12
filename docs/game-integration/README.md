# Integrate a Static Game with Playweft

Playweft treats a game as a static, versioned package described by one
Manifest. The platform fetches and validates that Manifest before it executes
the game client in a sandboxed iframe.

The platform owns rooms, identity, the lobby, permissions, networking and
authoritative Lua execution. The game client renders player-specific state and
sends intents over a transferred `MessagePort`.

## 1. Publish a game package

A package contains at least:

```text
my-game/
├── playweft.json
├── index.html
├── icon.svg
└── game.lua
```

When a user enters `https://games.example.com/my-game/`, Playweft fetches
`https://games.example.com/my-game/playweft.json`. A pasted URL whose path ends
in `.json` is treated as an explicit Manifest URL.

The Manifest is fetched by the browser before the iframe opens, so its response
must allow the Playweft origin through CORS, for example:

```http
Access-Control-Allow-Origin: https://play.example.com
```

The Lua entry is fetched server-side by Playweft's Worker and does **not** need
CORS. The Worker requires it to share the Manifest origin, enforces the size
limit, compiles it and locks its source hash in the room. The client entry is
opened as an iframe and also does not need CORS.
Production resources must use HTTPS. Local development may use `http://localhost`
or `http://127.0.0.1`.

## 2. Define `playweft.json`

Manifest v1 strictly validates known fields and their nested structures;
unknown top-level fields are ignored so the format can be extended. The JSON
Schema is
[`game-manifest-v1.schema.json`](game-manifest-v1.schema.json).

```json
{
  "$schema": "https://play.longern.com/schemas/game-manifest-v1.json",
  "manifest_version": 1,
  "id": "/my-game/",
  "version": "1.2.0",
  "protocol": {
    "min": 1,
    "max": 1
  },
  "start_url": "./index.html",
  "name": "My Game",
  "name_localized": {
    "zh-CN": "我的游戏"
  },
  "description": "A short catalogue description.",
  "description_localized": {
    "zh-CN": "用于目录展示的简短介绍。"
  },
  "categories": ["strategy"],
  "icons": [
    {
      "src": "./icon.svg",
      "sizes": "any",
      "type": "image/svg+xml",
      "purpose": "any"
    }
  ],
  "background_color": "#ffffff",
  "theme_color": "#70b967",
  "orientation": "any",
  "help_url": "./help.html",
  "modes": {
    "solo": {},
    "room": {
      "players": {
        "min": 2,
        "max": 4
      },
      "server": {
        "runtime": "lua",
        "entry": "./game.lua",
        "persistence": "durable"
      }
    }
  }
}
```

Key rules:

- `id` is a stable URL identity resolved against the `start_url` origin. It
  must remain on that origin; its fragment is ignored. Use a stable path and do
  not change it between releases of the same game.
- `version` is SemVer. Playweft locks `id`, `version`, Lua source hash, player
  limits and persistence mode when a room initializes.
- `protocol.min/max` is the range of Playweft bridge versions the package
  supports. The current version is `1`.
- Unknown top-level members are ignored. This keeps the format extensible;
  nested members of known objects are still validated strictly.
- `start_url`, `icons[].src`, `help_url` and the Lua `server.entry`
  resolve relative to the Manifest URL and must remain on its origin.
- `name`, `description`, `categories`, `icons`, `background_color`,
  `theme_color` and `orientation` follow Web App Manifest member syntax.
  Localized text uses the standard `name_localized` and
  `description_localized` maps.
- `orientation` is a best-effort preference. Browsers may restrict runtime
  orientation locking to installed or fullscreen contexts. For a concrete
  orientation, Playweft first attempts the lock directly, then enters fullscreen
  and retries only when the browser indicates fullscreen is required.
- Presence of `modes.solo` or `modes.room` determines where the game may run.
- `persistence: "durable"` persists authoritative state after each accepted
  action and permits Durable Object hibernation. `"live"` keeps active state in
  memory and routes actions over the room WebSocket. Live room activity timestamps
  are coalesced to storage at most once per second during continued activity;
  membership, configuration and lifecycle changes are persisted immediately.
  A runtime reset can lose the live match and up to one second of activity timestamps.
- Protected features are requested at runtime and are not declared in the
  Manifest. The platform exposes only capabilities supported by the current
  mode.

The platform limits a Manifest to 64 KiB and a Lua entry to 1 MiB.

## 3. Establish bridge v1

After the browser has validated the Manifest and the Worker has installed any
room server entry, Playweft opens `start_url`. The iframe repeatedly
announces readiness. The platform validates its origin and transfers a
`MessagePort`.

```js
let gamePort;
let ownPlayerId;
let latestMatchId;
let latestVersion = -1;
const pendingRpc = new Map();

const announceReady = () => {
  window.parent.postMessage(
    { type: "playweft:bridge-ready", version: 1 },
    "*",
  );
};

const probe = window.setInterval(announceReady, 500);
announceReady();

window.addEventListener("message", (event) => {
  if (event.source !== window.parent) return;
  if (event.data?.type !== "playweft:bridge" || event.data?.version !== 1) {
    return;
  }
  const [port] = event.ports;
  if (!port) return;

  gamePort = port;
  window.clearInterval(probe);
  gamePort.onmessage = onRpcMessage;
  gamePort.start();

  rpcCall("game.initialize").then((context) => {
    // context.mode is "solo" or "room".
    // Room mode also returns this room-scoped playerId.
    ownPlayerId = context.playerId;
    showWaitingForState();
  }).catch(showRpcError);
});

function rpcCall(method, params) {
  const id = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    pendingRpc.set(id, { resolve, reject });
    gamePort.postMessage({
      jsonrpc: "2.0",
      id,
      method,
      ...(params === undefined ? {} : { params }),
    });
  });
}
```

The window-level messages only transfer the port. Every port message uses
JSON-RPC 2.0. Batch messages are unsupported, and request IDs must be strings
containing 1–128 characters.

`game.initialize` takes no params. It is the only runtime registration call:
the platform has already loaded the package contract. Its result is:

```js
{
  mode: "solo" | "room",
  protocolVersion: 1,
  capabilities: [
    "window.alert",
    "window.confirm",
    "navigator.clipboard.readText",
    "languageModel.prompt",
    "room.players.getProfile",
    "user.getProfile",
  ],
  // room only:
  playerId: "actor_..."
}
```

Room iframes are mounted only after the platform locks the roster. Do not
enable gameplay until the first `game.state` notification arrives.

## 4. Receive state and submit actions

The platform sends:

| Method | Params |
| --- | --- |
| `game.state` | `{ phase, state, events, matchId, version, serverTime }`; state and events have already been projected for this player. |
| `platform.latency` | `{ rttMs }`; the latest platform-to-room round-trip time in whole milliseconds. It is emitted when the platform receives a probe acknowledgement, and may be absent until the first measurement. |
| `platform.error` | `{ error: { code, message, retryable } }` for a failure not tied to an outstanding request. |

```js
function onRpcMessage(event) {
  const message = event.data;
  if (message?.jsonrpc !== "2.0") return;

  if (Object.hasOwn(message, "id")) {
    const pending = pendingRpc.get(message.id);
    if (!pending) return;
    pendingRpc.delete(message.id);
    if (message.error) pending.reject(new PlayweftRpcError(message.error));
    else pending.resolve(message.result);
    return;
  }

  if (message.method === "game.state") {
    const update = message.params;
    if (update.matchId !== latestMatchId) {
      latestMatchId = update.matchId;
      latestVersion = -1;
    }
    if (update.version <= latestVersion) return;
    latestVersion = update.version;
    render(update.state, update.events);
  }

  if (message.method === "platform.latency") {
    updateConnectionIndicator(message.params.rttMs);
  }
}

async function chooseCard(card) {
  const result = await rpcCall("room.action", {
    action: { type: "choose", card },
  });
  if (!result.accepted) showError(result.error.message);
}
```

The JSON-RPC ID also becomes the idempotent server action ID. Reusing it with
different action content is an error. Actions must be JSON-compatible and no
larger than 8 KiB. The platform derives player identity from its HttpOnly
session; identity fields inside actions have no authority.

JSON-RPC failures use standard `-32600` through `-32603` codes. Platform
failures use `-32000` with a stable string code and retry hint in `error.data`.
A game-rule rejection is a successful RPC result with `accepted: false`.

## 5. Request protected features at runtime

The Game Manifest does not declare permissions. The iframe is explicitly
denied direct Async Clipboard access, so a game requests clipboard text only
when it needs it by calling:

```js
const playweft = {
  navigator: {
    clipboard: {
      readText() {
        return rpcCall("navigator.clipboard.readText");
      },
    },
  },
};

const text = await playweft.navigator.clipboard.readText();
```

The platform shows fixed permission UI identifying the game and provider. A
game should explain why it needs clipboard access in its own UI before making
the call. The first approval is remembered per Manifest `id`. Later reads skip
the custom approval prompt but still show a short top-level notice.
Browser-native clipboard UI may still appear.

Platform permissions are scoped to the Manifest `id`, not to an iframe URL or
an individual room. A remembered approval never grants another game access.
For a capability that can incur remote usage, the permission name includes a
policy version. A later, broader policy therefore needs a fresh approval; it
cannot silently reuse an older grant.

The result is limited to 64 KiB. Stable failure codes include `USER_DENIED`,
`REQUEST_EXPIRED`, `NOT_SUPPORTED`, `NOT_ALLOWED`, `TOO_LARGE`, `BUSY`,
`RATE_LIMITED` and `READ_FAILED`.

### Language model

Games can request one bounded text-generation model through the user's own
Cloudflare Workers AI account. The platform never exposes the Cloudflare token
or account ID to the iframe. The first request asks the player for permission;
approval is remembered per Manifest `id` and may incur usage charges on the
selected Cloudflare account.

```js
const playweft = {
  languageModel: {
    prompt(input, options) {
      return rpcCall("languageModel.prompt", { input, options });
    },
  },
};

const reply = await playweft.languageModel.prompt(
  [
    { role: "system", content: "You are a Mahjong teaching assistant." },
    { role: "user", content: "My hand is … What should I discard?" },
  ],
  { maxOutputTokens: 256 },
);
console.log(reply);
```

The platform selects the text model; games cannot pass or inspect a Cloudflare
model identifier. `input` is either a string or 1–16 `system`, `user`, or
`assistant` messages, with at most 16,000 input characters in total. A string
is sent as one `user` message. `options.maxOutputTokens` defaults to 256 and
is capped at 512. The resolved `prompt()` value is the response text.
Streaming, tools, images, and arbitrary model inputs are intentionally
unsupported in v1.

The player must connect Cloudflare, grant optional Workers AI access, and pick
an account in Playweft settings. Stable failure codes include
`CLOUDFLARE_CONNECTION_REQUIRED`, `LANGUAGE_MODEL_UNAVAILABLE`,
`RATE_LIMITED`, and `LANGUAGE_MODEL_FAILED`.

### Room player profiles

A room game may request the game nickname of a player or spectator whose
room-scoped actor ID it already knows. The optional avatar is requested at
runtime through the same call:

```js
const playweft = {
  room: {
    players: {
      getProfile({ playerId, fields }) {
        return rpcCall("room.players.getProfile", { playerId, fields });
      },
    },
  },
};

const profile = await playweft.room.players.getProfile({
  playerId,
  fields: ["name", "avatar"],
});
if (profile.avatar) {
  const image = document.createElement("img");
  image.src = profile.avatar.src;
  image.alt = "";
  playerElement.append(image);
}
```

The result has the same shape as `user.getProfile`: requested available fields
are returned, while an avatar that has not been shared is omitted. The `name`
field is the room member's game nickname and needs no permission. When a
game requests the current player's avatar for the first time, the platform
asks that player whether the game may access it. In a room, approval also
publishes an opaque, temporary room avatar for that player. Approval is
remembered per Manifest `id`; subsequent rooms for the same game do not prompt
again. Players without an account avatar are not prompted.

The game does not ask a viewer to authorize access to somebody else's avatar.
It can only receive avatars that their owners have already shared. `src` is an
opaque, room-scoped Playweft proxy URL; it never reveals the account provider's
image URL. Load it directly in an `img` without setting `crossOrigin`.

The proxy sends no CORS permission and accepts browser image loads only. Games
can display the image but cannot read its response or draw readable pixels
from it through Canvas. The URL is uncacheable and stops resolving when the
member leaves, the room changes game, the room is dissolved, or the room
expires. Stable failure codes include `PLAYER_NOT_FOUND`,
`AVATAR_UNAVAILABLE` and `PROFILE_SHARE_FAILED`.

When a room member's requested profile data may have changed, the platform
sends a `room.players.profileChanged` notification:

```js
onNotification("room.players.profileChanged", ({ playerId, fields }) => {
  // Invalidate only these fields, then request the current profile again.
  void playweft.room.players.getProfile({ playerId, fields });
});
```

The notification contains no profile values or avatar URL. A game should
invalidate its cached fields and call `room.players.getProfile` again. This
also covers avatars being shared or withdrawn and room members joining or
leaving.

### Current player's profile

The platform supplies the player's game nickname as `player.name` from
`game.initialize`. This is a user-selected or randomly generated gaming alias,
not the display name or username of a linked account. Games do not request a
separate nickname permission. Both solo and room games use the same API:

```js
const playweft = {
  user: {
    getProfile({ fields }) {
      return rpcCall("user.getProfile", { fields });
    },
  },
};

const namedProfile = await playweft.user.getProfile({ fields: ["name"] });
console.log(namedProfile.name);
```

A game requests the current player's optional game avatar only when it needs
it:

```js

const profile = await playweft.user.getProfile({ fields: ["avatar"] });
if (profile.avatar) {
  const image = document.createElement("img");
  image.src = profile.avatar.src;
  image.alt = "";
  document.body.append(image);
}
```

Fields can be combined. Only the avatar portion is permission-gated:

```js
const profile = await playweft.user.getProfile({
  fields: ["name", "avatar"],
});
```

The avatar-only result is `{ avatar: { src } }`, or `{}` when the player has no
account avatar. A combined request still returns `{ name }` when no avatar is
available. Avatar approval is remembered per Manifest `id`. `src` is a
Playweft proxy URL containing a ten-minute encrypted token; it does not expose
the account provider or upstream avatar URL. The response is uncacheable,
grants no CORS access and should only be loaded directly into an `img`. Call
`user.getProfile` again after the URL expires. Stable failure codes include
`USER_DENIED`, `REQUEST_EXPIRED`, `PROFILE_UNAVAILABLE`,
`AVATAR_UNAVAILABLE`, `BUSY` and `REQUEST_CANCELLED`.

Avatar approval is shared across modes. A grant obtained here also lets the
same Manifest publish the player's avatar after an avatar API is called in a
room; a grant obtained through the current player's room profile also skips
this prompt. `game.initialize.capabilities` reports which RPC methods the
current mode supports; it does not report or grant user permissions.

## 6. Use platform window dialogs

Native iframe modals remain sandboxed. Playweft exposes asynchronous mappings
of `window.alert()` and `window.confirm()` through platform-controlled UI:

```js
const playweft = {
  window: {
    alert(message = "") {
      return rpcCall("window.alert", { message: String(message) });
    },
    confirm(message = "") {
      return rpcCall("window.confirm", { message: String(message) });
    },
  },
};

await playweft.window.alert("The round has ended.");
if (await playweft.window.confirm("Start another round?")) {
  // Submit the corresponding game action.
}
```

`window.alert` resolves after dismissal. `window.confirm` resolves to `true`
for confirmation and `false` for cancellation, Escape, the Android back action
or backdrop dismissal. Messages are plain text and limited to 2,000
characters. The platform derives and displays the iframe origin; games cannot
provide or override it. Only one platform window dialog may be pending per
game. These capabilities do not require Manifest permission declarations.

## 7. Write the Lua game

The platform compiles the fetched Lua entry while initializing the room.
`setup(context)` runs only when the host starts and locks the seated roster:

```lua
function setup(context)
  return {
    players = context.players,
    match = context.match,
    moves = {},
  }
end

function on_action(state, action, context)
  if action.type ~= "choose" then
    return {
      accepted = false,
      error = {
        code = "INVALID_ACTION",
        message = "Expected a choose action",
      },
    }
  end

  state.moves[context.actor.id] = action.card
  return {
    accepted = true,
    state = state,
    events = {
      { type = "chosen", player = context.actor.id },
    },
  }
end
```

`setup` receives:

```lua
{
  protocolVersion = 1,
  match = {
    id = "match_...",
    ownerId = "actor_...",
    startedAt = 1785123456789,
    randomSeed = "a18c4f092bd771e03aa5c6d9ef104b82",
  },
  players = {
    { id = "actor_...", name = "Alice", seat = 1 },
    { id = "actor_...", seat = 2 },
  },
}
```

Player IDs are opaque and room-scoped. Names are optional presentation data,
never authorization keys. `on_action` receives `{ protocolVersion, matchId,
actionId, actionAt, version, actor }`; actor contains `{ id, role, seat?, name?,
isOwner }`.

`match.randomSeed` is a platform-generated 128-bit random value, encoded as a
fixed 32-character lowercase hexadecimal string. It is regenerated for every
new match. Games may use it to initialize a deterministic PRNG; do not expose
it in player-visible state before the game no longer depends on hidden draws.

An action must explicitly return:

```lua
-- Accepted: persists state and increments version.
{ accepted = true, state = state, events = events }

-- Rejected: state and version do not change.
{
  accepted = false,
  error = { code = "NOT_YOUR_TURN", message = "Wait for the other player" },
}
```

Error codes match `[A-Z][A-Z0-9_]{0,63}` and messages contain 1–500
characters. All values must be JSON-compatible. Lua has no network,
file-system, random, module-loading or debug APIs.

Optional lifecycle hooks:

- `on_player_left(state, context)` may update state after a player disconnects.
- `on_return_to_room(state, context)` returns a boolean allowing or rejecting
  the host's request to dissolve the current match and return to the lobby.

### Project private state for every recipient

Authoritative state and events are never sent directly. Every game defines
`view(state, events, context)`:

```lua
function view(state, events, context)
  local visible_events = {}
  for _, event in ipairs(events) do
    if event.player == nil or event.player == context.viewer.id then
      table.insert(visible_events, event)
    end
  end
  return {
    state = {
      turn = state.turn,
      board = state.board,
      ownHand = state.hands[context.viewer.id],
      opponentCardCounts = state.opponentCardCounts,
    },
    events = visible_events,
  }
end
```

Context is `{ protocolVersion, matchId, version, serverTime, viewer }`.
`viewer` has the same shape as an action actor, including spectator role.
Projection runs independently for every HTTP response, state read, initial
WebSocket snapshot and WebSocket update. Inputs are copies, so mutations in
`view` cannot alter authoritative state or another recipient's view.

## Security boundary

- Fetch and validate the Manifest in the browser, then install the Lua entry
  through the Worker, before opening the iframe.
- Keep all package resources on the Manifest origin.
- Do not call Playweft HTTP or WebSocket APIs from the game. Only use the
  transferred MessagePort.
- Do not implement authentication, room host authority, kicking, readiness,
  seating or game start inside the iframe.
- Do not treat `playerId` as a long-lived identity.
- Do not call `navigator.clipboard.readText()` directly; request it through the
  platform RPC when the feature is needed.
- Do not fetch room avatar proxy URLs. Request a room player profile, then use
  the returned URL only as an image source.
- Do not call native `window.alert()` or `window.confirm()` inside the
  sandbox; await `playweft.window.alert()` or `playweft.window.confirm()`.

See [`apps/rps-demo`](../../apps/rps-demo) for a complete package.
