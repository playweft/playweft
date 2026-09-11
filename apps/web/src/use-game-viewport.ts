import { useCallback, useEffect, useRef, useState } from "react";
import type { GameManifestOrientation } from "@playweft/game-protocol";

const GAME_RUNNING_CLASS = "game-running";
const DEFAULT_GAME_BACKGROUND_COLOR = "#ffffff";
const DEFAULT_GAME_THEME_COLOR = "#70b967";
const WHITE = { red: 255, green: 255, blue: 255 };

interface RgbColor {
  red: number;
  green: number;
  blue: number;
}

export interface GameViewportPreferences {
  backgroundColor?: string;
  themeColor?: string;
  orientation?: GameManifestOrientation;
}

interface LockableScreenOrientation extends ScreenOrientation {
  lock?(orientation: GameManifestOrientation): Promise<void>;
}

export interface GameViewportController {
  orientationAction?: "enter" | "restore" | "unsupported" | "wechat";
  showFullscreenAction: boolean;
  showLandscapeCompatibility: boolean;
  deferGameLoad: boolean;
  landscapeCompatibilityRotation?: LandscapeCompatibilityRotation;
  enterPreferredOrientation(): Promise<void>;
  enableLandscapeCompatibility(): void;
}

type OrientationLockResult =
  | "locked"
  | "failed"
  | "unsupported"
  | "requires-fullscreen";

let pendingGameOrientation: Promise<OrientationLockResult> | undefined;
let gameFullscreenOwned = false;
let gameOrientationLockOwned = false;
let gameOrientationLockUnsupported = false;

function preferredOrientation(
  orientation: GameManifestOrientation | undefined,
): orientation is Exclude<GameManifestOrientation, "any"> {
  return Boolean(orientation && orientation !== "any");
}

function landscapeOrientation(
  orientation: GameManifestOrientation | undefined,
): boolean {
  return Boolean(orientation?.startsWith("landscape"));
}

export type LandscapeCompatibilityRotation = "-90deg" | "90deg";

const LANDSCAPE_COMPATIBILITY_SWITCH_THRESHOLD = 0.55;
const LANDSCAPE_COMPATIBILITY_SETTLE_MS = 180;
const LANDSCAPE_COMPATIBILITY_COOLDOWN_MS = 250;
const FULLSCREEN_ORIENTATION_SETTLE_MS = 500;

function landscapeCompatibilityRotationFromGamma(
  gamma: number | null,
): LandscapeCompatibilityRotation | undefined {
  // This is only a fallback for browsers that do not expose gravity data.
  // Gamma is an Euler angle and becomes ambiguous while the phone is pitched.
  if (gamma === null || Math.abs(gamma) < 55) return undefined;
  return gamma > 0 ? "90deg" : "-90deg";
}

function landscapeCompatibilityRotationFromGravity(
  gravity: DeviceMotionEventAcceleration | null,
): LandscapeCompatibilityRotation | undefined {
  if (
    !gravity ||
    gravity.x === null ||
    gravity.y === null ||
    gravity.z === null
  ) {
    return undefined;
  }
  const magnitude = Math.hypot(gravity.x, gravity.y, gravity.z);
  if (magnitude < 1) return undefined;

  // The direction of gravity along the phone's left/right axis stays stable
  // when the screen is tipped towards or away from the user. It is therefore
  // a more reliable landscape-side signal than gamma alone.
  const horizontalGravity = gravity.x / magnitude;
  if (
    Math.abs(horizontalGravity) < LANDSCAPE_COMPATIBILITY_SWITCH_THRESHOLD
  ) {
    return undefined;
  }
  return horizontalGravity > 0 ? "90deg" : "-90deg";
}

function matchesPreferredOrientation(
  orientation: Exclude<GameManifestOrientation, "any">,
): boolean {
  return landscapeOrientation(orientation)
    ? window.matchMedia("(orientation: landscape)").matches
    : window.matchMedia("(orientation: portrait)").matches;
}

