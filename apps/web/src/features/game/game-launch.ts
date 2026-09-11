import type { ShelfGame } from "@/features/game/GameShelf";
import {
  loadGameManifest,
  manifestUrlFromInput,
  type DiscoveredGame as RecentGame,
  type GameMode,
} from "@/features/game/game-manifest";
import type { Translator } from "@/app/i18n";
import { persistRecentGames, readRecentGames } from "@/features/game/recent-games";

const DEFAULT_ROOM_ID_FORMAT = "code:4";
const CODE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";

type RoomIdFormat =
  | { kind: "uuid" }
  | { kind: "code" | "digits" | "base64url"; length: number };

export class UnsupportedGameUrlError extends Error {
  constructor(
    readonly url: string,
    message: string,
  ) {
    super(message);
  }
}

export function saveRecentGame(game: RecentGame): void {
  const current = readRecentGames();
  persistRecentGames([
    game,
    ...current.filter((item) => item.manifestId !== game.manifestId),
  ]);
}

export function toRecentGame(game: ShelfGame): RecentGame {
  return {
    ...game,
    url: new URL(game.url, window.location.origin).toString(),
  };
}

export function supportedModes(game: ShelfGame): GameMode[] {
  return game.modes;
}

export function probeGame(
  value: string,
  onStatus: (status: string) => void,
  t: Translator,
): Promise<RecentGame> {
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

export function gameUrlFromExternalLaunch(
  location: string,
): string | undefined {
  const url = new URL(location, window.location.origin);
  if (url.pathname !== "/") return undefined;
  const value = url.searchParams.get("game")?.trim();
  if (!value) return undefined;
  return /^[a-z][a-z\d+.-]*:/i.test(value) ? value : `https://${value}`;
}

export function roomIdFromInput(value: string): string | undefined {
  const input = value.trim();
  if (!input) return undefined;
  const format = roomIdFormat(import.meta.env.VITE_ROOM_ID_FORMAT);
  switch (format.kind) {
    case "uuid":
      return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        input,
      )
        ? input.toLowerCase()
        : undefined;
    case "digits":
      return new RegExp(`^\\d{${format.length}}$`).test(input)
        ? input
        : undefined;
    case "base64url":
      return new RegExp(`^[A-Za-z0-9_-]{${format.length}}$`).test(input)
        ? input
        : undefined;
    case "code": {
      const uppercased = input.toUpperCase();
      return uppercased.length === format.length &&
        [...uppercased].every((character) => CODE_ALPHABET.includes(character))
        ? uppercased
        : undefined;
    }
  }
}

function normalizeGameUrl(value: string, t: Translator): string {
  try {
    return manifestUrlFromInput(value);
  } catch {
    throw new Error(t("enterFullGameUrl"));
  }
}

function roomIdFormat(value: string | undefined): RoomIdFormat {
  const configured = (value?.trim() || DEFAULT_ROOM_ID_FORMAT).toLowerCase();
  if (configured === "uuid") return { kind: "uuid" };
  const match = /^(code|digits|base64url):([1-9]\d{0,2})$/.exec(configured);
  if (!match) return { kind: "code", length: 4 };
  return {
    kind: match[1] as "code" | "digits" | "base64url",
    length: Number(match[2]),
  };
}
