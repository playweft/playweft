import {
  isJson,
  type JsonValue,
  type RoomPresence,
  type RoomSnapshot,
} from "@playweft/game-protocol";
import { LuaHost } from "./LuaHost";
import type { GameRuntime } from "@playweft/runtime-core";
import type { RoomLocalRuntime } from "@playweft/game-protocol";

export type PeerTransport = "host" | "webrtc" | "relay" | "paused";
export type PeerEnvelope = {
  type: "peer";
  fromId: string;
  matchId: string;
  kind: "signal" | "data";
  body: JsonValue;
};
interface Peer {
  pc: RTCPeerConnection;
  channel?: RTCDataChannel;
  lastDirect: number;
  candidates: RTCIceCandidateInit[];
}
interface Options {
  selfId: string;
  instanceId: string;
  presence: RoomPresence;
  sendRelay(targetId: string, kind: "signal" | "data", body: JsonValue): void;
  onSnapshot(snapshot: RoomSnapshot): void;
  onTransport(transport: PeerTransport): void;
  onLatency?(milliseconds: number | undefined): void;
  relayAvailable?: boolean;
  createPeer?(): RTCPeerConnection;
  loadHost(): Promise<{ runtime: GameRuntime; boot: RoomLocalRuntime }>;
  onError?(error: Error): void;
}
const record = (value: unknown): value is Record<string, JsonValue> =>
  !!value && typeof value === "object" && !Array.isArray(value);

/** One pinned browser authority. Relay and WebRTC carry the same authenticated protocol. */
export class LocalHostRoom {
  private readonly match: NonNullable<RoomPresence["localHost"]>;
  private readonly host: boolean;
  private engine?: LuaHost;
  private loading = false;
  private peers = new Map<string, Peer>();
  private members = new Set<string>();
  private paused = false;
  private authorityPaused = false;
  private closed = false;
  private timer: number;
  private relayAvailable: boolean;
  private transport?: PeerTransport;
  private measuredAt?: number;
  private probes = new Map<string, { id: string; sentAt: number }>();
  private pending = new Map<
    string,
    {
      body: JsonValue;
      resolve(value: JsonValue): void;
      reject(error: Error): void;
      started: number;
    }
  >();

