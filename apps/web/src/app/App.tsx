import { useCallback, useEffect, useRef, useState } from "react";
import { getPlatformSession } from "@/platform/platform-api";
import EntryOverlay from "@/components/EntryOverlay";
import Home from "@/features/home/Home";
import RoomHost from "@/features/room/RoomHost";
import SoloHost from "@/features/game/SoloHost";
import UpdateToast from "@/components/UpdateToast";
import { gameLaunchPath } from "@/features/game/game-launch-link";
import { gameUrlFromExternalLaunch, saveRecentGame } from "@/features/game/game-launch";
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
  soloGameRef.current = soloGame;
  const path = new URL(location, window.location.origin).pathname;
  const externalGameUrl = gameUrlFromExternalLaunch(location);

  useEffect(() => {
    const onPopState = () => {
      setLocation(readAppLocation());
      if (!soloGameRef.current) return;
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

  const navigate = useCallback((nextPath: string) => {
    window.history.pushState({}, "", nextPath);
    setLocation(readAppLocation());
  }, []);
  const openSoloGame = useCallback((game: RecentGame) => {
    void prepareGameOrientation(game.orientation);
    window.clearTimeout(soloExitTimer.current);
    setSoloClosing(false);
    const nextPath = gameLaunchPath(game.manifestUrl);
    if (gameUrlFromExternalLaunch(readAppLocation())) {
      window.history.replaceState({}, "", "/");
    }
    window.history.pushState({ playweftView: "solo" }, "", nextPath);
    setLocation(readAppLocation());
    setSoloGame(game);
  }, []);
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
    navigate("/");
  }, [navigate]);

  const overlayStatus = entryStatus;
  const showUpdateToast =
    pwaUpdate.updateAvailable &&
    pwaUpdate.loadPolicy === "update-prompt" &&
    path === "/" &&
    !externalGameUrl &&
    !soloGame &&
    !overlayStatus;

  if (roomId) {
    return (
      <RoomHost
        key={roomId}
        identityReady={identityReady}
        nickname={nickname}
        roomId={roomId}
        onBack={() => navigate("/")}
        onGameDiscovered={saveRecentGame}
        onNicknameChange={changeNickname}
      />
    );
  }

  return (
    <>
      <div
        aria-hidden={soloGame ? true : undefined}
        inert={soloGame ? true : undefined}
      >
        <Home
          externalGameUrl={soloGame ? undefined : externalGameUrl}
          suppressGameShelves={Boolean(externalGameUrl || soloGame)}
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
      {soloGame && (
        <SoloHost
          closing={soloClosing}
          game={soloGame}
          nickname={nickname}
          onBack={() => window.history.back()}
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