function lockableOrientation(): LockableScreenOrientation | undefined {
  return screen.orientation as LockableScreenOrientation | undefined;
}

function supportsMobileOrientationLock(): boolean {
  return Boolean(
    lockableOrientation()?.lock &&
    (navigator.maxTouchPoints > 0 ||
      window.matchMedia("(pointer: coarse)").matches),
  );
}

function isWeChatInAppBrowser(): boolean {
  return (
    /MicroMessenger\//i.test(navigator.userAgent) &&
    (navigator.maxTouchPoints > 0 ||
      window.matchMedia("(pointer: coarse)").matches)
  );
}

function needsWeChatLandscapeGuidance(
  orientation: Exclude<GameManifestOrientation, "any">,
): boolean {
  return (
    isWeChatInAppBrowser() &&
    landscapeOrientation(orientation) &&
    !matchesPreferredOrientation(orientation)
  );
}

export function shouldShowWeChatLandscapeGuidance(
  orientation: GameManifestOrientation | undefined,
): boolean {
  return (
    preferredOrientation(orientation) &&
    needsWeChatLandscapeGuidance(orientation)
  );
}

function supportsFullscreenOrientationFallback(): boolean {
  // Mi Browser rotates a fullscreen page natively, while exposing a lock()
  // method that consistently rejects with NotSupportedError. Do not apply this
  // fallback broadly: some in-app browsers reject the API and mishandle the
  // fullscreen transition itself.
  return /XiaoMi\/MiuiBrowser\//i.test(navigator.userAgent);
}

function waitForFullscreenPreferredOrientation(
  orientation: Exclude<GameManifestOrientation, "any">,
): Promise<boolean> {
  if (
    document.fullscreenElement === document.documentElement &&
    matchesPreferredOrientation(orientation)
  ) {
    return Promise.resolve(true);
  }
  return new Promise((resolve) => {
    const query = window.matchMedia(
      landscapeOrientation(orientation)
        ? "(orientation: landscape)"
        : "(orientation: portrait)",
    );
    let settled = false;
    const finish = (matches: boolean) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timeout);
      document.removeEventListener("fullscreenchange", check);
      query.removeEventListener("change", check);
      screen.orientation?.removeEventListener("change", check);
      resolve(matches);
    };
    const check = () => {
      const fullscreen =
        document.fullscreenElement === document.documentElement;
      if (!fullscreen || matchesPreferredOrientation(orientation)) {
        finish(fullscreen && matchesPreferredOrientation(orientation));
      }
    };
    const timeout = window.setTimeout(() => {
      finish(
        document.fullscreenElement === document.documentElement &&
          matchesPreferredOrientation(orientation),
      );
    }, FULLSCREEN_ORIENTATION_SETTLE_MS);
    document.addEventListener("fullscreenchange", check);
    query.addEventListener("change", check);
    screen.orientation?.addEventListener("change", check);
    check();
  });
}

function renderedColor(value: string, backdrop: RgbColor): RgbColor {
  const canvas = document.createElement("canvas");
  canvas.width = 1;
  canvas.height = 1;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) return backdrop;
  context.clearRect(0, 0, 1, 1);
  context.fillStyle = value;
  context.fillRect(0, 0, 1, 1);
  const [red, green, blue, alphaByte] = context.getImageData(0, 0, 1, 1).data;
  const alpha = alphaByte / 255;
  return {
    red: red * alpha + backdrop.red * (1 - alpha),
    green: green * alpha + backdrop.green * (1 - alpha),
    blue: blue * alpha + backdrop.blue * (1 - alpha),
  };
}

function relativeLuminance({ red, green, blue }: RgbColor): number {
  const linear = (component: number) => {
    const value = component / 255;
    return value <= 0.04045
      ? value / 12.92
      : Math.pow((value + 0.055) / 1.055, 2.4);
  };
  return linear(red) * 0.2126 + linear(green) * 0.7152 + linear(blue) * 0.0722;
}