  constructor(private options: Options) {
    this.match = options.presence.localHost!;
    this.relayAvailable = options.relayAvailable ?? true;
    this.host = options.selfId === this.match.id;
    this.loading = this.host && options.instanceId === this.match.instanceId;
    this.setPresence(options.presence);
    if (this.loading) void this.initialize();
    this.timer = window.setInterval(() => this.tick(), 250);
    this.tick();
  }
  setPresence(presence: RoomPresence): void {
    if (this.closed) return;
    this.options.presence = presence;
    this.members = new Set(
      [...presence.players, ...presence.spectators].map((member) => member.id),
    );
    try {
      if (this.engine?.setPresence(presence)) this.publish();
    } catch (error) {
      this.fail(error);
    }
    this.paused =
      this.authorityPaused ||
      !this.members.has(this.match.id) ||
      (this.host && !this.engine && !this.loading);
    for (const [id, peer] of this.peers)
      if (!this.members.has(id)) {
        this.peers.delete(id);
        peer.pc.close();
      }
    if (this.host && !this.paused && presence.connectionMode === "local-host")
      for (const id of this.members)
        if (id !== this.options.selfId && !this.peers.has(id))
          void this.offer(id);
    this.status();
  }
  setRelayAvailable(available: boolean): void {
    this.relayAvailable = available;
    this.status();
  }
  action(id: string, action: JsonValue): Promise<JsonValue> {
    if (!id || id.length > 128)
      return Promise.reject(new Error("Invalid request id"));
    if (this.closed || this.paused)
      return Promise.reject(
        new Error(
          "Local host unavailable. Return to the lobby and start again.",
        ),
      );
    if (this.host) {
      if (!this.engine)
        return Promise.reject(new Error("Local runtime is loading"));
      try {
        return Promise.resolve(this.apply(this.options.selfId, id, action));
      } catch (error) {
        this.fail(error);
        return Promise.reject(error);
      }
    }
    return this.request(id, { type: "action", id, action });
  }
  async canReturnToRoom(): Promise<boolean> {
    if (this.closed || this.paused || (this.host && !this.engine)) return true;
    if (this.host) {
      const allowed = this.engine!.returnToRoom(this.options.selfId);
      this.publish();
      return allowed;
    }
    const id = crypto.randomUUID();
    try {
      return (await this.request(id, { type: "return-query", id })) === true;
    } catch {
      return true;
    } // Room management can restart a match whose authority no longer responds.
  }
  private request(id: string, body: JsonValue): Promise<JsonValue> {
    if (this.pending.has(id))
      return Promise.reject(new Error("Duplicate request id"));
    return new Promise((resolve, reject) => {
      this.pending.set(id, { body, resolve, reject, started: Date.now() });
      this.send(this.match.id, body);
    });
  }
  receive(envelope: PeerEnvelope): void {
    if (
      this.closed ||
      envelope.matchId !== this.match.matchId ||
      !this.members.has(envelope.fromId)
    )
      return;
    if (!this.host && envelope.fromId !== this.match.id) return;
    if (envelope.kind === "signal")
      void this.signal(envelope.fromId, envelope.body);
    else {
      try {
        this.data(envelope.fromId, envelope.body, "relay");
      } catch (error) {
        this.fail(error);
      }
    }
  }
  dispose(): void {
    if (this.closed) return;
    this.closed = true;
    this.probes.clear();
    window.clearInterval(this.timer);
    for (const peer of this.peers.values()) peer.pc.close();
    this.peers.clear();
    this.engine?.dispose();
    this.engine = undefined;
    for (const pending of this.pending.values())
      pending.reject(new Error("Local match was closed"));
    this.pending.clear();
  }
  private async initialize(): Promise<void> {
    try {
      const { runtime, boot } = await this.options.loadHost();
      if (this.closed) {
        runtime.dispose();
        return;
      }
      if (boot.matchId !== this.match.matchId) {
        runtime.dispose();
        throw new Error("Local match was replaced");
      }
      try {
        this.engine = new LuaHost(runtime, boot, this.options.presence);
      } catch (error) {
        runtime.dispose();
        throw error;
      }
      this.loading = false;
      this.setPresence(this.options.presence);
      if (!this.paused) this.publish();
      this.status();
    } catch (error) {
      if (!this.closed) this.fail(error);
    }
  }
  private fail(reason: unknown): void {
    if (this.closed) return;
    this.loading = false;
    this.authorityPaused = true;
    this.paused = true;
    this.options.onError?.(
      reason instanceof Error ? reason : new Error(String(reason)),
    );
    this.status();
    if (this.host)
      for (const member of this.members)
        if (member !== this.options.selfId)
          this.send(member, { type: "paused" });
  }
  private status(): void {
    if (this.closed) return;
    const transport: PeerTransport = this.paused
      ? "paused"
      : this.host
        ? "host"
        : this.direct(this.match.id)
          ? "webrtc"
          : this.relayAvailable
            ? "relay"
            : "paused";
    if (transport !== this.transport) {
      this.transport = transport;
      this.probes.clear();
      this.measuredAt = undefined;
      this.options.onTransport(transport);
      this.options.onLatency?.(undefined);
    }
  }
  private probe(id: string, transport: "webrtc" | "relay"): void {
    const key = `${id}:${transport}`,
      now = performance.now(),
      old = this.probes.get(key);
    if (old && now - old.sentAt < 6_000) return;
    const probe = { id: crypto.randomUUID(), sentAt: now };
    this.probes.set(key, probe);
    if (!this.sendVia(id, { type: "ping", id: probe.id }, transport))
      this.probes.delete(key);
  }
  /** Probe replies never switch paths; a failed direct pong must not use relay. */
  private sendVia(
    id: string,
    body: JsonValue,
    transport: "webrtc" | "relay",
  ): boolean {
    if (this.closed) return false;
    try {
      if (transport === "webrtc") {
        const channel = this.peers.get(id)?.channel;
        if (
          channel?.readyState !== "open" ||
          channel.bufferedAmount >= 64 * 1024
        )
          return false;
        channel.send(JSON.stringify(body));
      } else {
        if (!this.relayAvailable) return false;
        this.options.sendRelay(id, "data", body);
      }
      return true;
    } catch {
      if (transport === "webrtc") {
        const peer = this.peers.get(id);
        if (peer) peer.lastDirect = 0;
        this.status();
      }
      return false;
    }
  }
  private direct(id: string): RTCDataChannel | undefined {
    const peer = this.peers.get(id);
    return peer?.channel?.readyState === "open" &&
      Date.now() - peer.lastDirect < 6_000 &&
      peer.channel.bufferedAmount < 64 * 1024
      ? peer.channel
      : undefined;
  }
  private send(id: string, body: JsonValue): void {
    if (this.closed) return;
    try {
      const channel = this.direct(id);
      if (channel) {
        channel.send(JSON.stringify(body));
        return;
      }
    } catch {
      const peer = this.peers.get(id);
      if (peer) peer.lastDirect = 0;
      this.status();
      /* Switch transport, keep the same action id and authority. */
    }
    try {
      this.options.sendRelay(id, "data", body);
    } catch {
      /* tick retries while the platform socket reconnects. */
    }
  }
  private data(from: string, body: JsonValue, path: "webrtc" | "relay"): void {
    if (!record(body) || this.closed) return;
    if (body.type === "ping") {
      if (typeof body.id === "string" && body.id.length <= 128)
        this.sendVia(from, { type: "pong", id: body.id }, path);
      return;
    }
    if (body.type === "pong") {
      const key = `${from}:${path}`,
        probe = this.probes.get(key);
      if (!probe || body.id !== probe.id) return;
      this.probes.delete(key);
      const elapsed = performance.now() - probe.sentAt;
      // Host-to-player pings maintain channel health but are not the host game's RTT.
      if (
        !this.host &&
        from === this.match.id &&
        path === this.transport &&
        elapsed >= 0 &&
        elapsed < 6_000
      ) {
        this.measuredAt = performance.now();
        this.options.onLatency?.(Math.round(elapsed));
      }
      return;
    }
    if (this.host) {
      if (this.paused) {
        this.send(from, { type: "paused" });
        return;
      }
      if (!this.engine) return; // Peers retry hello/actions while the host lazily loads Lua.
      if (body.type === "hello")
        this.send(from, {
          type: "snapshot",
          snapshot: this.engine!.snapshot(from) as unknown as JsonValue,
        });
      else if (
        body.type === "return-query" &&
        typeof body.id === "string" &&
        body.id.length <= 128
      ) {
        const result = this.engine.returnToRoom(from);
        this.publish();
        this.send(from, { type: "result", id: body.id, result });
      } else if (
        body.type === "action" &&
        typeof body.id === "string" &&
        body.id.length <= 128 &&
        isJson(body.action)
      ) {
        const result = this.apply(from, body.id, body.action);
        this.send(from, { type: "result", id: body.id, result });
      }
    } else if (from === this.match.id) {
      if (body.type === "paused") {
        this.authorityPaused = true;
        this.paused = true;
        this.status();
      }
      if (
        body.type === "snapshot" &&
        record(body.snapshot) &&
        body.snapshot.matchId === this.match.matchId &&
        typeof body.snapshot.version === "number" &&
        isJson(body.snapshot.state)
      )
        this.options.onSnapshot(body.snapshot as unknown as RoomSnapshot);
      if (
        body.type === "result" &&
        typeof body.id === "string" &&
        isJson(body.result)
      ) {
        this.pending.get(body.id)?.resolve(body.result);
        this.pending.delete(body.id);
      }
    }
  }
  private apply(from: string, id: string, action: JsonValue): JsonValue {
    const result = this.engine!.act(from, id, action);
    this.publish();
    return result;
  }
  private publish(): void {
    // Per-viewer projection is mandatory even though the transport is encrypted.
    for (const member of this.members) {
      const snapshot = this.engine!.snapshot(member);
      if (member === this.options.selfId) this.options.onSnapshot(snapshot);
      else
        this.send(member, {
          type: "snapshot",
          snapshot: snapshot as unknown as JsonValue,
        });
    }
  }
  private lastTick = 0;
  private tick(): void {
    if (this.closed) return;
    try {
      if (!this.paused && this.engine?.advance(Date.now())) this.publish();
    } catch (error) {
      this.fail(error);
    }
    this.status();
    if (
      this.measuredAt !== undefined &&
      performance.now() - this.measuredAt >= 6_000
    ) {
      this.measuredAt = undefined;
      this.options.onLatency?.(undefined);
    }
    if (Date.now() - this.lastTick < 2_000) return;
    this.lastTick = Date.now();
    if (!this.paused) {
      for (const [id, peer] of this.peers)
        if (peer.channel?.readyState === "open") this.probe(id, "webrtc");
      if (!this.host && this.transport === "relay")
        this.probe(this.match.id, "relay");
    }
    if (!this.host && !this.paused) this.send(this.match.id, { type: "hello" });
    for (const [id, pending] of this.pending) {
      if (Date.now() - pending.started > 15_000) {
        pending.reject(
          new Error(
            "Local host did not respond; the action outcome is unknown.",
          ),
        );
        this.pending.delete(id);
      } else this.send(this.match.id, pending.body);
    }
    this.status();
  }
  private peer(id: string): Peer | undefined {
    if (this.options.presence.connectionMode !== "local-host") return;
    let peer = this.peers.get(id);
    if (peer) return peer;
    try {
      const pc =
        this.options.createPeer?.() ??
        new RTCPeerConnection({
          iceServers: [{ urls: "stun:stun.cloudflare.com:3478" }],
        });
      peer = { pc, candidates: [], lastDirect: 0 };
      this.peers.set(id, peer);
      pc.onicecandidate = (event) => {
        if (event.candidate && !this.closed)
          try {
            this.options.sendRelay(id, "signal", {
              candidate: event.candidate.toJSON() as unknown as JsonValue,
            });
          } catch {}
      };
      pc.ondatachannel = (event) => this.channel(id, peer!, event.channel);
      pc.onconnectionstatechange = () => {
        if (!this.closed) this.status();
      };
      return peer;
    } catch {
      return;
    } // Browsers without WebRTC use platform relay immediately.
  }
  private channel(id: string, peer: Peer, channel: RTCDataChannel): void {
    peer.channel = channel;
    channel.onopen = () => {
      if (this.closed) return;
      peer.lastDirect = Date.now();
      this.send(id, { type: "hello" });
      this.status();
    };
    channel.onclose = () => this.status();
    channel.onerror = () => {
      peer.lastDirect = 0;
      this.status();
    };
    channel.onmessage = (event) => {
      if (
        this.closed ||
        this.peers.get(id) !== peer ||
        !this.members.has(id) ||
        typeof event.data !== "string" ||
        event.data.length > 64 * 1024
      )
        return;
      let body: unknown;
      try {
        body = JSON.parse(event.data);
      } catch {
        return;
      }
      if (!isJson(body)) return;
      peer.lastDirect = Date.now();
      try {
        this.status();
        this.data(id, body, "webrtc");
      } catch (error) {
        this.fail(error);
      }
    };
  }
  private async offer(id: string): Promise<void> {
    const peer = this.peer(id);
    if (!peer) return;
    try {
      this.channel(
        id,
        peer,
        peer.pc.createDataChannel("playweft-room", { ordered: true }),
      );
      await peer.pc.setLocalDescription(await peer.pc.createOffer());
      if (!this.closed && this.peers.get(id) === peer)
        this.options.sendRelay(id, "signal", {
          description:
            peer.pc.localDescription!.toJSON() as unknown as JsonValue,
        });
    } catch {
      peer.lastDirect = 0;
      this.status();
    }
  }
  private async signal(id: string, body: JsonValue): Promise<void> {
    if (!record(body)) return;
    const peer = this.peer(id);
    if (!peer) return;
    try {
      if (record(body.description)) {
        const description =
          body.description as unknown as RTCSessionDescriptionInit;
        if (
          (this.host && description.type !== "answer") ||
          (!this.host && description.type !== "offer")
        )
          return;
        await peer.pc.setRemoteDescription(description);
        for (const candidate of peer.candidates.splice(0))
          await peer.pc.addIceCandidate(candidate);
        if (!this.host) {
          await peer.pc.setLocalDescription(await peer.pc.createAnswer());
          if (!this.closed && this.peers.get(id) === peer)
            this.options.sendRelay(id, "signal", {
              description:
                peer.pc.localDescription!.toJSON() as unknown as JsonValue,
            });
        }
      } else if (record(body.candidate)) {
        const candidate = body.candidate as unknown as RTCIceCandidateInit;
        if (peer.pc.remoteDescription) await peer.pc.addIceCandidate(candidate);
        else if (peer.candidates.length < 64) peer.candidates.push(candidate);
      }
    } catch {
      peer.lastDirect = 0;
      this.status();
    }
  }
}
