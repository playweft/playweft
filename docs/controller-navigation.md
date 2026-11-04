# Platform controller navigation

The existing layout supports standard-mapped browser gamepads. Multiple pads
share one focus: there is no primary-controller assignment, local account
switching, or change to room-host/game-player permissions.

- D-pad or left stick moves between controls by their screen positions.
- Within the game library, up/down traverses game rows (including offscreen
  rows) before leaving the library. The selected row scrolls below the sticky
  header; up from the first row can reach the header controls.
- Bottom face button (A / Cross) confirms; right (B / Circle) goes back.
- Left face button (X / Square) opens a focused game's options.
- Press the central Guide / PS / Xbox button to open the platform menu when the
  browser exposes it as standard button 16. It triggers once per press, not while
  held. Some browsers, operating systems, and controllers reserve or omit it.
- Fallback: hold Start + Back (Options + Create/Share) together for half a second.
  The onscreen platform-menu button also remains available. Release the opening
  button(s) before pressing another action.
- Select controls: confirm to adjust, directions to change, confirm/back to
  finish. Text entry still needs a keyboard/touch input; no virtual keyboard is
  included.

Held buttons are not replayed on connection or on returning from a hidden tab.
The first input acquires focus if nothing is selected. Sticks have a 0.55 deadzone;
direction repeats after 400 ms. In the explicitly marked library shelf region,
repeats start at 120 ms, become 80 ms after 1.5 seconds continuously held, and
reach a 60 ms minimum after 3 seconds. D-pad and left stick share this curve;
pushing farther does not alter it. Menus, dialogs, and other controls stay at
120 ms. Each controller tracks its own hold duration. Release, direction change,
or leaving/entering the acceleration region restarts the timing. New scopes,
modals, or views baseline held controls and require release/repress rather than
carrying input onto another screen. Simultaneous controllers
are merged into one shared action per animation frame. Pointer and keyboard
input hide the controller focus styling. Controller focus reuses the existing
keyboard focus styles. A fixed footer shows short, contextual actions with
physical face-button positions, without guessing controller-specific letters.
Its 52 px height (plus safe-area inset) is reserved below page or dialog content;
only the footer opacity and position animate over 180 ms. Pointer movement does
not hide it; pointer presses or keyboard input hide it after a 700 ms grace
period to avoid flicker. The footer is hidden during gameplay and appears inside
the active modal when a platform dialog is open. Reduced-motion preferences
remove the transition.

Once the game iframe has loaded and is visible, the platform focuses it without
scrolling. Closing a platform modal returns focus to the game. Hidden lobby
frames, orientation gates, closing views and background tabs do not receive
focus; focus is handed off on transitions rather than forced every frame.

During gameplay ordinary navigation, confirm, and back are not applied to the
platform. Only the central button or deliberate menu chord is recognized until a
platform dialog is open. When a dialog is already open, the menu action dismisses
it just like Back. **This does not pause a third-party game or prevent it from reading the
same physical controller, nor suppress any OS action assigned to Guide.**
Cross-origin games own their input; a future explicit
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
