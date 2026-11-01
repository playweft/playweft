import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import GamepadNavigation from "@/features/input/GamepadNavigation";
import App from "@/app/App";
import { I18nProvider } from "@/app/i18n";
import "./styles.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <I18nProvider>
      <App />
      <GamepadNavigation />
    </I18nProvider>
  </StrictMode>,
);
