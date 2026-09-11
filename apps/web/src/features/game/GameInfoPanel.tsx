import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import {
  Check,
  CircleHelp,
  Link2,
  Maximize2,
  Power,
  RefreshCw,
  Share,
  Smartphone,
  Star,
  X,
} from "lucide-react";
import { useI18n } from "@/app/i18n";
import { gameLaunchLink } from "@/features/game/game-launch-link";
import type { LandscapeCompatibilityRotation } from "@/features/game/use-game-viewport";

interface GameInfoExitAction {
  label: string;
  onSelect(): void;
}

interface GameInfoPanelProps {
  description?: string;
  exitAction?: GameInfoExitAction;
  icon?: string;
  isFavorite?: boolean;
  manifestUrl?: string;
  name: string;
  url: string;
  onClose(): void;
  onEnableLandscapeCompatibility?(): void;
  onEnterFullscreen?(): void;
  onRefresh?(): void;
  onShowHelp?(): void;
  onToggleFavorite?(): void;
  landscapeCompatibilityRotation?: LandscapeCompatibilityRotation;
}

export default function GameInfoPanel({
  description,
  exitAction,
  icon,
  isFavorite,
  manifestUrl,
  name,
  url,
  onClose,
  onEnableLandscapeCompatibility,
  onEnterFullscreen,
  onRefresh,
  onShowHelp,
  onToggleFavorite,
  landscapeCompatibilityRotation,
}: GameInfoPanelProps) {
  const { t } = useI18n();
  const [closing, setClosing] = useState(false);
  const [gameLinkCopied, setGameLinkCopied] = useState(false);
  const [urlTooltipVisible, setUrlTooltipVisible] = useState(false);
  const afterClose = useRef<(() => void) | undefined>(undefined);
  const copyResetTimer = useRef<number | undefined>(undefined);
  const dialog = useRef<HTMLDialogElement>(null);
  let gameSourceHost = url;
  try {
    gameSourceHost = new URL(url).host;
  } catch {
    // Keep the original value if a caller supplies a non-URL label.
  }

  const close = (after?: () => void) => {
    afterClose.current = after;
    setClosing(true);
  };

  useLayoutEffect(() => {
    const element = dialog.current;
    if (!element) return;
    element.showModal();
    return () => element.close();
  }, []);

  useEffect(() => {
    if (!closing) return;
    const finish = () => {
      onClose();
      afterClose.current?.();
    };
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      finish();
      return;
    }
    const timeout = window.setTimeout(finish, 180);
    return () => window.clearTimeout(timeout);
  }, [closing, onClose]);

  useEffect(
    () => () => {
      if (copyResetTimer.current !== undefined) {
        window.clearTimeout(copyResetTimer.current);
      }
    },
    [],
  );

  const copyGameLink = async () => {
    if (!manifestUrl) return;
    try {
      await navigator.clipboard.writeText(gameLaunchLink(manifestUrl));
      setGameLinkCopied(true);
      if (copyResetTimer.current !== undefined) {
        window.clearTimeout(copyResetTimer.current);
      }
      copyResetTimer.current = window.setTimeout(
        () => setGameLinkCopied(false),
        1_500,
      );
    } catch {
      setGameLinkCopied(false);
    }
  };

  const shareGameLink = async () => {
    if (!manifestUrl || typeof navigator.share !== "function") return;
    try {
      await navigator.share({
        title: name,
        url: gameLaunchLink(manifestUrl),
      });
    } catch {
      // A dismissed share sheet is not an error that needs to be surfaced.
    }
  };

  const canShareGameLink =
    Boolean(manifestUrl) && typeof navigator.share === "function";

  return (
    <dialog
      ref={dialog}
      className={`game-info-layer${landscapeCompatibilityRotation ? " game-info-layer-landscape-compatibility" : ""}`}
      style={
        landscapeCompatibilityRotation
          ? {
              "--game-viewport-rotation": landscapeCompatibilityRotation,
            } as CSSProperties
          : undefined
      }
      aria-labelledby="game-info-title"
      onCancel={(event) => {
        event.preventDefault();
        close();
      }}
    >
      <button
        className={`game-info-backdrop ${closing ? "game-info-backdrop-closing" : ""}`}
        type="button"
        tabIndex={-1}
        aria-label={t("closeGameInformation")}
        onClick={() => close()}
      />
      <section
        className={`game-info-panel ${closing ? "game-info-panel-closing" : ""}`}
      >
        <header className="game-info-header">
          <h2 id="game-info-title">{t("gameInformation")}</h2>
          <div className="game-info-header-actions">
            {exitAction && (
              <button
                className="game-info-header-exit"
                type="button"
                aria-label={exitAction.label}
                title={exitAction.label}
                onClick={() => close(exitAction.onSelect)}
              >
                <Power aria-hidden="true" />
              </button>
            )}
            <button
              type="button"
              aria-label={t("closeGameInformation")}
              onClick={() => close()}
            >
              <X aria-hidden="true" />
            </button>
          </div>
        </header>
        <div className="game-info-content">
          <div className="game-info-icon" aria-hidden="true">
            {icon ? (
              <img
                src={icon}
                width="64"
                height="64"
                alt=""
                referrerPolicy="no-referrer"
              />
            ) : (
              <span>{name.slice(0, 2).toUpperCase()}</span>
            )}
          </div>
          <div className="game-info-copy">
            <h3>{name}</h3>
            <button
              className="game-info-url"
              type="button"
              aria-expanded={urlTooltipVisible}
              aria-describedby="game-info-url-tooltip"
              onBlur={() => setUrlTooltipVisible(false)}
              onClick={() => setUrlTooltipVisible((visible) => !visible)}
            >
              <span className="game-info-url-text">{gameSourceHost}</span>
              <span
                id="game-info-url-tooltip"
                className="game-info-url-tooltip"
                role="tooltip"
              >
                <span className="game-info-url-tooltip-label">
                  {t("gameSource")}
                </span>
                <span className="game-info-url-tooltip-value">{url}</span>
              </span>
            </button>
          </div>
        </div>
        {description && <p className="game-info-description">{description}</p>}
        {(manifestUrl ||
          onEnterFullscreen ||
          onEnableLandscapeCompatibility ||
          onRefresh ||
          onShowHelp ||
          onToggleFavorite) && (
          <>
            <hr className="game-info-quick-actions-divider" />
            <div className="game-info-quick-actions">
              {onToggleFavorite && (
                <button
                  type="button"
                  aria-pressed={isFavorite}
                  onClick={onToggleFavorite}
                >
                  <span className="game-info-quick-action-icon">
                    <Star
                      aria-hidden="true"
                      fill={isFavorite ? "currentColor" : "none"}
                    />
                  </span>
                  <span className="game-info-quick-action-label">
                    {t(isFavorite ? "unfavorite" : "favorite")}
                  </span>
                </button>
              )}
              {canShareGameLink && (
                <button type="button" onClick={() => void shareGameLink()}>
                  <span className="game-info-quick-action-icon">
                    <Share aria-hidden="true" />
                  </span>
                  <span className="game-info-quick-action-label">
                    {t("shareGame")}
                  </span>
                </button>
              )}
              {manifestUrl && (
                <button type="button" onClick={() => void copyGameLink()}>
                  <span
                    className={`game-info-quick-action-icon ${gameLinkCopied ? "game-info-quick-action-icon-success" : ""}`}
                  >
                    {gameLinkCopied ? (
                      <Check aria-hidden="true" />
                    ) : (
                      <Link2 aria-hidden="true" />
                    )}
                  </span>
                  <span
                    className="game-info-quick-action-label"
                    aria-live="polite"
                  >
                    {t(gameLinkCopied ? "gameLinkCopied" : "copyGameLink")}
                  </span>
                </button>
              )}
              {onShowHelp && (
                <button type="button" onClick={() => close(onShowHelp)}>
                  <span className="game-info-quick-action-icon">
                    <CircleHelp aria-hidden="true" />
                  </span>
                  <span className="game-info-quick-action-label">
                    {t("help")}
                  </span>
                </button>
              )}
              {onEnterFullscreen && (
                <button
                  type="button"
                  onClick={() => {
                    onEnterFullscreen();
                    close();
                  }}
                >
                  <span className="game-info-quick-action-icon">
                    <Maximize2 aria-hidden="true" />
                  </span>
                  <span className="game-info-quick-action-label">
                    {t("fullscreen")}
                  </span>
                </button>
              )}
              {onEnableLandscapeCompatibility && (
                <button
                  type="button"
                  onClick={() => close(onEnableLandscapeCompatibility)}
                >
                  <span className="game-info-quick-action-icon">
                    <Smartphone
                      className="landscape-mode-icon"
                      aria-hidden="true"
                    />
                  </span>
                  <span className="game-info-quick-action-label">
                    {t("landscapeMode")}
                  </span>
                </button>
              )}
              {onRefresh && (
                <button type="button" onClick={() => close(onRefresh)}>
                  <span className="game-info-quick-action-icon">
                    <RefreshCw aria-hidden="true" />
                  </span>
                  <span className="game-info-quick-action-label">
                    {t("refresh")}
                  </span>
                </button>
              )}
            </div>
          </>
        )}
      </section>
    </dialog>
  );
}