function contrastingTextColor(background: RgbColor): "#000000" | "#ffffff" {
  const luminance = relativeLuminance(background);
  const blackContrast = (luminance + 0.05) / 0.05;
  const whiteContrast = 1.05 / (luminance + 0.05);
  return blackContrast >= whiteContrast ? "#000000" : "#ffffff";
}

async function lockGameOrientation(
  orientation: Exclude<GameManifestOrientation, "any">,
): Promise<OrientationLockResult> {
  const screenOrientation = lockableOrientation();
  if (!screenOrientation?.lock) return "failed";
  try {
    await screenOrientation.lock(orientation);
    gameOrientationLockOwned = true;
    return "locked";
  } catch (error) {
    console.warn(`Could not lock game orientation to ${orientation}`, error);
    if (
      typeof error === "object" &&
      error !== null &&
      "name" in error &&
      error.name === "NotSupportedError"
    ) {
      if (supportsFullscreenOrientationFallback()) {
        if (
          document.fullscreenElement === document.documentElement &&
          (await waitForFullscreenPreferredOrientation(orientation))
        ) {
          return "locked";
        }
        if (!document.fullscreenElement) return "requires-fullscreen";
      }
      gameOrientationLockUnsupported = true;
      return "unsupported";
    }
    if (
      typeof error === "object" &&
      error !== null &&
      "name" in error &&
      error.name === "SecurityError" &&
      !document.fullscreenElement
    ) {
      return "requires-fullscreen";
    }
    return "failed";
  }
}

function supportsGameFullscreen(): boolean {
  return typeof document.documentElement.requestFullscreen === "function";
}

async function enterGameFullscreen(): Promise<boolean> {
  if (document.fullscreenElement === document.documentElement) return true;
  const requestFullscreen = document.documentElement.requestFullscreen;
  if (!requestFullscreen) return false;
  try {
    await requestFullscreen.call(document.documentElement);
    gameFullscreenOwned =
      document.fullscreenElement === document.documentElement;
    return gameFullscreenOwned;
  } catch (error) {
    console.warn("Could not enter fullscreen for game orientation", error);
    return false;
  }
}

export function prepareGameOrientation(
  orientation: GameManifestOrientation | undefined,
): Promise<OrientationLockResult> {
  if (!preferredOrientation(orientation) || !supportsMobileOrientationLock()) {
    return Promise.resolve("failed");
  }
  // WeChat exposes screen.orientation.lock(), but its Android webview rejects
  // it even after fullscreen. Do not make an optimistic fullscreen attempt:
  // the viewport hook presents its browser-open guidance instead.
  if (shouldShowWeChatLandscapeGuidance(orientation)) {
    return Promise.resolve("unsupported");
  }
  if (gameOrientationLockUnsupported) return Promise.resolve("unsupported");
  if (pendingGameOrientation) return pendingGameOrientation;
  const attempt = (async () => {
    const initialResult = await lockGameOrientation(orientation);
    if (initialResult !== "requires-fullscreen") return initialResult;
    if (!(await enterGameFullscreen())) return "failed";
    return lockGameOrientation(orientation);
  })();
  const pending = attempt.finally(() => {
    if (pendingGameOrientation === pending) {
      pendingGameOrientation = undefined;
    }
  });
  pendingGameOrientation = pending;
  return pending;
}

export async function releaseGameFullscreen(): Promise<void> {
  gameOrientationLockUnsupported = false;
  if (gameOrientationLockOwned) {
    gameOrientationLockOwned = false;
    lockableOrientation()?.unlock();
  }
  if (
    !gameFullscreenOwned ||
    document.fullscreenElement !== document.documentElement
  ) {
    gameFullscreenOwned = false;
    return;
  }
  gameFullscreenOwned = false;
  try {
    await document.exitFullscreen();
  } catch (error) {
    console.warn("Could not exit game fullscreen", error);
  }
}

