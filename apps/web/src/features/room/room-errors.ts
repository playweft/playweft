import { PlatformApiError } from "@/platform/platform-api";

export type RoomEntryFailure = "not-found" | "unavailable";

export function isRoomNotFound(reason: unknown): boolean {
  return (
    reason instanceof PlatformApiError &&
    reason.status === 404 &&
    (reason.code === "ROOM_NOT_FOUND" ||
      (reason.code === undefined && reason.message === "room does not exist"))
  );
}

export function errorMessage(reason: unknown, fallback: string): string {
  return reason instanceof Error ? reason.message : fallback;
}

export function entryFailureFrom(reason: unknown): RoomEntryFailure {
  return isRoomNotFound(reason) ? "not-found" : "unavailable";
}
