export type Direction = "up" | "down" | "left" | "right";
export type GamepadAction = Direction | "confirm" | "back" | "context" | "menu";

const STICK_THRESHOLD = 0.55;
const REPEAT_DELAY = 400;
const REPEAT_INTERVAL = 120;
const MENU_HOLD = 500;
const BUTTON_ACTIONS = ["confirm", "back", "context"] as const;

interface ControllerState {
  id: string;
  buttons: boolean[];
  guide?: boolean;
  direction?: Direction;
  repeatAt: number;
  chordStarted?: number;
  chordConsumed: boolean;
}

/** Standard-mapped pads share one action stream; no controller owns navigation. */
export class GamepadInput {
  private controllers = new Map<number, ControllerState>();

  reset(): void {
    this.controllers.clear();
  }

  poll(pads: readonly (Gamepad | null)[], now: number): GamepadAction[] {
    const actions = new Set<GamepadAction>();
    const connected = new Set<number>();
    for (const pad of pads) {
      if (!pad || !pad.connected || pad.mapping !== "standard") continue;
      connected.add(pad.index);
      const buttons = BUTTON_ACTIONS.map((_, index) => pressed(pad, index));
      const direction = readDirection(pad);
      // Some browsers/OSes reserve Guide and never expose button 16.
      const guide = pad.buttons[16]?.pressed;
      const chord = pressed(pad, 8) && pressed(pad, 9);
      let previous = this.controllers.get(pad.index);
      if (!previous || previous.id !== pad.id) {
        // A newly exposed/reconnected device is a baseline, not an activation.
        // Held controls must be released before they can act on the platform.
        previous = {
          id: pad.id,
          buttons,
          guide,
          direction,
          repeatAt: Infinity,
          chordConsumed: chord,
        };
        this.controllers.set(pad.index, previous);
        continue;
      }

      const guidePressed = guide === true && previous.guide === false;
      previous.guide = guide;
      if (guide === true) {
        if (guidePressed) actions.add("menu");
        // Holding the opening button must not repeat or leak confirm/direction
        // into the newly opened dialog. A simultaneous chord is consumed too.
        previous.buttons = buttons;
        previous.direction = direction;
        previous.repeatAt = Infinity;
        previous.chordConsumed = chord;
        previous.chordStarted = undefined;
        continue;
      }

      if (chord) {
        if (!previous.chordConsumed) {
          previous.chordStarted ??= now;
          if (now - previous.chordStarted >= MENU_HOLD) {
            actions.add("menu");
            previous.chordConsumed = true;
          }
        }
        // Do not leak held confirm/direction into a menu when the chord ends.
        previous.buttons = buttons;
        previous.direction = direction;
        previous.repeatAt = Infinity;
        continue;
      }
      previous.chordStarted = undefined;
      previous.chordConsumed = false;

      buttons.forEach((down, index) => {
        if (down && !previous.buttons[index]) actions.add(BUTTON_ACTIONS[index]);
      });
      if (direction !== previous.direction) {
        if (direction) actions.add(direction);
        previous.repeatAt = now + REPEAT_DELAY;
      } else if (direction && now >= previous.repeatAt) {
        actions.add(direction);
        // At most one repeat per animation frame; never catch up after a stall.
        previous.repeatAt = now + REPEAT_INTERVAL;
      }
      previous.buttons = buttons;
      previous.direction = direction;
    }
    for (const index of this.controllers.keys()) {
      if (!connected.has(index)) this.controllers.delete(index);
    }
    // Opening the platform menu must not also activate an item in that frame.
    return actions.has("menu") ? ["menu"] : [...actions];
  }
}

function pressed(pad: Gamepad, index: number): boolean {
  return pad.buttons[index]?.pressed === true;
}

function readDirection(pad: Gamepad): Direction | undefined {
  const axisX = Number.isFinite(pad.axes[0]) ? pad.axes[0] : 0;
  const axisY = Number.isFinite(pad.axes[1]) ? pad.axes[1] : 0;
  // Choose one stick axis, preventing diagonal noise from alternating directions.
  const stickX = Math.abs(axisX) >= STICK_THRESHOLD && Math.abs(axisX) > Math.abs(axisY)
    ? Math.sign(axisX) : 0;
  const stickY = Math.abs(axisY) >= STICK_THRESHOLD && Math.abs(axisY) >= Math.abs(axisX)
    ? Math.sign(axisY) : 0;
  const x = Number(pressed(pad, 15)) - Number(pressed(pad, 14)) + stickX;
  const y = Number(pressed(pad, 13)) - Number(pressed(pad, 12)) + stickY;
  if (Math.abs(y) >= Math.abs(x) && y !== 0) return y < 0 ? "up" : "down";
  if (x !== 0) return x < 0 ? "left" : "right";
  return undefined;
}

export interface FocusRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** Find a visible-layout neighbour, without wrapping to the opposite edge. */
export function findNextFocus(
  rects: readonly FocusRect[],
  current: number,
  direction: Direction,
): number {
  const valid = (rect: FocusRect) => Object.values(rect).every(Number.isFinite)
    && rect.right > rect.left && rect.bottom > rect.top;
  const origin = rects[current];
  if (!origin || !valid(origin)) return rects.findIndex(valid);
  const horizontal = direction === "left" || direction === "right";
  const sign = direction === "left" || direction === "up" ? -1 : 1;
  const x = (origin.left + origin.right) / 2;
  const y = (origin.top + origin.bottom) / 2;
  let next = current;
  let bestScore = Infinity;
  let bestAligned = false;
  rects.forEach((rect, index) => {
    if (index === current || !valid(rect)) return;
    const dx = (rect.left + rect.right) / 2 - x;
    const dy = (rect.top + rect.bottom) / 2 - y;
    const forward = (horizontal ? dx : dy) * sign;
    if (forward <= 0.5) return;
    const aligned = horizontal
      ? rect.top < origin.bottom && rect.bottom > origin.top
      : rect.left < origin.right && rect.right > origin.left;
    const score = forward + Math.abs(horizontal ? dy : dx) * 2;
    if ((aligned && !bestAligned) || (aligned === bestAligned && score < bestScore)) {
      next = index;
      bestScore = score;
      bestAligned = aligned;
    }
  });
  return next;
}
