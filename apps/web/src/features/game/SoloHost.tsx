import { useEffect, useRef, useState } from "react";
import { JsonRpcErrorCode } from "@playweft/game-protocol";
import ErrorToast from "@/components/ErrorToast";
import GameFrame, { attachGameBridge } from "@/features/game/GameFrame";
import GameHelpDialog from "@/features/game/GameHelpDialog";
import GameInfoPanel from "@/features/game/GameInfoPanel";
import GameViewport from "@/features/game/GameViewport";
import GameWindowDialog, {
  PLATFORM_WINDOW_CAPABILITIES,
  useGameWindowDialogs,
} from "@/features/game/GameWindowDialog";
import { ClipboardPrompt, useClipboardRead } from "@/features/permissions/ClipboardPrompt";
import {
  UserProfilePrompt,
  userProfileFieldsFromRpcParams,
  useUserProfileAccess,
} from "@/features/permissions/UserProfilePrompt";
import { isFavoriteGame, toggleFavoriteGame } from "@/features/game/favorite-games";
import type { DiscoveredGame as RecentGame, LoadedGame } from "@/features/game/game-manifest";
import { localizeGameDescription, localizeGameName, useI18n } from "@/app/i18n";
import {
  PLAYWEFT_BRIDGE_VERSION,
  RpcFault,
  rpcPlatformFault,
} from "@/platform/json-rpc";
import { loadGameManifest } from "@/features/game/game-manifest";
import { useGameViewport } from "@/features/game/use-game-viewport";

interface SoloHostProps {
  closing: boolean;
  game: RecentGame;
  nickname: string;
  onBack(): void;
}

