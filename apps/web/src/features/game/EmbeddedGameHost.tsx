import { useEffect, useRef, useState } from "react";
import GameFrame from "./GameFrame";
import GameViewport from "./GameViewport";
import GameInfoPanel from "./GameInfoPanel";
import GameHelpDialog from "./GameHelpDialog";
import GameLoading from "./GameLoading";
import type { DiscoveredGame } from "./game-manifest";
import { useSoloGameLaunch } from "./use-solo-game-launch";
import { GameRoomManager } from "./GameRoomManager";
import { useI18n, localizeGameName, localizeGameDescription } from "@/app/i18n";
import { initialRoomState } from "@/features/room/RoomSession";
import { useRoomGameBridge } from "@/features/room/useRoomGameBridge";
import { useRoomControls } from "@/features/room/useRoomControls";
import RoomPermissions from "@/features/room/RoomPermissions";
import RoomLobby from "@/features/room/RoomLobby";
import RoomDialogs from "@/features/room/RoomDialogs";
import {
  isFavoriteGame,
  toggleFavoriteGame,
} from "@/features/library/favorite-games";
import ErrorToast from "@/components/ErrorToast";

export interface EmbeddedGameHostProps {
  closing: boolean;
  game: DiscoveredGame;
  nickname: string;
  waitForIdentity(): Promise<string>;
  onRoomChange(roomId?: string): void;
  initialRoomId?: string;
  onBack(): void;
}

export default function EmbeddedGameHost(props: EmbeddedGameHostProps) {
  const { locale, t } = useI18n();
  const [initialEntryPending, setInitialEntryPending] = useState(
    !!props.initialRoomId,
  );
  const [manager, setManager] = useState<GameRoomManager>();
  const [state, setState] = useState(initialRoomState);
  const [roomError, setRoomError] = useState<string>();
  const [info, setInfo] = useState(false);
  const [help, setHelp] = useState(false);
  const [favorite, setFavorite] = useState(() => isFavoriteGame(props.game));
  const iframe = useRef<HTMLIFrameElement>(null);
  const latest = useRef({ ...props, t });
  latest.current = { ...props, t };
  const {
    game, loaded, loadError, dismissLoadError, viewport, revision, frameReady, onFrameLoad, refreshFrame,
  } = useSoloGameLaunch(props.game, props.closing);
  const error = loadError ?? roomError;
  const name = localizeGameName(game, locale);
  const controls = useRoomControls(manager?.session, state, props.onBack);
  const roomId = manager?.session?.roomId;
  const platformLobby =
    !!roomId && state.presence?.phase === "lobby" && !controls.useGameLobby;
  const bridge = useRoomGameBridge({
    manager,
    loadedGame: loaded,
    state: { ...state, gameRevision: revision },
    frame: iframe,
    gameName: name,
    nickname: props.nickname,
    deferred: viewport.deferGameLoad || props.closing,
  });
  useEffect(() => {
    if (!loaded) return;
    const current = new GameRoomManager(loaded, {
      waitForIdentity: () => latest.current.waitForIdentity(),
      nickname: () => latest.current.nickname,
      message: (key) => latest.current.t(key),
      onRoomChange: (id) => latest.current.onRoomChange(id),
    });
    const unsubscribe = current.subscribe(() => setState(current.getState()));
    setManager(current);
    let cancelled = false;
    if (latest.current.initialRoomId)
      void current
        .join(latest.current.initialRoomId)
        .catch((reason) => {
          if (cancelled) return;
          setRoomError(reason instanceof Error ? reason.message : String(reason));
          latest.current.onRoomChange();
        })
        .finally(() => {
          if (!cancelled) setInitialEntryPending(false);
        });
    return () => {
      cancelled = true;
      unsubscribe();
      current.dispose();
    };
  }, [loaded]);
  useEffect(() => {
    void manager?.session?.syncNickname();
  }, [manager, props.nickname, state.lifecycle]);
  useEffect(() => {
    document.title = `${name} | Playweft`;
  }, [name]);
  useEffect(() => {
    if (!roomId) controls.showGameLobby();
  }, [roomId]);
  return (
    <div
      className={`room-shell ${platformLobby ? "" : "room-playing"} solo-host${props.closing ? " solo-host-closing" : ""}`}
      inert={props.closing || undefined}
    >
      {platformLobby && roomId && (
        <main className="room-host">
          <RoomLobby roomId={roomId} controls={controls} />
        </main>
      )}
      <div style={{ display: platformLobby ? "none" : "contents" }}>
        <GameViewport
          infoExpanded={info}
          onOpenInfo={() => setInfo(true)}
          orientationAction={viewport.orientationAction}
          showOptions={!viewport.deferGameLoad}
          onEnterPreferredOrientation={() =>
            void viewport.enterPreferredOrientation()
          }
          onEnableLandscapeCompatibility={
            viewport.showLandscapeCompatibility
              ? viewport.enableLandscapeCompatibility
              : undefined
          }
          landscapeCompatibilityRotation={
            viewport.landscapeCompatibilityRotation
          }
        >
          {!viewport.deferGameLoad &&
            !error &&
            (!frameReady || initialEntryPending) && (
              <GameLoading name={name} icon={game.icon} />
            )}
          {loaded && !initialEntryPending && !viewport.deferGameLoad && (
            <GameFrame
              key={revision}
              ref={iframe}
              title={name}
              src={game.url}
              onLoad={onFrameLoad}
            />
          )}
        </GameViewport>
      </div>
      <RoomPermissions bridge={bridge} />
      {(error || state.error) && (
        <ErrorToast
          message={error ?? state.error!}
          onDismiss={() => {
            dismissLoadError();
            setRoomError(undefined);
            manager?.session?.setError(undefined);
          }}
        />
      )}
      {roomId && <RoomDialogs roomId={roomId} controls={controls} />}
      {info && (
        <GameInfoPanel
          name={name}
          description={localizeGameDescription(game, locale)}
          icon={game.icon}
          manifestUrl={game.manifestUrl}
          url={game.url}
          isFavorite={favorite}
          onToggleFavorite={() => setFavorite(toggleFavoriteGame(game))}
          onClose={() => setInfo(false)}
          onShowPlatformLobby={
            roomId && state.presence?.phase === "lobby"
              ? () => {
                  setInfo(false);
                  controls.showPlatformLobby();
                }
              : undefined
          }
          onRefresh={() => {
            refreshFrame();
            setInfo(false);
          }}
          onShowHelp={game.helpUrl ? () => setHelp(true) : undefined}
          onEnterFullscreen={
            viewport.showFullscreenAction
              ? () => void viewport.enterPreferredOrientation()
              : undefined
          }
          exitAction={
            roomId
              ? {
                  label: t("leaveRoom"),
                  onSelect: () => {
                    setInfo(false);
                    controls.requestBack();
                  },
                }
              : { label: t("backHome"), onSelect: props.onBack }
          }
        />
      )}
      {help && game.helpUrl && (
        <GameHelpDialog
          name={name}
          url={game.helpUrl}
          onClose={() => setHelp(false)}
        />
      )}
    </div>
  );
}
