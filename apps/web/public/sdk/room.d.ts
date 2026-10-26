export interface RoomState {
  roomId: string;
  revision: number;
  phase: "lobby" | "playing";
  ownerId: string;
  selfId: string;
  players: { id: string; seat: number; ready: boolean }[];
  spectators: { id: string }[];
  minPlayers: number;
  maxPlayers: number;
  inviteUrl: string;
  lobby: "platform" | "game";
  permissions: { setConfiguration: boolean; setReady: boolean; setSeat: boolean; start: boolean; leave: boolean };
}
export interface RoomClient {
  /** Solo games with room capability: creates a lobby and replaces the solo view. */
  create(): Promise<{ roomId: string }>;
  /** Lobby methods require the corresponding game.initialize capabilities. */
  getState(): Promise<RoomState>;
  setReady(ready: boolean): Promise<RoomState>;
  setSeat(seat: number | null): Promise<RoomState>;
  start(): Promise<RoomState>;
  /** Exits the room; the platform may unload the iframe before this Promise resolves. */
  leave(): Promise<null>;
  /** Replays the most recently observed state if available. */
  onStateChanged(listener: (state: RoomState) => void): () => void;
  onClosed(listener: (event: { reason: string }) => void): () => void;
  destroy(): void;
}
export function createRoomClient(port: MessagePort): RoomClient;

export interface RoomConfiguration { minPlayers: number; maxPlayers: number; lobby: "platform" | "game" }
/** A handle belongs to one membership. After close it cannot be reused. */
export type DeepReadonly<T> = T extends object ? { readonly [K in keyof T]: DeepReadonly<T[K]> } : T;
export interface Room extends EventTarget {
  readonly id: string;
  readonly state: DeepReadonly<RoomState>;
  readonly closed: boolean;
  getConfiguration(): RoomConfiguration;
  setConfiguration(configuration: Partial<RoomConfiguration>): Promise<void>;
  setReady(ready: boolean): Promise<void>;
  setSeat(seat: number | null): Promise<void>;
  start(): Promise<void>;
  leave(): Promise<void>;
  addEventListener(type: "statechange" | "close", callback: EventListenerOrEventListenerObject | null, options?: boolean | AddEventListenerOptions): void;
}
export interface RoomServer { runtime: "lua"; entry: string; persistence: "durable" | "live" }
export type RoomCreateOptions = Partial<RoomConfiguration> & { server?: RoomServer };
export interface Rooms {
  readonly current: Room | null;
  /** Repeated creation while joined returns the current room without reconfiguration. */
  create(options?: RoomCreateOptions): Promise<Room>;
  /** Join a room for this game. Leave the current room before joining a different one. */
  join(roomId: string): Promise<Room>;
  destroy(): void;
}
export function createRoomsClient(port: MessagePort, initialState?: RoomState | null): Rooms;
