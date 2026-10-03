import { useEffect, useRef, useState } from "react";
import * as api from "@/platform/platform-api";
import {
  loadGameManifest,
  manifestUrlFromInput,
  type DiscoveredGame,
} from "@/features/game/game-manifest";
import { useI18n } from "@/app/i18n";
import {
  RoomSession,
  initialRoomState,
  type RoomSessionState,
} from "./RoomSession";

const services = { ...api, loadGameManifest, manifestUrlFromInput };

export function useRoomSession(options: {
  roomId: string;
  identityReady: boolean;
  nickname: string;
  onBack(): void;
  onGameDiscovered(game: DiscoveredGame): void;
}) {
  const { t } = useI18n();
  const latest = useRef({ ...options, t });
  latest.current = { ...options, t };
  const [session, setSession] = useState<RoomSession>();
  const [state, setState] = useState<RoomSessionState>(initialRoomState);

  useEffect(() => {
    if (!options.identityReady) {
      setSession(undefined);
      setState(initialRoomState);
      return;
    }
    const current = new RoomSession(options.roomId, services, {
      nickname: () => latest.current.nickname,
      message: (key) => latest.current.t(key),
      onGameDiscovered: (game) => latest.current.onGameDiscovered(game),
      onEnd: () => latest.current.onBack(),
    });
    const unsubscribe = current.subscribe(() => setState(current.getState()));
    setSession(current);
    setState(current.getState());
    void current.enter();
    return () => {
      unsubscribe();
      current.dispose();
    };
  }, [options.roomId, options.identityReady]);

  useEffect(() => {
    void session?.syncNickname();
  }, [session, options.nickname, state.lifecycle, state.presence?.phase]);

  return { session, state };
}
