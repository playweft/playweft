import { useEffect, useLayoutEffect, useState } from "react";
import { createPortal } from "react-dom";
import { Move } from "lucide-react";
import { useI18n } from "@/app/i18n";
import { startGamepadNavigation, type GamepadHints } from "./gamepad-navigation";

// Physical positions avoid guessing A/B labels across Xbox, PS and Nintendo pads.
function FaceButton({ position }: { position: "bottom" | "right" | "left" }) {
  const buttons = { top: [12, 4], right: [20, 12], bottom: [12, 20], left: [4, 12] };
  return <svg viewBox="0 0 24 24" aria-hidden="true">
    {Object.entries(buttons).map(([name, [cx, cy]]) =>
      <circle key={name} cx={cx} cy={cy} r="3" fill={name === position ? "currentColor" : "none"} stroke="currentColor" opacity={name === position ? 1 : 0.35} />)}
  </svg>;
}

export default function GamepadNavigation() {
  const { t } = useI18n();
  const [active, setActive] = useState(false);
  const [shown, setShown] = useState(false);
  const [hints, setHints] = useState<GamepadHints>();
  useEffect(() => startGamepadNavigation(setActive, setHints), []);
  useEffect(() => {
    if (active) { setShown(true); return; }
    const timer = window.setTimeout(() => setShown(false), 700);
    return () => window.clearTimeout(timer);
  }, [active]);
  const visible = shown && hints && !hints.playing;
  useLayoutEffect(() => {
    // Reserve the footer before adjusting focus on the first controller input.
    if (!visible) return;
    const focused = document.activeElement;
    if (focused instanceof HTMLElement && !focused.closest('.menu')) {
      focused.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "instant" });
    }
  }, [visible, hints?.container]);
  if (!hints) return null;
  return createPortal(
    <aside className="gamepad-help" data-visible={visible ? "true" : "false"} aria-hidden={!visible} aria-label={t("gamepadControls")}>
      <span className="gamepad-help-item"><Move aria-hidden="true" />{t(hints.editing ? "gamepadAdjust" : "gamepadMove")}</span>
      <div className="gamepad-help-actions">
        {hints.options && <span className="gamepad-help-item"><FaceButton position="left" />{t("gamepadOptions")}</span>}
        <span className="gamepad-help-item"><FaceButton position="bottom" />{t(hints.editing ? "gamepadDone" : "gamepadSelect")}</span>
        {(hints.back || hints.editing) && <span className="gamepad-help-item"><FaceButton position="right" />{t("back")}</span>}
      </div>
    </aside>, hints.container,
  );
}