export default function SoloHost({
  closing,
  game,
  nickname,
  onBack,
}: SoloHostProps) {
  const { locale, t } = useI18n();
  const [gameInfoOpen, setGameInfoOpen] = useState(false);
  const [gameHelpOpen, setGameHelpOpen] = useState(false);
  const [loaded, setLoaded] = useState<LoadedGame>();
  const [loadError, setLoadError] = useState<string>();
  const [gameRevision, setGameRevision] = useState(0);
  const [frameReady, setFrameReady] = useState(false);
  const [isFavorite, setIsFavorite] = useState(() => isFavoriteGame(game));
  const iframe = useRef<HTMLIFrameElement>(null);
  const nicknameRef = useRef(nickname);
  nicknameRef.current = nickname;
  const currentGame = loaded?.game ?? game;
  const gameName = localizeGameName(currentGame, locale);
  const gameDescription = localizeGameDescription(currentGame, locale);
  const gameOrigin = new URL(currentGame.url).origin;
  const clipboard = useClipboardRead(
    gameName,
    currentGame.manifestId,
    gameOrigin,
  );
  const userProfile = useUserProfileAccess(
    gameName,
    gameOrigin,
    currentGame.manifestId,
    nickname,
  );
  const windowDialogs = useGameWindowDialogs(gameName, gameOrigin);
  const gameViewport = useGameViewport(true, currentGame);

  useEffect(() => {
    setIsFavorite(isFavoriteGame(currentGame));
  }, [currentGame.manifestId]);

  useEffect(() => {
    if (gameViewport.deferGameLoad) return;
    let cancelled = false;
    void loadGameManifest(game.manifestUrl)
      .then((result) => {
        if (!cancelled) setLoaded(result);
      })
      .catch((reason) => {
        if (!cancelled) {
          setLoadError(message(reason, t("unexpectedError")));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [game.manifestUrl, gameViewport.deferGameLoad, t]);

  useEffect(() => {
    document.title = `${gameName} | Playweft`;
    return () => {
      document.title = "Playweft";
    };
  }, [gameName]);

  useEffect(() => {
    if (!closing) return;
    setGameInfoOpen(false);
    setGameHelpOpen(false);
  }, [closing]);

  useEffect(() => {
    if (!loaded || gameViewport.deferGameLoad) return;
    const capabilities = [
      ...new Set([
        ...PLATFORM_WINDOW_CAPABILITIES,
        "user.getProfile",
        "navigator.clipboard.readText",
      ]),
    ];
    const detachBridge = attachGameBridge({
      frame: iframe,
      origin: gameOrigin,
      onBeforeConnect() {
        clipboard.cancelPending();
        userProfile.cancelPending();
        windowDialogs.cancelPending();
      },
      handlers: {
        "game.initialize": {
          handle() {
            if (!loaded.manifest.modes.solo) {
              throw rpcPlatformFault(
                "SOLO_MODE_UNAVAILABLE",
                "The game Manifest does not declare solo mode",
              );
            }
            return {
              mode: "solo",
              protocolVersion: PLAYWEFT_BRIDGE_VERSION,
              capabilities,
              player: {
                ...(nicknameRef.current ? { name: nicknameRef.current } : {}),
              },
            };
          },
        },
        "room.action": {
          handle() {
            throw rpcPlatformFault(
              "ROOM_UNAVAILABLE_IN_SOLO_MODE",
              "Room actions are unavailable in solo mode",
            );
          },
        },
        "navigator.clipboard.readText": {
          handle() {
            return clipboard.requestReadText();
          },
        },
        "room.players.getProfile": {
          handle() {
            throw rpcPlatformFault(
              "ROOM_UNAVAILABLE_IN_SOLO_MODE",
              "Room player profiles are unavailable in solo mode",
            );
          },
        },
        "user.getProfile": {
          handle(params) {
            const fields = userProfileFieldsFromRpcParams(params);
            if (!fields) {
              throw new RpcFault(
                JsonRpcErrorCode.InvalidParams,
                "user.getProfile expects { fields: ['name' | 'avatar', ...] }",
              );
            }
            return userProfile.requestProfile(fields);
          },
        },
        "window.alert": {
          handle: windowDialogs.requestAlert,
        },
        "window.confirm": {
          handle: windowDialogs.requestConfirm,
        },
      },
    });
    return () => {
      clipboard.cancelPending();
      userProfile.cancelPending();
      windowDialogs.cancelPending();
      detachBridge();
    };
  }, [
    clipboard.cancelPending,
    clipboard.requestReadText,
    gameOrigin,
    gameViewport.deferGameLoad,
    loaded,
    userProfile.cancelPending,
    userProfile.requestProfile,
    windowDialogs.cancelPending,
    windowDialogs.requestAlert,
    windowDialogs.requestConfirm,
  ]);

  return (
    <div
      className={`room-shell room-playing solo-host ${closing ? "solo-host-closing" : ""}`}
    >
      <GameViewport
        infoExpanded={gameInfoOpen}
        onOpenInfo={() => setGameInfoOpen(true)}
        orientationAction={gameViewport.orientationAction}
        showOptions={!gameViewport.deferGameLoad}
        onEnterPreferredOrientation={() =>
          void gameViewport.enterPreferredOrientation()
        }
        onEnableLandscapeCompatibility={
          gameViewport.showLandscapeCompatibility
            ? gameViewport.enableLandscapeCompatibility
            : undefined
        }
        landscapeCompatibilityRotation={
          gameViewport.landscapeCompatibilityRotation
        }
      >
        {!gameViewport.deferGameLoad && !frameReady && !loadError && (
          <div
            className="solo-loading"
            role="status"
            aria-label={t("loadingGame")}
            aria-live="polite"
          >
            <div className="solo-loading-game">
              {currentGame.icon ? (
                <img
                  className="solo-loading-icon"
                  src={currentGame.icon}
                  alt=""
                  referrerPolicy="no-referrer"
                />
              ) : (
                <span className="solo-loading-icon solo-loading-icon-fallback">
                  {gameName.slice(0, 2).toUpperCase()}
                </span>
              )}
              <strong>{gameName}</strong>
            </div>
            <div className="solo-loading-progress">
              <span className="loading-spinner" aria-hidden="true" />
            </div>
          </div>
        )}
        {loaded && !gameViewport.deferGameLoad && (
          <div
            className={`solo-game-surface ${frameReady ? "solo-game-surface-ready" : ""}`}
          >
            <GameFrame
              key={gameRevision}
              ref={iframe}
              title={gameName}
              src={loaded.game.url}
              onLoad={() => setFrameReady(true)}
            />
          </div>
        )}
      </GameViewport>
      {loadError && (
        <ErrorToast
          message={loadError}
          onDismiss={() => setLoadError(undefined)}
        />
      )}
      <ClipboardPrompt
        prompt={clipboard.prompt}
        notice={clipboard.notice}
        onAllow={() => void clipboard.allow()}
        onDeny={clipboard.deny}
        onDismissNotice={clipboard.clearNotice}
      />
      <UserProfilePrompt
        prompt={userProfile.prompt}
        onAllow={userProfile.allow}
        onDeny={userProfile.deny}
      />
      {windowDialogs.dialog && (
        <GameWindowDialog
          dialog={windowDialogs.dialog}
          onConfirm={windowDialogs.confirm}
          onDismiss={windowDialogs.dismiss}
        />
      )}
      {gameInfoOpen && (
        <GameInfoPanel
          description={gameDescription}
          exitAction={{
            label: t("backHome"),
            onSelect: onBack,
          }}
          icon={currentGame.icon}
          isFavorite={isFavorite}
          manifestUrl={currentGame.manifestUrl}
          name={gameName}
          url={currentGame.url}
          onClose={() => setGameInfoOpen(false)}
          onEnterFullscreen={
            gameViewport.showFullscreenAction
              ? () => void gameViewport.enterPreferredOrientation()
              : undefined
          }
          onEnableLandscapeCompatibility={
            gameViewport.showLandscapeCompatibility
              ? gameViewport.enableLandscapeCompatibility
              : undefined
          }
          landscapeCompatibilityRotation={
            gameViewport.landscapeCompatibilityRotation
          }
          onRefresh={
            loaded
              ? () => {
                  setFrameReady(false);
                  setGameRevision((revision) => revision + 1);
                }
              : undefined
          }
          onShowHelp={
            currentGame.helpUrl ? () => setGameHelpOpen(true) : undefined
          }
          onToggleFavorite={() =>
            setIsFavorite(toggleFavoriteGame(currentGame))
          }
        />
      )}
      {gameHelpOpen && currentGame.helpUrl && (
        <GameHelpDialog
          name={gameName}
          url={currentGame.helpUrl}
          onClose={() => setGameHelpOpen(false)}
        />
      )}
    </div>
  );
}

function message(reason: unknown, fallback: string): string {
  return reason instanceof Error ? reason.message : fallback;
}
