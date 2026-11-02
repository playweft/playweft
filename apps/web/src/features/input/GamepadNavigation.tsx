import { useEffect, useState } from "react";
import { useI18n } from "@/app/i18n";
import { startGamepadNavigation } from "./gamepad-navigation";

export default function GamepadNavigation() {
  const [active, setActive] = useState(false);
  const { t } = useI18n();
  useEffect(() => startGamepadNavigation(setActive), []);
  return active ? <aside className="gamepad-hints" aria-label={t("gamepadControls")}>{t("gamepadHints")}</aside> : null;
}
