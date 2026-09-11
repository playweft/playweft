import { useEffect, useMemo, useState } from "react";
import { createGuestSession, createRoom } from "./platform-api";
import { useFeaturedGames } from "./featured-games";
import ErrorToast from "./ErrorToast";
import GameHelpDialog from "./GameHelpDialog";
import GameInfoPanel from "./GameInfoPanel";
import GameMenu from "./GameMenu";
import GameShelf, {
  type GameShelfKind,
  type ShelfGame,
  type ShelfGamePhase,
} from "./GameShelf";
import LaunchChoiceDialog from "./LaunchChoiceDialog";
import PlayerProfileMenu from "./PlayerProfileMenu";
import UnsupportedGameDialog from "./UnsupportedGameDialog";
import {
  UnsupportedGameUrlError,
  probeGame,
  roomIdFromInput,
  saveRecentGame,
  supportedModes,
  toRecentGame,
} from "./game-launch";
import {
  persistFavoriteGames,
  readFavoriteGames,
} from "./favorite-games";
import type { DiscoveredGame as RecentGame, GameMode } from "./game-manifest";
import { localizeGameDescription, localizeGameName, useI18n } from "./i18n";
import type { MenuPosition } from "./Menu";
import { persistRecentGames, readRecentGames } from "./recent-games";

interface HomeProps {
  externalGameUrl?: string;
  suppressGameShelves: boolean;
  nickname: string;
  waitForIdentity(): Promise<string>;
  onNavigate(path: string): void;
  onBeginEntry(): () => boolean;
  onClaimExternalGameUrl(url: string): boolean;
  onEntryStatus(status: string | undefined): void;
  onNicknameChange(value: string): void;
  onPlaySolo(game: RecentGame): void;
}

interface LaunchFromValueOptions {
  preferSolo?: boolean;
  populateInputOnFailure?: boolean;
}

