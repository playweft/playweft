import { useEffect, useRef } from "react";
import ErrorToast from "@/components/ErrorToast";
import GameViewport from "@/features/game/GameViewport";
import type { DiscoveredGame } from "@/features/game/game-manifest";
import {
  shouldShowWeChatLandscapeGuidance,
  useGameViewport,
} from "@/features/game/use-game-viewport";
import { useRoomSession } from "./useRoomSession";
import { useRoomControls } from "./useRoomControls";
import { useRoomGameBridge } from "./useRoomGameBridge";
import { RoomEntryFailureState, RoomEntryLoadingState } from "./RoomEntryState";
import RoomHeader from "./RoomHeader";
import RoomLobby from "./RoomLobby";
import RoomGameView, { RoomGamePanels } from "./RoomGameView";
import RoomDialogs from "./RoomDialogs";
import RoomPermissions from "./RoomPermissions";

interface RoomHostProps {
  identityReady: boolean;
  nickname: string;
  roomId: string;
  onBack(): void;
  onGameDiscovered(game: DiscoveredGame): void;
  onNicknameChange(value: string): void;
}

export default function RoomHost(props: RoomHostProps) {
  const { session, state } = useRoomSession(props);
  const controls = useRoomControls(session, state, props.onBack);
  const iframe = useRef<HTMLIFrameElement>(null);
  const playing = controls.phase === "playing";
  const gameViewport = useGameViewport(
    playing ||
      shouldShowWeChatLandscapeGuidance(state.loadedGame?.game.orientation),
    state.loadedGame?.game,
  );
  const bridge = useRoomGameBridge({
    session,
    state,
    frame: iframe,
    gameName: controls.gameName,
    nickname: props.nickname,
    deferred: gameViewport.deferGameLoad,
  });

  useEffect(() => {
    if (!gameViewport.deferGameLoad) void session?.activate();
  }, [session, state.loadedGame, gameViewport.deferGameLoad]);

  if (state.entryFailure) {
    return (
      <RoomEntryFailureState
        failure={state.entryFailure}
        onBack={props.onBack}
      />
    );
  }
  if (gameViewport.deferGameLoad) {
    return (
      <GameViewport
        infoExpanded={false}
        onOpenInfo={() => undefined}
        orientationAction={gameViewport.orientationAction}
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
        showOptions={false}
      >
        {null}
      </GameViewport>
    );
  }
  if (!session || !state.presence || !state.selfId)
    return <RoomEntryLoadingState />;

  return (
    <div className={`room-shell ${playing ? "room-playing" : ""}`}>
      {!playing && (
        <RoomHeader
          gameName={controls.gameName}
          nickname={props.nickname}
          onNicknameChange={props.onNicknameChange}
          requestBack={controls.requestBack}
        />
      )}
      <main className="room-host">
        {!playing && <RoomLobby roomId={props.roomId} controls={controls} />}
        <RoomGameView
          controls={controls}
          gameViewport={gameViewport}
          iframe={iframe}
          gameRevision={state.gameRevision}
        />
      </main>
      <RoomPermissions bridge={bridge} />
      {state.error && (
        <ErrorToast
          message={state.error}
          onDismiss={() => session.setError(undefined)}
        />
      )}
      <RoomDialogs roomId={props.roomId} controls={controls} />
      <RoomGamePanels controls={controls} gameViewport={gameViewport} />
    </div>
  );
}
