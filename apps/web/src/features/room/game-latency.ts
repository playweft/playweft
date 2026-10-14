import type { PlatformLatency } from "@playweft/game-protocol";
import type { RoomSessionState } from "./RoomSession";

/** Game latency follows its authority, independently of the room control socket. */
export function gameLatency(state: RoomSessionState): PlatformLatency {
  if (!state.presence?.localHost) {
    return reading("platform", state.latency, state.connection === "connected");
  }
  if (state.selfId === state.presence.localHost.id) {
    return reading("local", 0, state.peerTransport === "host");
  }
  const direct = state.peerTransport === "webrtc";
  return reading(
    direct ? "webrtc" : "relay",
    state.peerLatency,
    direct ||
      (state.peerTransport === "relay" && state.connection === "connected"),
  );
}

function reading(
  transport: PlatformLatency["transport"],
  rttMs: number | undefined,
  available: boolean,
): PlatformLatency {
  if (!available) return { transport, status: "unavailable" };
  return rttMs === undefined
    ? { transport, status: "measuring" }
    : { transport, status: "ready", rttMs: Math.round(rttMs) };
}