export function useGameViewport(
  active: boolean,
  preferences?: GameViewportPreferences,
): GameViewportController {
  const [orientationAction, setOrientationAction] = useState<
    "enter" | "restore" | "unsupported" | "wechat"
  >();
  const [showFullscreenAction, setShowFullscreenAction] = useState(false);
  const [orientationLockUnsupported, setOrientationLockUnsupported] =
    useState(false);
  const [landscapeCompatibility, setLandscapeCompatibility] = useState(false);
  const [landscapeCompatibilityRotation, setLandscapeCompatibilityRotation] =
    useState<LandscapeCompatibilityRotation>();
  const [viewportLandscape, setViewportLandscape] = useState(() =>
    window.matchMedia("(orientation: landscape)").matches,
  );
  const orientationEffectGeneration = useRef(0);

  useEffect(() => {
    const query = window.matchMedia("(orientation: landscape)");
    const updateViewportOrientation = () => setViewportLandscape(query.matches);
    updateViewportOrientation();
    query.addEventListener("change", updateViewportOrientation);
    return () => query.removeEventListener("change", updateViewportOrientation);
  }, []);
  useEffect(() => {
    if (!active) return;
    const scrollX = window.scrollX;
    const scrollY = window.scrollY;
    document.documentElement.style.setProperty(
      "--game-scroll-x",
      `${scrollX}px`,
    );
    document.documentElement.style.setProperty(
      "--game-scroll-y",
      `${scrollY}px`,
    );
    document.documentElement.classList.add(GAME_RUNNING_CLASS);
    return () => {
      document.documentElement.classList.remove(GAME_RUNNING_CLASS);
      document.documentElement.style.removeProperty("--game-scroll-x");
      document.documentElement.style.removeProperty("--game-scroll-y");
      window.scrollTo(scrollX, scrollY);
    };
  }, [active]);

  useEffect(() => {
    if (!active) return;
    const root = document.documentElement;
    const themeMeta = document.querySelector<HTMLMetaElement>(
      'meta[name="theme-color"]',
    );
    const previousThemeColor = themeMeta
      ? themeMeta.getAttribute("content")
      : null;
    const backgroundValue =
      preferences?.backgroundColor ?? DEFAULT_GAME_BACKGROUND_COLOR;
    const themeValue = preferences?.themeColor ?? DEFAULT_GAME_THEME_COLOR;
    const renderedBackground = renderedColor(backgroundValue, WHITE);
    const renderedTheme = renderedColor(themeValue, renderedBackground);
    root.style.setProperty(
      "--game-foreground-color",
      contrastingTextColor(renderedBackground),
    );
    root.style.setProperty(
      "--game-on-theme-color",
      contrastingTextColor(renderedTheme),
    );
    if (preferences?.backgroundColor) {
      root.style.setProperty(
        "--game-background-color",
        preferences.backgroundColor,
      );
    }
    if (preferences?.themeColor) {
      root.style.setProperty("--game-theme-color", preferences.themeColor);
      themeMeta?.setAttribute("content", preferences.themeColor);
    }
    return () => {
      root.style.removeProperty("--game-background-color");
      root.style.removeProperty("--game-foreground-color");
      root.style.removeProperty("--game-theme-color");
      root.style.removeProperty("--game-on-theme-color");
      if (themeMeta) {
        if (previousThemeColor === null) themeMeta.removeAttribute("content");
        else themeMeta.setAttribute("content", previousThemeColor);
      }
    };
  }, [active, preferences?.backgroundColor, preferences?.themeColor]);

  useEffect(() => {
    if (!active || !landscapeCompatibility || viewportLandscape) {
      if (landscapeCompatibility && viewportLandscape) {
        setLandscapeCompatibility(false);
        setLandscapeCompatibilityRotation(undefined);
      }
      return;
    }
    let currentRotation: LandscapeCompatibilityRotation = "90deg";
    let pendingRotation: LandscapeCompatibilityRotation | undefined;
    let pendingSince = 0;
    let lastRotationChange = 0;
    let hasGravityData = false;

    const applyRotationCandidate = (
      candidate: LandscapeCompatibilityRotation | undefined,
    ) => {
      if (!candidate || candidate === currentRotation) {
        pendingRotation = undefined;
        return;
      }

      const now = performance.now();
      if (candidate !== pendingRotation) {
        pendingRotation = candidate;
        pendingSince = now;
        return;
      }
      if (
        now - pendingSince < LANDSCAPE_COMPATIBILITY_SETTLE_MS ||
        now - lastRotationChange < LANDSCAPE_COMPATIBILITY_COOLDOWN_MS
      ) {
        return;
      }

      currentRotation = candidate;
      pendingRotation = undefined;
      lastRotationChange = now;
      setLandscapeCompatibilityRotation(currentRotation);
    };

    const updateRotation = (event: DeviceOrientationEvent) => {
      if (hasGravityData) return;
      applyRotationCandidate(
        landscapeCompatibilityRotationFromGamma(event.gamma),
      );
    };
    const updateRotationFromGravity = (event: DeviceMotionEvent) => {
      const candidate = landscapeCompatibilityRotationFromGravity(
        event.accelerationIncludingGravity,
      );
      if (!candidate) return;
      hasGravityData = true;
      applyRotationCandidate(candidate);
    };
    setLandscapeCompatibilityRotation(currentRotation);
    window.addEventListener("deviceorientation", updateRotation);
    window.addEventListener("devicemotion", updateRotationFromGravity);
    return () => {
      window.removeEventListener("deviceorientation", updateRotation);
      window.removeEventListener("devicemotion", updateRotationFromGravity);
    };
  }, [active, landscapeCompatibility, viewportLandscape]);

  const enableLandscapeCompatibility = useCallback(() => {
    if (!landscapeOrientation(preferences?.orientation)) return;
    setLandscapeCompatibility(true);
    setLandscapeCompatibilityRotation("90deg");
    setOrientationAction(undefined);
    setShowFullscreenAction(false);
  }, [preferences?.orientation]);

  const enterPreferredOrientation = useCallback(async () => {
    const preference = preferences?.orientation;
    if (!preferredOrientation(preference)) {
      setOrientationAction(undefined);
      setShowFullscreenAction(false);
      return;
    }
    if (orientationLockUnsupported || gameOrientationLockUnsupported) {
      setOrientationAction("unsupported");
      setShowFullscreenAction(false);
      return;
    }
    if (supportsMobileOrientationLock()) {
      const result = await prepareGameOrientation(preference);
      if (result === "unsupported") {
        setOrientationLockUnsupported(true);
        await releaseGameFullscreen();
        setOrientationAction("unsupported");
        setShowFullscreenAction(false);
        return;
      }
    } else {
      await enterGameFullscreen();
    }
    const orientationMatches = matchesPreferredOrientation(preference);
    setOrientationAction(
      supportsMobileOrientationLock() && !orientationMatches
        ? "restore"
        : undefined,
    );
    setShowFullscreenAction(
      landscapeOrientation(preference) &&
        orientationMatches &&
        document.fullscreenElement !== document.documentElement &&
        supportsGameFullscreen(),
    );
  }, [orientationLockUnsupported, preferences?.orientation]);

  useEffect(() => {
    const preference = preferences?.orientation;
    setOrientationAction(undefined);
    setShowFullscreenAction(false);
    if (!active || !preferredOrientation(preference)) {
      setOrientationLockUnsupported(false);
      setLandscapeCompatibility(false);
      setLandscapeCompatibilityRotation(undefined);
      return;
    }
    // Compatibility mode is an explicit fallback chosen by the player. It
    // owns orientation for the rest of this game session, so returning from
    // the background must not retry the native lock and replace the game with
    // its unsupported-browser gate.
    if (landscapeCompatibility) return;
    if (isWeChatInAppBrowser() && landscapeOrientation(preference)) {
      const query = window.matchMedia("(orientation: landscape)");
      const updateWeChatGuidance = () => {
        setOrientationAction(
          matchesPreferredOrientation(preference) ? undefined : "wechat",
        );
        setShowFullscreenAction(false);
      };
      updateWeChatGuidance();
      query.addEventListener("change", updateWeChatGuidance);
      return () => query.removeEventListener("change", updateWeChatGuidance);
    }
    if (orientationLockUnsupported || gameOrientationLockUnsupported) {
      setOrientationLockUnsupported(true);
      setOrientationAction("unsupported");
      void releaseGameFullscreen();
      return;
    }
    const canLockOrientation =
      supportsMobileOrientationLock() && !orientationLockUnsupported;
    const landscapeQuery = window.matchMedia("(orientation: landscape)");
    const generation = ++orientationEffectGeneration.current;
    let effectActive = true;
    let hasEnteredGame = false;

    const syncViewportActions = (action: "enter" | "restore") => {
      if (!effectActive) return;
      const orientationMatches = matchesPreferredOrientation(preference);
      const gameIsFullscreen =
        document.fullscreenElement === document.documentElement;
      setOrientationAction(
        canLockOrientation && !orientationMatches ? action : undefined,
      );
      setShowFullscreenAction(
        landscapeOrientation(preference) &&
          orientationMatches &&
          !gameIsFullscreen &&
          supportsGameFullscreen(),
      );
    };

    const restoreOrientation = async (action: "enter" | "restore") => {
      if (!effectActive || document.visibilityState !== "visible") return;
      if (!canLockOrientation) {
        hasEnteredGame = true;
        syncViewportActions(action);
        return;
      }
      const pendingAttempt = pendingGameOrientation;
      const result = pendingAttempt
        ? await pendingAttempt
        : await lockGameOrientation(preference);
      if (!effectActive) return;
      if (result === "unsupported") {
        setOrientationLockUnsupported(true);
        await releaseGameFullscreen();
        if (!effectActive) return;
        setOrientationAction("unsupported");
        setShowFullscreenAction(false);
        return;
      }
      hasEnteredGame = true;
      syncViewportActions(result === "locked" ? "restore" : action);
    };

    const onFullscreenChange = () => {
      if (document.fullscreenElement !== document.documentElement) {
        gameFullscreenOwned = false;
        gameOrientationLockOwned = false;
      }
      if (document.visibilityState === "visible")
        syncViewportActions(hasEnteredGame ? "restore" : "enter");
    };

    const onOrientationChange = () => {
      syncViewportActions(hasEnteredGame ? "restore" : "enter");
    };

    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        void restoreOrientation(hasEnteredGame ? "restore" : "enter");
      }
    };

    document.addEventListener("fullscreenchange", onFullscreenChange);
    document.addEventListener("visibilitychange", onVisibilityChange);
    landscapeQuery.addEventListener("change", onOrientationChange);
    void restoreOrientation("enter");

    return () => {
      effectActive = false;
      document.removeEventListener("fullscreenchange", onFullscreenChange);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      landscapeQuery.removeEventListener("change", onOrientationChange);
      const retirementGeneration = ++orientationEffectGeneration.current;
      const pendingAttempt = pendingGameOrientation;
      void (pendingAttempt ?? Promise.resolve()).then(() => {
        // React may immediately restart an effect in development or while the
        // preference changes. Only the latest retired session may tear down
        // fullscreen; a replacement session keeps using it.
        if (
          orientationEffectGeneration.current === retirementGeneration &&
          generation < retirementGeneration
        ) {
          void releaseGameFullscreen();
        }
      });
    };
  }, [active, landscapeCompatibility, preferences?.orientation]);

  return {
    orientationAction,
    showFullscreenAction,
    showLandscapeCompatibility:
      active &&
      landscapeOrientation(preferences?.orientation) &&
      !viewportLandscape &&
      !landscapeCompatibility,
    deferGameLoad:
      active &&
      shouldShowWeChatLandscapeGuidance(preferences?.orientation) &&
      !landscapeCompatibility,
    landscapeCompatibilityRotation:
      active && landscapeCompatibility && !viewportLandscape
        ? landscapeCompatibilityRotation
        : undefined,
    enterPreferredOrientation,
    enableLandscapeCompatibility,
  };
}
