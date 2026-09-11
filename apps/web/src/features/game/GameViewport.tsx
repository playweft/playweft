import {
  ExternalLink,
  Maximize2,
  MoreHorizontal,
  Smartphone,
} from "lucide-react";
import type { CSSProperties, ReactNode } from "react";
import { useI18n } from "@/app/i18n";
import type { LandscapeCompatibilityRotation } from "@/features/game/use-game-viewport";

export default function GameViewport({
  children,
  infoExpanded,
  onOpenInfo,
  orientationAction,
  onEnterPreferredOrientation,
  onEnableLandscapeCompatibility,
  landscapeCompatibilityRotation,
  showOptions = true,
}: {
  children: ReactNode;
  infoExpanded: boolean;
  onOpenInfo(): void;
  orientationAction?: "enter" | "restore" | "unsupported" | "wechat";
  onEnterPreferredOrientation?(): void;
  onEnableLandscapeCompatibility?(): void;
  landscapeCompatibilityRotation?: LandscapeCompatibilityRotation;
  showOptions?: boolean;
}) {
  const { t } = useI18n();
  const stageStyle = landscapeCompatibilityRotation
    ? ({
        "--game-viewport-rotation": landscapeCompatibilityRotation,
      } as CSSProperties)
    : undefined;

  return (
    <>
      <div
        className={`game-viewport-stage${landscapeCompatibilityRotation ? " game-viewport-stage-landscape-compatibility" : ""}`}
        style={stageStyle}
      >
        {children}
        {showOptions && orientationAction !== "wechat" && (
          <button
            className="platform-menu-button"
            type="button"
            aria-label={t("gameInformation")}
            aria-expanded={infoExpanded}
            onClick={onOpenInfo}
          >
            <MoreHorizontal aria-hidden="true" size={24} />
          </button>
        )}
      </div>
      {orientationAction === "wechat" ? (
        <div
          className="game-orientation-gate game-orientation-wechat"
          role="alert"
        >
          <div className="wechat-browser-guidance">
            <svg
              aria-hidden="true"
              className="wechat-browser-guidance-arrow"
              viewBox="0 0 100 100"
            >
              <path d="M10 86C52 86 76 64 84 10" />
              <path d="m68 20 16-10 11 15" />
            </svg>
            <p>
              <span>{t("openWeChatMenu")}</span>
              <span>{t("chooseOpenInBrowser")}</span>
            </p>
          </div>
          {onEnableLandscapeCompatibility && (
            <button
              className="game-orientation-enter"
              type="button"
              onClick={onEnableLandscapeCompatibility}
            >
              <Smartphone className="landscape-mode-icon" aria-hidden="true" />
              <span>{t("continueInLandscapeMode")}</span>
            </button>
          )}
        </div>
      ) : orientationAction === "unsupported" ? (
        <div
          className="game-orientation-gate game-orientation-unsupported"
          role="alert"
        >
          <div className="game-orientation-unsupported-content">
            <ExternalLink aria-hidden="true" />
            <strong>{t("openInAnotherBrowser")}</strong>
            {onEnableLandscapeCompatibility && (
              <button
                className="game-orientation-enter"
                type="button"
                onClick={onEnableLandscapeCompatibility}
              >
                <Smartphone className="landscape-mode-icon" aria-hidden="true" />
                <span>{t("continueInLandscapeMode")}</span>
              </button>
            )}
          </div>
        </div>
      ) : (
        orientationAction &&
        onEnterPreferredOrientation && (
          <div className="game-orientation-gate">
            <button
              className="game-orientation-enter"
              type="button"
              onClick={onEnterPreferredOrientation}
            >
              <Maximize2 aria-hidden="true" />
              <span>
                {t(
                  orientationAction === "restore"
                    ? "restoreLandscapeGame"
                    : "enterFullscreenGame",
                )}
              </span>
            </button>
          </div>
        )
      )}
    </>
  );
}
