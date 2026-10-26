import type { DiscoveredGame, GameMode } from "./game-manifest";

/** Capability and entry preference are independent; explicit links always win. */
export function gameLaunchMode(
  game: Pick<DiscoveredGame, "modes" | "launchMode">,
  requested?: string,
): GameMode | "choose" | "unavailable" {
  if (requested !== undefined) {
    return (requested === "solo" || requested === "room") && game.modes.includes(requested)
      ? requested : "unavailable";
  }
  if (game.launchMode === "solo" && game.modes.includes("solo")) return "solo";
  if (game.modes.length === 1) return game.modes[0]!;
  return game.launchMode === "choose" ? "choose" : "solo";
}
