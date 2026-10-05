import {
  loadGameManifest,
  manifestUrlFromInput,
  type DiscoveredGame,
} from "./game-manifest";
import type { Translator } from "@/app/i18n";

export class UnsupportedGameUrlError extends Error {
  constructor(
    readonly url: string,
    message: string,
  ) {
    super(message);
  }
}

export function probeGame(
  value: string,
  onStatus: (status: string) => void,
  t: Translator,
): Promise<DiscoveredGame> {
  const manifestUrl = normalizeGameUrl(value, t);
  onStatus(t("checkingGame"));
  return loadGameManifest(manifestUrl)
    .then((loaded) => loaded.game)
    .catch((reason) => {
      throw new UnsupportedGameUrlError(
        manifestUrl,
        reason instanceof Error ? reason.message : t("gameBridgeUnavailable"),
      );
    });
}

function normalizeGameUrl(value: string, t: Translator): string {
  try {
    return manifestUrlFromInput(value);
  } catch {
    throw new Error(t("enterFullGameUrl"));
  }
}
