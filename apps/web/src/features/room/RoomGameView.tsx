import type { RefObject } from "react";
import { useI18n } from "@/app/i18n";
import GameFrame from "@/features/game/GameFrame";
import GameViewport from "@/features/game/GameViewport";
import GameInfoPanel from "@/features/game/GameInfoPanel";
import GameHelpDialog from "@/features/game/GameHelpDialog";
import type { useGameViewport } from "@/features/game/use-game-viewport";
import type { RoomControls } from "./useRoomControls";

interface RoomGameViewProps {
  controls: RoomControls;
  gameViewport: ReturnType<typeof useGameViewport>;
  iframe: RefObject<HTMLIFrameElement | null>;
  gameRevision: number;
}

export default function RoomGameView({
  controls,
  gameViewport,
  iframe,
  gameRevision,
}: RoomGameViewProps) {
  const { gameInfoOpen, setGameInfoOpen, phase, gameUrl, gameName } = controls;
  return (
    <>
      <GameViewport
        infoExpanded={gameInfoOpen}
        onOpenInfo={() => setGameInfoOpen(true)}
        orientationAction={gameViewport.orientationAction}
        showOptions={phase === "playing" && !gameViewport.deferGameLoad}
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
        {phase === "playing" && gameUrl && !gameViewport.deferGameLoad && (
          <GameFrame
            key={gameRevision}
            ref={iframe}
            title={gameName}
            src={gameUrl}
          />
        )}
      </GameViewport>
    </>
  );
}

export function RoomGamePanels({
  controls,
  gameViewport,
}: Pick<RoomGameViewProps, "controls" | "gameViewport">) {
  const { t } = useI18n();
  const {
    gameInfoOpen,
    setGameInfoOpen,
    phase,
    gameUrl,
    gameName,
    game,
    gameDescription,
    isOwner,
    returnToRoom,
    gameIconHref,
    isFavorite,
    gameHelpHref,
    setGameHelpOpen,
    gameHelpOpen,
    refreshGame,
    toggleFavorite,
  } = controls;
  return (
    <>
      {gameInfoOpen && gameUrl && game && (
        <GameInfoPanel
          description={gameDescription}
          exitAction={
            phase === "playing" && isOwner
              ? {
                  label: t("returnToRoom"),
                  onSelect: () => void returnToRoom(),
                }
              : undefined
          }
          icon={gameIconHref}
          isFavorite={isFavorite}
          manifestUrl={game.manifestUrl}
          name={gameName}
          url={game.url}
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
          onShowHelp={gameHelpHref ? () => setGameHelpOpen(true) : undefined}
          onRefresh={
            phase === "playing"
              ? () => {
                  refreshGame();
                }
              : undefined
          }
          onToggleFavorite={toggleFavorite}
        />
      )}{" "}
      {gameHelpOpen && gameHelpHref && (
        <GameHelpDialog
          name={gameName}
          url={gameHelpHref}
          onClose={() => setGameHelpOpen(false)}
        />
      )}
    </>
  );
}
