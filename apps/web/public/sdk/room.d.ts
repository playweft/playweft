export interface RoomClient {
  /** Creates a lobby for this game; the platform then replaces the solo view. */
  create(): Promise<{ roomId: string }>;
  destroy(): void;
}
export function createRoomClient(port: MessagePort): RoomClient;
