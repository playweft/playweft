import type {
  JsonValue,
  RoomActionResult,
  RoomPresence,
  RoomSnapshot,
} from "@playweft/game-protocol";

export type RoomConnectionState =
  | "idle"
  | "connecting"
  | "connected"
  | "reconnecting"
  | "failed"
  | "closed";
export type RoomMessage =
  | RoomSnapshot
  | RoomPresence
  | RoomActionResult
  | { type: "game_changed"; manifestUrl: string }
  | { type: "room_dissolved"; error: string }
  | { type: "error"; error: string; requestId?: string };

interface ConnectionOptions {
  createSocket(): WebSocket;
  onMessage(message: RoomMessage): void;
  onState(state: RoomConnectionState): void;
  onInterrupted(): void;
  onError(restorationFailed: boolean): void;
  onLatency(rttMs: number): void;
  onClosed(): void;
  onResume(): void;
}

const MAX_RECONNECT_ATTEMPTS = 5;
const HEARTBEAT_IDLE_MS = 20_000;
const LATENCY_SAMPLE_INTERVAL_MS = 3_000;
const LATENCY_PROBE_TIMEOUT_MS = 10_000;

/** Owns exactly one active socket. Replaced sockets cannot affect its timers. */
export class RoomConnection {
  private socket?: WebSocket;
  private heartbeatTimer?: number;
  private reconnectTimer?: number;
  private suppressTimer?: number;
  private suppressError = false;
  private attempts = 0;
  private closed = false;
  private started = false;
  private heartbeatRequired = false;
  private nextSampleAt = 0;
  private probe?: { ackId: string; sentAt: number; timeout: number };

  constructor(private readonly options: ConnectionOptions) {}

  start(): void {
    if (this.started || this.closed) return;
    this.started = true;
    document.addEventListener("visibilitychange", this.onVisibilityChange);
    this.connect();
  }

  setHeartbeatRequired(required: boolean): void {
    if (this.closed || this.heartbeatRequired === required) return;
    this.heartbeatRequired = required;
    if (required && this.socket?.readyState === WebSocket.OPEN)
      this.send({ type: "heartbeat" });
    this.scheduleHeartbeat();
  }

  noteActivity(): void {
    if (this.heartbeatRequired) this.scheduleHeartbeat();
  }

  send(message: Record<string, JsonValue>): void {
    if (this.closed || this.socket?.readyState !== WebSocket.OPEN) {
      throw new Error("The room connection is not ready");
    }
    const now = performance.now();
    let ackId: string | undefined;
    if (!this.probe && now >= this.nextSampleAt) {
      ackId = crypto.randomUUID();
      this.probe = {
        ackId,
        sentAt: now,
        timeout: window.setTimeout(
          () => this.clearProbe(),
          LATENCY_PROBE_TIMEOUT_MS,
        ),
      };
    }
    try {
      this.socket.send(JSON.stringify(ackId ? { ...message, ackId } : message));
    } catch (reason) {
      if (this.probe?.ackId === ackId) this.clearProbe();
      throw reason;
    }
  }

  dispose(): void {
    if (this.closed) return;
    this.closed = true;
    window.clearTimeout(this.reconnectTimer);
    window.clearTimeout(this.suppressTimer);
    this.clearHeartbeat();
    this.clearProbe();
    document.removeEventListener("visibilitychange", this.onVisibilityChange);
    const socket = this.socket;
    this.socket = undefined;
    socket?.close();
    this.options.onState("closed");
  }

  private connect(): void {
    if (this.closed) return;
    window.clearTimeout(this.reconnectTimer);
    this.clearHeartbeat();
    this.clearProbe();
    this.nextSampleAt = 0;
    this.options.onInterrupted();
    const previous = this.socket;
    this.socket = undefined;
    previous?.close();
    this.options.onState(this.attempts > 0 ? "reconnecting" : "connecting");
    let socket: WebSocket;
    try {
      socket = this.options.createSocket();
    } catch {
      this.options.onError(false);
      this.scheduleReconnect();
      return;
    }
    this.socket = socket;
    const isCurrent = () => !this.closed && this.socket === socket;
    socket.onopen = () => {
      if (!isCurrent()) return;
      this.send({ type: "heartbeat" });
      this.scheduleHeartbeat();
    };
    socket.onmessage = (event) => {
      if (!isCurrent()) return;
      let payload: RoomMessage | { type: "platform.ack"; ackId: string };
      try {
        payload = JSON.parse(event.data as string);
        if (!payload || typeof payload !== "object") return;
      } catch {
        return;
      }
      if (payload.type === "platform.ack") {
        if (!this.probe || payload.ackId !== this.probe.ackId) return;
        const rttMs = Math.round(performance.now() - this.probe.sentAt);
        this.clearProbe();
        this.nextSampleAt = performance.now() + LATENCY_SAMPLE_INTERVAL_MS;
        this.options.onLatency(rttMs);
        return;
      }
      if (payload.type === "room_dissolved") {
        this.options.onClosed();
        return;
      }
      if (
        payload.type === "snapshot" ||
        payload.type === "state" ||
        payload.type === "room.presence" ||
        payload.type === "game_changed"
      ) {
        this.attempts = 0;
        this.options.onState("connected");
      }
      this.options.onMessage(payload);
    };
    socket.onerror = () => {
      if (!isCurrent()) return;
      if (this.suppressError) {
        this.suppressError = false;
        window.clearTimeout(this.suppressTimer);
        return;
      }
      this.options.onError(false);
    };
    socket.onclose = (event) => {
      if (!isCurrent()) return;
      this.socket = undefined;
      this.clearHeartbeat();
      this.clearProbe();
      this.options.onInterrupted();
      if (event.code === 4004) {
        this.options.onClosed();
        return;
      }
      this.scheduleReconnect();
    };
  }

  private scheduleReconnect(): void {
    if (this.closed) return;
    if (this.attempts >= MAX_RECONNECT_ATTEMPTS) {
      this.options.onState("failed");
      this.options.onError(true);
      return;
    }
    this.attempts += 1;
    this.options.onState("reconnecting");
    this.reconnectTimer = window.setTimeout(() => this.connect(), 2_000);
  }

  private onVisibilityChange = (): void => {
    if (this.closed || document.visibilityState !== "visible") return;
    this.suppressError = true;
    window.clearTimeout(this.suppressTimer);
    this.suppressTimer = window.setTimeout(() => {
      this.suppressError = false;
    }, 5_000);
    this.attempts = 0;
    this.options.onResume();
    this.connect();
  };

  private scheduleHeartbeat(): void {
    this.clearHeartbeat();
    if (
      !this.heartbeatRequired ||
      this.closed ||
      this.socket?.readyState !== WebSocket.OPEN
    )
      return;
    this.heartbeatTimer = window.setTimeout(() => {
      this.send({ type: "heartbeat" });
      this.scheduleHeartbeat();
    }, HEARTBEAT_IDLE_MS);
  }

  private clearHeartbeat(): void {
    window.clearTimeout(this.heartbeatTimer);
    this.heartbeatTimer = undefined;
  }

  private clearProbe(): void {
    if (this.probe) window.clearTimeout(this.probe.timeout);
    this.probe = undefined;
  }
}
