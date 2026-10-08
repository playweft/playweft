import { useEffect, useRef, useState } from "react";
import { useI18n, localizeGameDescription, localizeGameName } from "@/app/i18n";
import {
  isFavoriteGame,
  toggleFavoriteGame,
} from "@/features/library/favorite-games";
import {
  prepareGameOrientation,
  releaseGameFullscreen,
} from "@/features/game/use-game-viewport";
import { RoomSession, type RoomSessionState } from "./RoomSession";

/** Page-only state: menus, dialogs, tooltips and orientation affordances. */
export function useRoomControls(
  session: RoomSession | undefined,
  state: RoomSessionState,
  onBack: () => void,
) {
  const { locale, t } = useI18n();
  const game = state.loadedGame?.game;
  const lobby = state.presence;
  const selfId = state.selfId;
  const phase = lobby?.phase ?? "lobby";
  const gameName = game ? localizeGameName(game, locale) : t("gameRoom");
  const gameDescription = game
    ? localizeGameDescription(game, locale)
    : undefined;
  const isOwner = Boolean(selfId && lobby?.ownerId === selfId);
  const selfPlayer = lobby?.players.find((player) => player.id === selfId);
  const isSpectating = Boolean(selfId && lobby && !selfPlayer);
  const firstOpenSeat = lobby
    ? Array.from({ length: lobby.maxPlayers }, (_, i) => i + 1).find(
        (seat) => !lobby.players.some((player) => player.seat === seat),
      )
    : undefined;
  const canStart = Boolean(
    lobby &&
      lobby.players.length >= lobby.minPlayers &&
      lobby.players.every(
        (player) => player.id === lobby.ownerId || player.ready,
      ),
  );
  const [copied, setCopied] = useState(false);
  const [starting, setStarting] = useState(false);
  const [startUnavailableHint, setStartUnavailableHint] = useState<string>();
  const [startUnavailableHintClosing, setStartUnavailableHintClosing] =
    useState(false);
  const hintTimer = useRef<number | undefined>(undefined);
  const copyTimer = useRef<number | undefined>(undefined);
  const [inviteDialogOpen, setInviteDialogOpen] = useState(false);
  const [leaveDialogOpen, setLeaveDialogOpen] = useState(false);
  const [gameInfoOpen, setGameInfoOpen] = useState(false);
  const [gameHelpOpen, setGameHelpOpen] = useState(false);
  const [changeGameOpen, setChangeGameOpen] = useState(false);
  const [dissolveDialogOpen, setDissolveDialogOpen] = useState(false);
  const [isFavorite, setIsFavorite] = useState(false);
  const missing = lobby
    ? Math.max(0, lobby.minPlayers - lobby.players.length)
    : 0;
  const startUnavailableReason = starting
    ? t("startInProgress")
    : missing > 0
      ? t("needMorePlayers", {
          count: missing,
          suffix: locale === "en" && missing !== 1 ? "s" : "",
        })
      : !canStart
        ? t("waitingForPlayersReady")
        : undefined;

  useEffect(() => {
    if (game) setIsFavorite(isFavoriteGame(game));
  }, [game]);
  useEffect(() => {
    setGameHelpOpen(false);
  }, [game?.manifestUrl]);
  useEffect(() => {
    document.title = `${gameName} | Playweft`;
    return () => {
      document.title = "Playweft";
    };
  }, [gameName]);
  useEffect(
    () => () => {
      window.clearTimeout(hintTimer.current);
      window.clearTimeout(copyTimer.current);
    },
    [],
  );

  const setError = (error?: string) => session?.setError(error);
  const shareInvite = async () => {
    if (typeof navigator.share === "function") {
      try {
        await navigator.share({ url: window.location.href });
      } catch (error) {
        if (error instanceof Error && error.name === "AbortError") return;
        setError(t("inviteShareFailed"));
      }
      return;
    }
    try {
      await navigator.clipboard.writeText(window.location.href);
      setCopied(true);
      window.clearTimeout(copyTimer.current);
      copyTimer.current = window.setTimeout(() => setCopied(false), 1_500);
    } catch {
      setError(t("inviteCopyFailed"));
    }
  };
  const start = async () => {
    if (!session || starting) return;
    const orientationAttempt = prepareGameOrientation(game?.orientation);
    setStarting(true);
    const started = await session.start();
    setStarting(false);
    if (!started) void orientationAttempt.then(() => releaseGameFullscreen());
  };
  const showStartUnavailableHint = () => {
    if (!startUnavailableReason) return;
    setStartUnavailableHint(startUnavailableReason);
    setStartUnavailableHintClosing(false);
    window.clearTimeout(hintTimer.current);
    hintTimer.current = window.setTimeout(
      () => setStartUnavailableHintClosing(true),
      2_500,
    );
  };

  return {
    game,
    gameUrl: game?.url,
    gameName,
    gameDescription,
    gameIconHref: game?.icon,
    gameHelpHref: game?.helpUrl,
    lobby,
    selfId,
    phase,
    isOwner,
    selfPlayer,
    isSpectating,
    firstOpenSeat,
    spectatorCount: lobby?.spectators.length ?? 0,
    playerCapacity: lobby?.maxPlayers ?? 0,
    copied,
    shareInvite,
    starting,
    start,
    startUnavailableReason,
    startUnavailableHint,
    startUnavailableHintClosing,
    showStartUnavailableHint,
    setStartUnavailableHint,
    setStartUnavailableHintClosing,
    inviteDialogOpen,
    setInviteDialogOpen,
    leaveDialogOpen,
    setLeaveDialogOpen,
    gameInfoOpen,
    setGameInfoOpen,
    gameHelpOpen,
    setGameHelpOpen,
    changeGameOpen,
    setChangeGameOpen,
    dissolveDialogOpen,
    setDissolveDialogOpen,
    isFavorite,
    toggleFavorite: () => {
      if (game) setIsFavorite(toggleFavoriteGame(game));
    },
    setError,
    requestBack: () => {
      if (selfId) setLeaveDialogOpen(true);
      else onBack();
    },
    leave: () => session?.leave(),
    dissolve: () => session?.dissolve(),
    chooseSeat: (seat: number | null) => session?.chooseSeat(seat),
    setReady: () => session?.setReady(),
    kick: (playerId: string) => session?.kick(playerId),
    transferHost: (playerId: string) => session?.transferHost(playerId),
    joinFirstOpenSeat: () => {
      if (firstOpenSeat !== undefined) void session?.chooseSeat(firstOpenSeat);
    },
    returnToRoom: async () => {
      if (await session?.returnToRoom()) setGameInfoOpen(false);
    },
    changeGame: (url: string) => {
      setChangeGameOpen(false);
      return session?.changeGame(url);
    },
    refreshGame: () => session?.refreshGame(),
  };
}

export type RoomControls = ReturnType<typeof useRoomControls>;
