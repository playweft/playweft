import { gameUrlFromExternalLaunch } from "@/features/game/game-launch-link";
import { roomIdFromInput } from "@/features/room/room-code";

type LaunchInput =
  | { kind: "room"; roomId: string }
  | { kind: "game-link"; path: string }
  | { kind: "game-source"; url: string };

export function parseLaunchInput(
  value: string,
  origin = window.location.origin,
): LaunchInput {
  const input = value.trim();
  const roomId = roomIdFromInput(input);
  if (roomId) return { kind: "room", roomId };

  try {
    const url = new URL(input);
    if (url.origin === origin) {
      const roomPath = /^\/r\/([^/]+)\/?$/.exec(url.pathname);
      const linkedRoomId = roomPath && roomIdFromInput(roomPath[1]);
      if (linkedRoomId) return { kind: "room", roomId: linkedRoomId };
      if (gameUrlFromExternalLaunch(url.href)) {
        return { kind: "game-link", path: `${url.pathname}${url.search}` };
      }
    }
  } catch {
    // Other input follows the existing game-source validation path.
  }
  return { kind: "game-source", url: input };
}
