import { useCallback, useEffect, useState } from "react";
import { useI18n } from "@/app/i18n";
import {
  loadGameManifest,
  type DiscoveredGame,
  type LoadedGame,
} from "./game-manifest";
import { useGameViewport } from "./use-game-viewport";

type ManifestResult =
  | { url: string; loaded: LoadedGame }
  | { url: string; error: unknown };

export function useSoloGameLaunch(discovered: DiscoveredGame, closing: boolean) {
  const { t } = useI18n();
  const { manifestUrl } = discovered;
  const [result, setResult] = useState<ManifestResult>();
  const current = result?.url === manifestUrl ? result : undefined;
  const loaded = current && "loaded" in current ? current.loaded : undefined;
  const loadError = current && "error" in current
    ? current.error instanceof Error ? current.error.message : t("unexpectedError")
    : undefined;
  const game = loaded?.game ?? discovered;
  const viewport = useGameViewport(!closing, game);

  useEffect(() => {
    if (closing || viewport.deferGameLoad || loaded) return;
    let active = true;
    void loadGameManifest(manifestUrl).then(
      (loaded) => { if (active) setResult({ url: manifestUrl, loaded }); },
      (error: unknown) => { if (active) setResult({ url: manifestUrl, error }); },
    );
    return () => { active = false; };
  }, [closing, loaded, manifestUrl, viewport.deferGameLoad]);

  const [{ revision, ready: frameReady }, setFrame] = useState({ revision: 0, ready: false });
  const onFrameLoad = useCallback(() => {
    setFrame((frame) => {
      if (frame.revision !== revision || frame.ready) return frame;
      return { ...frame, ready: true };
    });
  }, [revision]);
  const refreshFrame = useCallback(() => {
    setFrame((frame) => ({ revision: frame.revision + 1, ready: false }));
  }, []);

  function dismissLoadError() {
    setResult((result) => result && "error" in result ? undefined : result);
  }

  return { game, loaded, loadError, dismissLoadError, viewport, revision, frameReady, onFrameLoad, refreshFrame };
}
