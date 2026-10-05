import type { DiscoveredGame } from "@/features/game/game-manifest";

export function normalizeLibraryGame(game: DiscoveredGame): DiscoveredGame {
  return {
    ...game,
    url: new URL(game.url, window.location.origin).toString(),
  };
}
