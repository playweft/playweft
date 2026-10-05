import {
  isStoredDiscoveredGame,
  type DiscoveredGame,
} from "@/features/game/game-manifest";
import { normalizeLibraryGame } from "./library-game";

const RECENT_GAMES_KEY = "playweft:recent-games:v1";
const MAX_RECENT_GAMES = 8;

export function readRecentGames(): DiscoveredGame[] {
  try {
    const parsed = JSON.parse(
      localStorage.getItem(RECENT_GAMES_KEY) ?? "[]",
    ) as unknown;
    if (!Array.isArray(parsed)) return [];
    return uniqueGames(parsed.filter(isStoredDiscoveredGame))
      .slice(0, MAX_RECENT_GAMES)
      .map(normalizeLibraryGame);
  } catch {
    return [];
  }
}

export function persistRecentGames(
  games: DiscoveredGame[],
): DiscoveredGame[] {
  const next = uniqueGames(games.map(normalizeLibraryGame)).slice(
    0,
    MAX_RECENT_GAMES,
  );
  try {
    localStorage.setItem(RECENT_GAMES_KEY, JSON.stringify(next));
  } catch {
    // Keep the in-memory list usable when browser storage is unavailable.
  }
  return next;
}

function uniqueGames(games: DiscoveredGame[]): DiscoveredGame[] {
  const seenIds = new Set<string>();
  return games.filter((game) => {
    if (seenIds.has(game.manifestId)) return false;
    seenIds.add(game.manifestId);
    return true;
  });
}

export function saveRecentGame(game: DiscoveredGame): void {
  const current = readRecentGames();
  persistRecentGames([
    game,
    ...current.filter((item) => item.manifestId !== game.manifestId),
  ]);
}
