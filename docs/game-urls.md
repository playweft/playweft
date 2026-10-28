# Game URLs and browser history

`/?game=example.com/demo/` is the shareable game entry. Games open directly by default. `launch_mode: "choose"` explicitly shows the
mode picker for games supporting solo and room play; `"solo"` remains a
compatibility alias for direct launch. Selecting a game on the homepage pushes this entry onto history.
Direct-launch games keep that URL without adding `mode=solo`. For games whose
default is the mode picker, choosing solo replaces the entry with
`/?game=example.com/demo/&mode=solo`;
creating or joining a room from the entry replaces it with `/r/:roomId`.
Entering a room code directly on the homepage pushes the room URL instead.

The homepage input also accepts full room and game-sharing links from the
current `window.location.origin`. Room links join directly; game links keep
their mode and query parameters. Pasting either pushes one history entry.
Other URLs follow the existing game base/Manifest discovery flow.

Refreshing or navigating forward to a solo URL restores solo mode after
checking the Manifest. This restores the mode, not game progress; progress
still depends on the game's own persistence. Older explicit `mode=solo` links
remain valid and are not forcibly rewritten. Game sharing always generates
the generic URL without a mode. Explicit unsupported modes show an error
and the available entry choices without loading a game iframe.

Browser Back returns to the page before the game entry. The platform's solo
exit button and room termination replace the current entry with the homepage.
Pending entry work is invalidated when the URL changes. A game can create a lobby through `playweft.rooms.create()`; legacy manifests
with room support also retain the `room.create` compatibility API.
Successful creation replaces the solo entry with `/r/:roomId`; failures keep
solo play active. Games using the rooms SDK can retain their iframe while creating or leaving
a room. Legacy platform-managed room entry initializes a separate room game.
Solo progress is not automatically copied into a multiplayer match.

Configured [URL aliases](site-configuration.md#url-aliases) replace generated
`/?game=...` links with paths such as `/abc/demo/`. Aliases resolve internally
and preserve the normal mode selection and history behavior.

[Back to README](../README.md)
