import { GamepadInput, findNextFocus, type GamepadAction } from "./gamepad-input";

const FOCUSABLE = 'button, a[href], input:not([type="hidden"]), select, textarea, [tabindex]';

export function isNavigable(element: HTMLElement): boolean {
  const style = getComputedStyle(element);
  return element.tabIndex >= 0 && !element.matches(':disabled, [aria-disabled="true"]') &&
    !element.closest('[inert], [hidden], [aria-hidden="true"]') &&
    !element.matches('[class*="backdrop"]') && style.visibility !== "hidden" &&
    style.display !== "none" && element.getClientRects().length > 0;
}

export function navigationScope(): HTMLElement {
  // Native modal dialogs make the rest of the document inert. Never escape them.
  const modal = Array.from(document.querySelectorAll<HTMLDialogElement>('dialog[open]')).at(-1);
  const root = modal ?? document.body;
  return Array.from(root.querySelectorAll<HTMLElement>('[data-gamepad-scope]'))
    .filter(element => element.getClientRects().length > 0).at(-1) ?? root;
}

export interface GamepadHints {
  container: HTMLElement;
  playing: boolean;
  options: boolean;
  back: boolean;
  editing: boolean;
}

export function startGamepadNavigation(
  onActivity?: (active: boolean) => void,
  onHints?: (hints: GamepadHints) => void,
): () => void {
  const input = new GamepadInput();
  let frame = 0;
  let active = false;
  let editing: HTMLSelectElement | undefined;
  let lastCard: string | undefined;
  let previousScope: HTMLElement = document.body;
  let previousFocus: HTMLElement | undefined;
  const returnFocus = new WeakMap<HTMLElement, HTMLElement>();
  let gameWasRunning = false;
  let previousView: HTMLElement | undefined;
  let previousViewState: string | undefined;
  let previousGameFrame: Element | null = null;
  let previousHints: GamepadHints | undefined;
  let focusedGameFrame: HTMLElement | undefined;
  let highlightedElement: HTMLElement | undefined;

  const clearHighlight = () => {
    highlightedElement?.classList.remove("gamepad-focus");
    highlightedElement = undefined;
  };
  const syncHighlight = () => {
    const element = document.activeElement;
    const next = active && document.visibilityState === "visible" && document.hasFocus() &&
      element instanceof HTMLElement && element !== document.body ? element : undefined;
    if (next === highlightedElement && (!next || next.classList.contains("gamepad-focus"))) return;
    clearHighlight();
    next?.classList.add("gamepad-focus");
    highlightedElement = next;
  };

  const focus = (element: HTMLElement) => {
    element.focus({ preventScroll: true });
    // Menus close on viewport scroll; they are already positioned onscreen.
    if (!element.closest('.menu')) element.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "instant" });
  };
  const setActive = (next: boolean) => {
    if (active === next) return;
    active = next;
    document.documentElement.classList.toggle("gamepad-navigation", next);
    syncHighlight();
    onActivity?.(next);
  };
  const pointer = () => { editing = undefined; setActive(false); };
  const reset = () => { input.reset(); editing = undefined; focusedGameFrame = undefined; clearHighlight(); };
  const closeScope = (scope: HTMLElement) => {
    editing = undefined;
    if (scope.matches('dialog[open]')) {
      scope.dispatchEvent(new Event("cancel", { cancelable: true }));
    } else if (scope.matches('[data-gamepad-scope]')) {
      const back = Array.from(scope.querySelectorAll<HTMLElement>('[data-gamepad-back]')).find(isNavigable);
      if (back) back.click();
      else scope.dispatchEvent(new Event("gamepadback"));
    } else {
      const back = Array.from(scope.querySelectorAll<HTMLElement>('[data-gamepad-back]')).find(isNavigable);
      back?.click();
    }
  };
  const act = (action: GamepadAction) => {
    const scope = navigationScope();
    if (scope.matches('[class*="closing"], [data-gamepad-closing="true"]')) return;
    const game = document.querySelector<HTMLIFrameElement>('.game-frame');
    const gate = document.querySelector('.game-orientation-gate');
    // During gameplay only Guide (when exposed) or the Start+Back hold opens the host menu.
    // Games may still independently poll controllers; this does not pause them.
    if (game && scope === document.body && !gate) {
      if (action === "menu") {
        const button = document.querySelector<HTMLButtonElement>('.platform-menu-button');
        if (button && isNavigable(button)) { focus(button); button.click(); }
      }
      return;
    }
    const candidates = Array.from(scope.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(isNavigable);
    let current = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    if (editing && (current !== editing || !candidates.includes(editing))) editing = undefined;
    if (action === "back" || action === "menu") {
      if (editing) { editing = undefined; return; }
      closeScope(scope);
      return;
    }
    if (!current || !candidates.includes(current)) {
      current = candidates.find(element => element.dataset.gamepadFocusId === lastCard) ?? candidates[0];
      if (!current) return;
      focus(current);
      // First input acquires focus rather than accidentally launching something.
      return;
    }
    if (editing && ["up", "down", "left", "right"].includes(action)) {
      const delta = action === "up" || action === "left" ? -1 : 1;
      let index = editing.selectedIndex + delta;
      while (index >= 0 && index < editing.options.length && editing.options[index].disabled) index += delta;
      if (index >= 0 && index < editing.options.length) {
        editing.selectedIndex = index;
        editing.dispatchEvent(new Event("change", { bubbles: true }));
      }
    } else if (action === "confirm") {
      if (current instanceof HTMLSelectElement) editing = editing ? undefined : current;
      else current.click();
    } else if (action === "context") {
      if (current.matches('[data-gamepad-context]')) {
        const rect = current.getBoundingClientRect();
        current.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2 }));
      }
    } else if (action === "up" || action === "down" || action === "left" || action === "right") {
      // A sticky header can be closer on screen than the preceding offscreen
      // row. Traverse the library before considering controls outside it.
      const library = current.closest('[data-gamepad-library]');
      if (library && (action === "up" || action === "down")) {
        const cards = candidates.filter(element => library.contains(element));
        const currentIndex = cards.indexOf(current);
        const next = findNextFocus(cards.map(element => element.getBoundingClientRect()), currentIndex, action);
        if (next >= 0 && next !== currentIndex) {
          focus(cards[next]);
          return;
        }
      }
      const index = findNextFocus(candidates.map(element => element.getBoundingClientRect()), candidates.indexOf(current), action);
      if (index >= 0) focus(candidates[index]);
    }
  };
  const tick = (time: number) => {
    frame = requestAnimationFrame(tick);
    if (document.visibilityState !== "visible" || !document.hasFocus()) { reset(); return; }
    let pads: (Gamepad | null)[];
    try { pads = Array.from(navigator.getGamepads?.() ?? []); } catch { reset(); return; }
    if (!pads.some(pad => pad?.connected && pad.mapping === "standard")) setActive(false);
    const scope = navigationScope();
    const view = Array.from(document.querySelectorAll<HTMLElement>('[data-gamepad-view]'))
      .filter(element => !element.closest('[inert], [hidden], [aria-hidden="true"]') && element.getClientRects().length > 0).at(-1);
    const gameFrame = document.querySelector<HTMLElement>('.game-frame');
    if (scope !== previousScope || view !== previousView || view?.dataset.gamepadView !== previousViewState || gameFrame !== previousGameFrame) {
      // A new modal/view must never inherit a held movement or confirmation.
      // Baseline the current buttons; release/repress starts a fresh hold.
      input.reset();
      editing = undefined;
    }
    previousView = view;
    previousViewState = view?.dataset.gamepadView;
    previousGameFrame = gameFrame;
    if (scope !== previousScope) {
      if (scope !== document.body && previousFocus) returnFocus.set(scope, previousFocus);
      const restore = returnFocus.get(previousScope);
      if (active && restore?.isConnected && scope.contains(restore) && isNavigable(restore)) focus(restore);
      previousScope = scope;
      editing = undefined;
    }
    // Hand off once the loaded game is actually available, and again after a
    // platform modal/lobby/gate closes. Do not refocus every frame: the game
    // must be free to manage its own input focus.
    const playableFrame = scope === document.body && gameFrame?.matches('.is-loaded') &&
      isNavigable(gameFrame) && !document.querySelector('.game-orientation-gate')
      ? gameFrame : undefined;
    if (playableFrame && playableFrame !== focusedGameFrame) {
      playableFrame.focus({ preventScroll: true });
    }
    focusedGameFrame = playableFrame;
    const gameRunning = Boolean(gameFrame);
    if (active && gameWasRunning && !gameRunning && scope === document.body && lastCard) {
      const card = Array.from(document.querySelectorAll<HTMLElement>('[data-gamepad-focus-id]')).find(element => element.dataset.gamepadFocusId === lastCard && isNavigable(element));
      if (card) focus(card);
    }
    gameWasRunning = gameRunning;
    const focusedElement = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    // An explicit library region opts in; short menus and all dialogs stay slow.
    const accelerate = scope === document.body && !gameRunning && Boolean(focusedElement?.closest('[data-gamepad-library]'));
    const actions = input.poll(pads, time, accelerate);
    for (const action of actions) {
      setActive(true);
      act(action);
      // One shared operation per frame prevents simultaneous controllers opening
      // and immediately confirming a newly mounted dialog.
      break;
    }
    previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    syncHighlight();
    if (previousFocus?.dataset.gamepadFocusId) lastCard = previousFocus.dataset.gamepadFocusId;
    if (onHints) {
      const currentScope = navigationScope();
      const container = currentScope.closest<HTMLElement>('dialog[open]') ?? document.body;
      const hints: GamepadHints = {
        container,
        playing: Boolean(document.querySelector('.game-frame')) && currentScope === document.body && !document.querySelector('.game-orientation-gate'),
        options: Boolean(previousFocus?.matches('[data-gamepad-context]')),
        back: currentScope !== document.body || Array.from(currentScope.querySelectorAll<HTMLElement>('[data-gamepad-back]')).some(isNavigable),
        editing: Boolean(editing),
      };
      if (!previousHints || Object.keys(hints).some(key => hints[key as keyof GamepadHints] !== previousHints![key as keyof GamepadHints])) {
        previousHints = hints;
        onHints(hints);
      }
    }
  };
  window.addEventListener("pointerdown", pointer, true);
  window.addEventListener("keydown", pointer, true);
  window.addEventListener("blur", reset);
  document.addEventListener("visibilitychange", reset);
  document.addEventListener("focusin", syncHighlight);
  document.addEventListener("focusout", clearHighlight);
  frame = requestAnimationFrame(tick);
  return () => {
    cancelAnimationFrame(frame);
    window.removeEventListener("pointerdown", pointer, true);
    window.removeEventListener("keydown", pointer, true);
    window.removeEventListener("blur", reset);
    document.removeEventListener("visibilitychange", reset);
    document.removeEventListener("focusin", syncHighlight);
    document.removeEventListener("focusout", clearHighlight);
    clearHighlight();
    document.documentElement.classList.remove("gamepad-navigation");
  };
}
