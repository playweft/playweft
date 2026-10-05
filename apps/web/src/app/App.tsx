import { useCallback, useEffect, useRef, useState } from "react";
import { getPlatformSession } from "@/platform/platform-api";
import EntryOverlay from "@/components/EntryOverlay";
import Home from "@/features/home/Home";
import RoomHost from "@/features/room/RoomHost";
import SoloHost from "@/features/game/SoloHost";
import UpdateToast from "@/components/UpdateToast";
import {
  gameLaunchPath,
  gameModeFromExternalLaunch,
  gameUrlFromExternalLaunch,
} from "@/features/game/game-launch-link";
import { saveRecentGame } from "@/features/library/recent-games";
import type { DiscoveredGame as RecentGame } from "@/features/game/game-manifest";
import { useI18n } from "@/app/i18n";
import {
  persistAccountPlayerNickname,
  persistGuestPlayerNickname,
  readAccountPlayerNickname,
  readGuestPlayerNickname,
} from "@/features/account/player-profile";
import { prepareGameOrientation } from "@/features/game/use-game-viewport";
import { usePwaUpdate } from "@/app/use-pwa-update";

const SOLO_EXIT_DURATION_MS = 160;

export default function App() {
  const { t } = useI18n();
  const pwaUpdate = usePwaUpdate();
  const [location, setLocation] = useState(readAppLocation);
  const [entryStatus, setEntryStatus] = useState<string>();
  const [soloGame, setSoloGame] = useState<RecentGame>();
  const [soloClosing, setSoloClosing] = useState(false);
  // The local guest nickname is available synchronously for the home UI. It
  // is not, by itself, permission to join a room: RoomHost waits for the
  // platform identity bootstrap below before mutating room membership.
  const [nickname, setNickname] = useState(readGuestPlayerNickname);
  const [identityReady, setIdentityReady] = useState(false);
  const identityRef = useRef<{ nickname: string; accountKey?: string }>(undefined);
  const identityWaiters = useRef<Array<(nickname: string) => void>>([]);
  const accountKeyRef = useRef<string | undefined>(undefined);
  const entryGeneration = useRef(0);
  const handledExternalGameUrl = useRef<string | undefined>(undefined);
  const soloGameRef = useRef<RecentGame | undefined>(undefined);
  const soloExitTimer = useRef<number | undefined>(undefined);
  const path = new URL(location, window.location.origin).pathname;
  const externalGameUrl = gameUrlFromExternalLaunch(location);
  const externalGameMode = gameModeFromExternalLaunch(location);
  // soloGame caches a discovered Manifest; the URL decides which view is active.
  const activeSoloGame =
    externalGameMode === "solo" && soloGame &&
    location === gameLaunchPath(soloGame.manifestUrl, "solo")
      ? soloGame
      : undefined;
  const visibleSoloGame = soloClosing ? soloGame : activeSoloGame;
  soloGameRef.current = activeSoloGame;

  useEffect(() => {
    const onPopState = () => {
      entryGeneration.current += 1;
      handledExternalGameUrl.current = undefined;
      setEntryStatus(undefined);
      const nextLocation = readAppLocation();
      setLocation(nextLocation);
      if (
        !soloGameRef.current ||
        nextLocation === gameLaunchPath(soloGameRef.current.manifestUrl, "solo")
      ) return;
      setSoloClosing(true);
      window.clearTimeout(soloExitTimer.current);
      const duration = window.matchMedia("(prefers-reduced-motion: reduce)")
        .matches
        ? 0
        : SOLO_EXIT_DURATION_MS;
      soloExitTimer.current = window.setTimeout(() => {
        setSoloGame(undefined);
        setSoloClosing(false);
      }, duration);
    };
    window.addEventListener("popstate", onPopState);
    return () => {
      window.removeEventListener("popstate", onPopState);
      window.clearTimeout(soloExitTimer.current);
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    const resolveIdentity = (nextNickname: string, accountKey?: string) => {
      identityRef.current = {
        nickname: nextNickname,
        ...(accountKey ? { accountKey } : {}),
      };
      setNickname(nextNickname);
      setIdentityReady(true);
      const waiters = identityWaiters.current.splice(0);
      for (const resolve of waiters) resolve(nextNickname);
    };
    void getPlatformSession()
      .then((session) => {
        if (cancelled) return;
        if (session.provider === "x" && session.accountKey) {
          const nextNickname = readAccountPlayerNickname(
            session.accountKey,
            session.name ?? session.accountName,
          );
          accountKeyRef.current = session.accountKey;
          resolveIdentity(nextNickname, session.accountKey);
          return;
        }
        accountKeyRef.current = undefined;
        resolveIdentity(readGuestPlayerNickname());
      })
      .catch(() => {
        if (cancelled) return;
        accountKeyRef.current = undefined;
        resolveIdentity(readGuestPlayerNickname());
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const waitForIdentity = useCallback((): Promise<string> => {
    if (identityRef.current)
      return Promise.resolve(identityRef.current.nickname);
    return new Promise((resolve) => identityWaiters.current.push(resolve));
  }, []);

  const navigate = useCallback((nextPath: string, replace = false) => {
    entryGeneration.current += 1;
    handledExternalGameUrl.current = undefined;
    setEntryStatus(undefined);
    window.clearTimeout(soloExitTimer.current);
    setSoloClosing(false);
    if (replace) window.history.replaceState({}, "", nextPath);
    else window.history.pushState({}, "", nextPath);
    setLocation(readAppLocation());
  }, []);
  const openSoloGame = useCallback((game: RecentGame) => {
    void prepareGameOrientation(game.orientation);
    const nextPath = gameLaunchPath(game.manifestUrl, "solo");
    if (nextPath !== readAppLocation()) {
      navigate(nextPath, Boolean(gameUrlFromExternalLaunch(readAppLocation())));
    }
    window.clearTimeout(soloExitTimer.current);
    setSoloClosing(false);
    setSoloGame(game);
  }, [navigate]);
  const claimExternalGameUrl = useCallback((url: string) => {
    if (handledExternalGameUrl.current === url) return false;
    handledExternalGameUrl.current = url;
    return true;
  }, []);
  const changeNickname = useCallback((value: string) => {
    const accountKey = accountKeyRef.current;
    setNickname(
      accountKey
        ? persistAccountPlayerNickname(accountKey, value)
        : persistGuestPlayerNickname(value),
    );
  }, []);
  const roomId = /^\/r\/([a-zA-Z0-9_-]{1,128})$/.exec(path)?.[1];

  useEffect(() => {
    if (roomId) setEntryStatus(undefined);
  }, [roomId]);

  useEffect(() => {
    if (!externalGameUrl) handledExternalGameUrl.current = undefined;
  }, [externalGameUrl]);

  const beginEntry = useCallback(() => {
    const generation = ++entryGeneration.current;
    setEntryStatus(t("creatingRoom"));
    return () => entryGeneration.current !== generation;
  }, [t]);

  const cancelEntry = useCallback(() => {
    entryGeneration.current += 1;
    setEntryStatus(undefined);
    setSoloGame(undefined);
    navigate("/", true);
  }, [navigate]);

  const overlayStatus = entryStatus;
  const showUpdateToast =
    pwaUpdate.updateAvailable &&
    pwaUpdate.loadPolicy === "update-prompt" &&
    path === "/" &&
    !externalGameUrl &&
    !visibleSoloGame &&
    !overlayStatus;

  if (roomId) {
    return (
      <RoomHost
        key={roomId}
        identityReady={identityReady}
        nickname={nickname}
        roomId={roomId}
        onBack={() => navigate("/", true)}
        onGameDiscovered={saveRecentGame}
        onNicknameChange={changeNickname}
      />
    );
  }

  return (
    <>
      <div
        aria-hidden={visibleSoloGame ? true : undefined}
        inert={visibleSoloGame ? true : undefined}
      >
        <Home
          key={location}
          externalGameUrl={visibleSoloGame ? undefined : externalGameUrl}
          externalGameMode={externalGameMode}
          suppressGameShelves={Boolean(externalGameUrl || visibleSoloGame)}
          nickname={nickname}
          waitForIdentity={waitForIdentity}
          onNavigate={navigate}
          onBeginEntry={beginEntry}
          onEntryStatus={setEntryStatus}
          onPlaySolo={openSoloGame}
          onClaimExternalGameUrl={claimExternalGameUrl}
          onNicknameChange={changeNickname}
        />
      </div>
      {visibleSoloGame && (
        <SoloHost
          closing={soloClosing}
          key={visibleSoloGame.manifestUrl}
          game={visibleSoloGame}
          nickname={nickname}
          onBack={() => navigate("/", true)}
        />
      )}
      {overlayStatus && (
        <EntryOverlay status={overlayStatus} onCancel={cancelEntry} />
      )}
      {showUpdateToast && (
        <UpdateToast
          updating={pwaUpdate.updating}
          onRefresh={() => void pwaUpdate.applyUpdate()}
          onDismiss={pwaUpdate.dismissUpdate}
        />
      )}
    </>
  );
}

function readAppLocation(): string {
  return `${window.location.pathname}${window.location.search}`;
}