export default function Home({
  externalGameUrl,
  suppressGameShelves,
  nickname,
  waitForIdentity,
  onNavigate,
  onBeginEntry,
  onClaimExternalGameUrl,
  onEntryStatus,
  onNicknameChange,
  onPlaySolo,
}: HomeProps) {
  const { locale, t } = useI18n();
  const [gameUrl, setGameUrl] = useState("");
  const [recentGames, setRecentGames] = useState(readRecentGames);
  const [renderedRecentGames, setRenderedRecentGames] = useState(recentGames);
  const [recentGamePhases, setRecentGamePhases] = useState<
    Record<string, ShelfGamePhase>
  >({});
  const [favoriteGames, setFavoriteGames] = useState(readFavoriteGames);
  const [renderedFavoriteGames, setRenderedFavoriteGames] =
    useState(favoriteGames);
  const [favoriteGamePhases, setFavoriteGamePhases] = useState<
    Record<string, ShelfGamePhase>
  >({});
  const featuredGames = useFeaturedGames(!suppressGameShelves);
  const [error, setError] = useState<string>();
  const [gameMenu, setGameMenu] = useState<{
    game: ShelfGame;
    kind: GameShelfKind;
    position: MenuPosition;
  }>();
  const [gameMenuClosing, setGameMenuClosing] = useState(false);
  const [gameInfo, setGameInfo] = useState<ShelfGame>();
  const [gameHelp, setGameHelp] = useState<ShelfGame>();
  const [launchChoice, setLaunchChoice] = useState<ShelfGame>();
  const [launchChoiceRoomCode, setLaunchChoiceRoomCode] = useState("");
  const [unsupportedGame, setUnsupportedGame] = useState<{
    url: string;
    error: string;
  }>();
  const favoriteIds = useMemo(
    () => new Set(favoriteGames.map((game) => game.manifestId)),
    [favoriteGames],
  );
  const roomIdInput = roomIdFromInput(gameUrl);
  const rememberGame = (game: RecentGame) => {
    saveRecentGame(game);
    const nextRecentGames = readRecentGames();
    setRecentGames(nextRecentGames);
    setRenderedRecentGames(nextRecentGames);
    setRecentGamePhases({});
    const nextFavoriteGames = readFavoriteGames();
    setFavoriteGames(nextFavoriteGames);
    setRenderedFavoriteGames(nextFavoriteGames);
    setFavoriteGamePhases({});
  };

  const playSolo = (game: RecentGame) => {
    rememberGame(game);
    onEntryStatus(undefined);
    onPlaySolo(game);
  };

  const joinRoomById = async (roomId: string) => {
    const cancelled = onBeginEntry();
    setError(undefined);
    setUnsupportedGame(undefined);
    try {
      const resolvedNickname = await waitForIdentity();
      await createGuestSession(resolvedNickname);
      if (cancelled()) return;
      onEntryStatus(t("loadingGame"));
      onNavigate(`/r/${roomId}`);
    } catch (reason) {
      if (cancelled()) return;
      onEntryStatus(undefined);
      setError(message(reason, t("unexpectedError")));
    }
  };

  const createRoomForGame = async (game: RecentGame) => {
    const cancelled = onBeginEntry();
    setError(undefined);
    setUnsupportedGame(undefined);
    try {
      const resolvedNickname = await waitForIdentity();
      await createGuestSession(resolvedNickname);
      if (cancelled()) return;
      const room = await createRoom(game.manifestUrl);
      if (cancelled()) return;
      rememberGame(game);
      onEntryStatus(t("loadingGame"));
      onNavigate(`/r/${room.roomId}`);
    } catch (reason) {
      if (cancelled()) return;
      onEntryStatus(undefined);
      setError(message(reason, t("unexpectedError")));
    }
  };

  const launchGame = (
    game: ShelfGame,
    mode?: GameMode,
    preferSolo = false,
  ) => {
    const recentGame = toRecentGame(game);
    const modes = supportedModes(recentGame);
    if (mode === "solo") {
      playSolo(recentGame);
      return;
    }
    if (mode === "room") {
      void createRoomForGame(recentGame);
      return;
    }
    if (preferSolo && modes.includes("solo")) {
      playSolo(recentGame);
      return;
    }
    if (modes.includes("solo") && modes.includes("room")) {
      setLaunchChoice(recentGame);
      setLaunchChoiceRoomCode("");
      return;
    }
    if (modes.includes("solo")) {
      playSolo(recentGame);
      return;
    }
    void createRoomForGame(recentGame);
  };

  const launchFromValue = async (
    value: string,
    {
      preferSolo = false,
      populateInputOnFailure = false,
    }: LaunchFromValueOptions = {},
  ) => {
    const trimmed = value.trim();
    const roomId = roomIdFromInput(trimmed);
    if (roomId) {
      void joinRoomById(roomId);
      return;
    }
    const cancelled = onBeginEntry();
    setError(undefined);
    setUnsupportedGame(undefined);
    try {
      const game = await probeGame(trimmed, onEntryStatus, t);
      if (cancelled()) return;
      onEntryStatus(undefined);
      launchGame(game, undefined, preferSolo);
    } catch (reason) {
      if (cancelled()) return;
      onEntryStatus(undefined);
      if (populateInputOnFailure) setGameUrl(trimmed);
      if (reason instanceof UnsupportedGameUrlError) {
        setUnsupportedGame({ url: reason.url, error: reason.message });
      } else {
        setError(message(reason, t("unexpectedError")));
      }
    }
  };

  useEffect(() => {
    if (!externalGameUrl || !onClaimExternalGameUrl(externalGameUrl)) return;
    void launchFromValue(externalGameUrl, {
      preferSolo: true,
      populateInputOnFailure: true,
    });
  }, [externalGameUrl, onClaimExternalGameUrl]);

  const openGameMenu = (
    game: ShelfGame,
    kind: GameShelfKind,
    position: MenuPosition,
  ) => {
    setGameMenuClosing(false);
    setGameMenu({ game, kind, position });
  };

  const reorderFavoriteGames = (games: ShelfGame[]) => {
    const next = persistFavoriteGames(games.map(toRecentGame));
    setFavoriteGames(next);
    setRenderedFavoriteGames(next);
    setFavoriteGamePhases({});
  };

  const toggleFavorite = (game: ShelfGame) => {
    if (favoriteIds.has(game.manifestId)) {
      const nextFavoriteGames = persistFavoriteGames(
        favoriteGames.filter((item) => item.manifestId !== game.manifestId),
      );
      setFavoriteGames(nextFavoriteGames);
      setFavoriteGamePhases((current) => ({
        ...current,
        [game.manifestId]: "exiting",
      }));
      return;
    }

    const nextFavoriteGames = persistFavoriteGames([
      toRecentGame(game),
      ...favoriteGames.filter((item) => item.manifestId !== game.manifestId),
    ]);
    setFavoriteGames(nextFavoriteGames);
    setRenderedFavoriteGames((current) => [
      nextFavoriteGames[0],
      ...current.filter((item) => item.manifestId !== game.manifestId),
    ]);
    setFavoriteGamePhases((current) => ({
      ...current,
      [game.manifestId]: "entering",
    }));
  };

  const finishFavoriteAnimation = (game: ShelfGame) => {
    const phase = favoriteGamePhases[game.manifestId];
    if (!phase) return;
    if (phase === "exiting") {
      setRenderedFavoriteGames((current) =>
        current.filter((item) => item.manifestId !== game.manifestId),
      );
    }
    setFavoriteGamePhases((current) => {
      const next = { ...current };
      delete next[game.manifestId];
      return next;
    });
  };

  const deleteRecent = (game: ShelfGame) => {
    const nextRecentGames = persistRecentGames(
      recentGames.filter((item) => item.manifestId !== game.manifestId),
    );
    setRecentGames(nextRecentGames);
    setRecentGamePhases((current) => ({
      ...current,
      [game.manifestId]: "exiting",
    }));
  };

  const finishRecentAnimation = (game: ShelfGame) => {
    if (recentGamePhases[game.manifestId] !== "exiting") return;
    setRenderedRecentGames((current) =>
      current.filter((item) => item.manifestId !== game.manifestId),
    );
    setRecentGamePhases((current) => {
      const next = { ...current };
      delete next[game.manifestId];
      return next;
    });
  };

  return (
    <div className="site-shell">
      <header className="topbar">
        <a className="brand" href="/" aria-label={t("playweftHome")}>
          <img className="brand-mark" src="/favicon.svg" alt="" />
          <span>playweft</span>
        </a>
        <span className="topbar-label">{t("playGamesTogether")}</span>
        <PlayerProfileMenu
          nickname={nickname}
          onNicknameChange={onNicknameChange}
        />
      </header>
      <main className="home">
        <section
          className="launch-section"
          id="new-room"
          aria-labelledby="launch-title"
        >
          <h1 id="launch-title" className="sr-only">
            {t("createRoom")}
          </h1>
          <form
            className="launch-form"
            onSubmit={(event) => {
              event.preventDefault();
              void launchFromValue(gameUrl);
            }}
          >
            <label className="sr-only" htmlFor="game-url">
              {t("gameUrlOrRoomCode")}
            </label>
            <div className="url-input">
              <span className="url-icon" aria-hidden="true">
                ⌁
              </span>
              <input
                id="game-url"
                type="search"
                required
                autoComplete="off"
                placeholder={t("pasteGameUrlOrRoomCode")}
                value={gameUrl}
                onChange={(event) => setGameUrl(event.target.value)}
              />
            </div>
            <button
              className="button primary"
              disabled={!gameUrl.trim()}
              type="submit"
            >
              {roomIdInput ? t("joinRoom") : t("createRoom")}
            </button>
          </form>
        </section>

        {!suppressGameShelves && (
          <div className="game-shelves">
            {renderedFavoriteGames.length > 0 && (
              <GameShelf
                title={t("favorites")}
                kind="favorite"
                games={renderedFavoriteGames}
                activeGameId={
                  gameMenu?.kind === "favorite"
                    ? gameMenu.game.manifestId
                    : undefined
                }
                getItemClassName={(game) => {
                  const phase = favoriteGamePhases[game.manifestId];
                  return phase ? `shelf-game-${phase}` : "";
                }}
                onItemAnimationEnd={finishFavoriteAnimation}
                onSelect={launchGame}
                onOpenMenu={openGameMenu}
                onReorder={
                  Object.keys(favoriteGamePhases).length === 0
                    ? reorderFavoriteGames
                    : undefined
                }
                onDismissMenu={() => setGameMenuClosing(true)}
              />
            )}
            {renderedRecentGames.length > 0 && (
              <GameShelf
                title={t("recentlyPlayed")}
                kind="recent"
                games={renderedRecentGames}
                activeGameId={
                  gameMenu?.kind === "recent"
                    ? gameMenu.game.manifestId
                    : undefined
                }
                getItemClassName={(game) => {
                  const phase = recentGamePhases[game.manifestId];
                  return phase ? `shelf-game-${phase}` : "";
                }}
                onItemAnimationEnd={finishRecentAnimation}
                onSelect={launchGame}
                onOpenMenu={openGameMenu}
              />
            )}
            <GameShelf
              title={t("recommended")}
              kind="recommended"
              games={featuredGames}
              activeGameId={
                gameMenu?.kind === "recommended"
                  ? gameMenu.game.manifestId
                  : undefined
              }
              onSelect={launchGame}
              onOpenMenu={openGameMenu}
            />
          </div>
        )}
      </main>
      {error && (
        <ErrorToast message={error} onDismiss={() => setError(undefined)} />
      )}
      {gameMenu && (
        <GameMenu
          key={`${gameMenu.game.manifestId}:${gameMenu.kind}`}
          game={gameMenu.game}
          position={gameMenu.position}
          isFavorite={favoriteIds.has(gameMenu.game.manifestId)}
          canDelete={gameMenu.kind === "recent"}
          closeRequested={gameMenuClosing}
          onClose={() => {
            setGameMenuClosing(false);
            setGameMenu(undefined);
          }}
          onShowInfo={() => setGameInfo(gameMenu.game)}
          onToggleFavorite={() => toggleFavorite(gameMenu.game)}
          onDelete={() => deleteRecent(gameMenu.game)}
        />
      )}
      {gameInfo && (
        <GameInfoPanel
          description={localizeGameDescription(gameInfo, locale)}
          icon={gameInfo.icon}
          isFavorite={favoriteIds.has(gameInfo.manifestId)}
          manifestUrl={gameInfo.manifestUrl}
          name={localizeGameName(gameInfo, locale)}
          url={gameInfo.url}
          onClose={() => setGameInfo(undefined)}
          onShowHelp={
            gameInfo.helpUrl ? () => setGameHelp(gameInfo) : undefined
          }
          onToggleFavorite={() => toggleFavorite(gameInfo)}
        />
      )}
      {gameHelp?.helpUrl && (
        <GameHelpDialog
          name={localizeGameName(gameHelp, locale)}
          url={gameHelp.helpUrl}
          onClose={() => setGameHelp(undefined)}
        />
      )}
      {launchChoice && (
        <LaunchChoiceDialog
          game={launchChoice}
          roomCode={launchChoiceRoomCode}
          onRoomCodeChange={setLaunchChoiceRoomCode}
          onClose={() => setLaunchChoice(undefined)}
          onPlaySolo={() => {
            setLaunchChoice(undefined);
            launchGame(launchChoice, "solo");
          }}
          onCreateRoom={() => {
            setLaunchChoice(undefined);
            launchGame(launchChoice, "room");
          }}
          onJoinRoom={(roomId) => {
            setLaunchChoice(undefined);
            void joinRoomById(roomId);
          }}
        />
      )}
      {unsupportedGame && (
        <UnsupportedGameDialog
          error={unsupportedGame.error}
          url={unsupportedGame.url}
          onClose={() => setUnsupportedGame(undefined)}
        />
      )}
    </div>
  );
}

function message(reason: unknown, fallback: string): string {
  return reason instanceof Error ? reason.message : fallback;
}
