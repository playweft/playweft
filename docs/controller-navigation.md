# Platform controller navigation

The existing layout supports standard-mapped browser gamepads. Multiple pads
share one focus: there is no primary-controller assignment, local account
switching, or change to room-host/game-player permissions.

- D-pad or left stick moves between controls by their screen positions.
- Bottom face button (A / Cross) confirms; right (B / Circle) goes back.
- Left face button (X / Square) opens a focused game's options.
- Hold Start + Back (Options + Create/Share) together for half a second to open
  the platform menu while a game runs. Release before pressing another action.
- Select controls: confirm to adjust, directions to change, confirm/back to
  finish. Text entry still needs a keyboard/touch input; no virtual keyboard is
  included.

Held buttons are not replayed on connection or on returning from a hidden tab.
The first input acquires focus if nothing is selected. Sticks have a 0.55 deadzone;
direction repeats after 400 ms and then every 120 ms. Simultaneous controllers
are merged into one shared action per animation frame. Pointer and keyboard
input hide the controller focus styling without changing layout.

During gameplay ordinary navigation, confirm, and back are not applied to the
platform. Only the deliberate menu chord is recognized until a platform dialog
is open. **This does not pause a third-party game or prevent it from reading the
same physical controller.** Cross-origin games own their input; a future explicit
SDK input-ownership/pause contract is required for that guarantee. No game code
or iframe security permissions are changed in this first version.

Browser support, controller mapping, and reserved OS shortcuts vary. Unmapped
controllers are ignored instead of guessing button identities. Gamepad activation
does not guarantee browser transient user activation: fullscreen, clipboard,
and other browser-gated operations retain their existing permission/failure
behavior. No TV detection, big-screen layout, or automatic fullscreen is added.

## Verification

Run `npm run check`. Tests cover input state, deadzone/repeat behavior, two-pad
sharing, reconnects, menu chords, and spatial navigation. Before release, test
with physical Xbox/PlayStation controllers: browse, open/close options and nested
dialogs, enter a room, open a game's platform menu, exit and return to the original
game card, then repeat using two pads and mouse/touch. Verify the actual game does
not take unintended actions while its platform menu is used.
