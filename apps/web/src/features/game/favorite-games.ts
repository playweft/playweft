import {
  isStoredDiscoveredGame,
  type DiscoveredGame,
} from "@/features/game/game-manifest";

const FAVORITE_GAMES_KEY = "playweft:favorite-games:v1";
const MAX_FAVORITE_GAMES = 8;

export function readFavoriteGames(): DiscoveredGame[] {
  return uniqueGames(readStoredGames().map(normalizeGame)).slice(
    0,
    MAX_FAVORITE_GAMES,
  );
}

export function persistFavoriteGames(
  games: DiscoveredGame[],
): DiscoveredGame[] {
  const next = uniqueGames(games).slice(0, MAX_FAVORITE_GAMES);
  try {
    localStorage.setItem(FAVORITE_GAMES_KEY, JSON.stringify(next));
  } catch {
    // Keep the in-memory list usable when browser storage is unavailable.
  }
  return next;
}

export function isFavoriteGame(game: DiscoveredGame): boolean {
  return readFavoriteGames().some(
    (favorite) => favorite.manifestId === game.manifestId,
  );
}

export function toggleFavoriteGame(game: DiscoveredGame): boolean {
  const favorites = readFavoriteGames();
  const isFavorite = favorites.some(
    (favorite) => favorite.manifestId === game.manifestId,
  );
  persistFavoriteGames(
    isFavorite
      ? favorites.filter(
          (favorite) => favorite.manifestId !== game.manifestId,
        )
      : [normalizeGame(game), ...favorites],
  );
  return !isFavorite;
}

function readStoredGames(): DiscoveredGame[] {
  try {
    const parsed = JSON.parse(
      localStorage.getItem(FAVORITE_GAMES_KEY) ?? "[]",
    ) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isStoredDiscoveredGame);
  } catch {
    return [];
  }
}

function normalizeGame(game: DiscoveredGame): DiscoveredGame {
  return {
    ...game,
    url: new URL(game.url, window.location.origin).toString(),
  };
}

function uniqueGames(games: DiscoveredGame[]): DiscoveredGame[] {
  const seenIds = new Set<string>();
  return games.filter((game) => {
    if (seenIds.has(game.manifestId)) return false;
    seenIds.add(game.manifestId);
    return true;
  });
}
