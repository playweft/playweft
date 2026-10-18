export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

export const JSON_MAX_DEPTH = 32;

export class JsonValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JsonValidationError";
  }
}

export function assertJson(
  value: unknown,
  label: string,
): asserts value is JsonValue {
  if (!isJson(value))
    throw new JsonValidationError(`${label} must be JSON-compatible`);
}

export function assertJsonSize(
  value: JsonValue,
  label: string,
  maxBytes: number,
): void {
  const bytes = new TextEncoder().encode(JSON.stringify(value)).byteLength;
  if (bytes > maxBytes)
    throw new JsonValidationError(
      `${label} exceeds the ${maxBytes}-byte limit`,
    );
}

export function isJson(value: unknown, depth = 0): value is JsonValue {
  if (depth > JSON_MAX_DEPTH) return false;
  if (value === null || typeof value === "boolean" || typeof value === "string")
    return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value))
    return value.every((item) => isJson(item, depth + 1));
  if (typeof value !== "object") return false;
  return Object.entries(value as Record<string, unknown>).every(
    ([key, item]) => key.length <= 256 && isJson(item, depth + 1),
  );
}

export const JSON_RPC_VERSION = "2.0" as const;
export const PLAYWEFT_BRIDGE_VERSION = 1 as const;
export const GAME_MANIFEST_VERSION = 1 as const;

export type GameManifestTextDirection = "auto" | "ltr" | "rtl";

export interface GameManifestLocalizedTextObject {
  value: string;
  dir?: GameManifestTextDirection;
  lang?: string;
}

export type GameManifestLocalizedText =
  | string
  | GameManifestLocalizedTextObject;

export interface GameManifestIcon {
  src: string;
  sizes?: string;
  type?: string;
  purpose?: string;
}

export type GameManifestOrientation =
  | "any"
  | "natural"
  | "portrait"
  | "portrait-primary"
  | "portrait-secondary"
  | "landscape"
  | "landscape-primary"
  | "landscape-secondary";

export type GameMode = "solo" | "room";
export type GameLaunchMode = "auto" | "solo";

export interface GameManifestRoomMode {
  players: {
    min: number;
    max: number;
  };
  server: {
    runtime: "lua";
    entry: string;
    persistence: "durable" | "live";
  };
}

export type UserProfileField = "name" | "avatar";

export interface GameManifest {
  $schema?: string;
  manifest_version: typeof GAME_MANIFEST_VERSION;
  id: string;
  version: string;
  protocol: {
    min: number;
    max: number;
  };
  start_url: string;
  name: string;
  name_localized?: Record<string, GameManifestLocalizedText>;
  description?: string;
  description_localized?: Record<string, GameManifestLocalizedText>;
  categories?: string[];
  icons?: GameManifestIcon[];
  background_color?: string;
  theme_color?: string;
  orientation?: GameManifestOrientation;
  help_url?: string;
  /** Omitted or auto preserves single-mode entry / dual-mode choice. */
  launch_mode?: GameLaunchMode;
  modes: {
    solo?: Record<string, never>;
    room?: GameManifestRoomMode;
  };
}

export class GameManifestValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GameManifestValidationError";
  }
}

export function parseGameManifest(value: unknown): GameManifest {
  if (!isRecord(value)) failManifest("manifest must be an object");
  const manifest = value as Record<string, unknown>;
  if (manifest.manifest_version !== GAME_MANIFEST_VERSION) {
    failManifest(`manifest_version must be ${GAME_MANIFEST_VERSION}`);
  }
  if (!isRelativeOrWebUrl(manifest.id, 2_048)) {
    failManifest("id must be a relative or HTTPS URL");
  }
  if (!isRelativeOrWebUrl(manifest.start_url, 2_048)) {
    failManifest("start_url must be a relative or HTTPS URL");
  }
  if (
    typeof manifest.version !== "string" ||
    !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(
      manifest.version,
    ) ||
    manifest.version.length > 64
  ) {
    failManifest("version must be a semantic version");
  }
  if (!isRecord(manifest.protocol)) failManifest("protocol must be an object");
  const protocol = manifest.protocol as Record<string, unknown>;
  assertManifestKeys(protocol, ["min", "max"], "protocol");
  if (
    !isProtocolVersion(protocol.min) ||
    !isProtocolVersion(protocol.max) ||
    protocol.min > protocol.max
  ) {
    failManifest("protocol min/max must be ordered positive integers");
  }

  const metadata = parseManifestMetadata(manifest);
  const modes = parseManifestModes(manifest.modes);
  if (manifest.launch_mode !== undefined && manifest.launch_mode !== "auto" && manifest.launch_mode !== "solo")
    failManifest("launch_mode must be auto or solo");
  if (manifest.launch_mode === "solo" && !modes.solo)
    failManifest("launch_mode solo requires modes.solo");
  if (manifest.$schema !== undefined && typeof manifest.$schema !== "string") {
    failManifest("$schema must be a string");
  }
  return {
    ...(typeof manifest.$schema === "string"
      ? { $schema: manifest.$schema }
      : {}),
    manifest_version: GAME_MANIFEST_VERSION,
    id: manifest.id as string,
    version: manifest.version as string,
    protocol: {
      min: protocol.min as number,
      max: protocol.max as number,
    },
    start_url: manifest.start_url as string,
    ...metadata,
    ...(manifest.launch_mode !== undefined ? { launch_mode: manifest.launch_mode as GameLaunchMode } : {}),
    modes,
  };
}

function parseManifestMetadata(
  manifest: Record<string, unknown>,
): Pick<
  GameManifest,
  | "name"
  | "name_localized"
  | "description"
  | "description_localized"
  | "categories"
  | "icons"
  | "background_color"
  | "theme_color"
  | "orientation"
  | "help_url"
> {
  if (!isTrimmedText(manifest.name, 1, 100)) {
    failManifest("name must contain 1-100 characters");
  }
  if (
    manifest.description !== undefined &&
    !isTrimmedText(manifest.description, 1, 500)
  ) {
    failManifest("description must contain 1-500 characters");
  }
  const nameLocalized = parseLocalizedText(
    manifest.name_localized,
    "name_localized",
    100,
  );
  const descriptionLocalized = parseLocalizedText(
    manifest.description_localized,
    "description_localized",
    500,
  );
  const categories = parseManifestCategories(manifest.categories);
  const icons = parseManifestIcons(manifest.icons);
  if (
    manifest.background_color !== undefined &&
    !isTrimmedText(manifest.background_color, 1, 128)
  ) {
    failManifest("background_color must be a CSS color string");
  }
  if (
    manifest.theme_color !== undefined &&
    !isTrimmedText(manifest.theme_color, 1, 128)
  ) {
    failManifest("theme_color must be a CSS color string");
  }
  if (
    manifest.orientation !== undefined &&
    !isManifestOrientation(manifest.orientation)
  ) {
    failManifest("orientation is not a supported Web App Manifest value");
  }
  if (
    manifest.help_url !== undefined &&
    !isRelativeOrWebUrl(manifest.help_url, 2_048)
  ) {
    failManifest("help_url must be a relative or HTTPS URL");
  }
  return {
    name: manifest.name as string,
    ...(nameLocalized ? { name_localized: nameLocalized } : {}),
    ...(typeof manifest.description === "string"
      ? { description: manifest.description }
      : {}),
    ...(descriptionLocalized
      ? { description_localized: descriptionLocalized }
      : {}),
    ...(categories ? { categories } : {}),
    ...(icons ? { icons } : {}),
    ...(typeof manifest.background_color === "string"
      ? { background_color: manifest.background_color }
      : {}),
    ...(typeof manifest.theme_color === "string"
      ? { theme_color: manifest.theme_color }
      : {}),
    ...(isManifestOrientation(manifest.orientation)
      ? { orientation: manifest.orientation }
      : {}),
    ...(typeof manifest.help_url === "string"
      ? { help_url: manifest.help_url }
      : {}),
  };
}

function parseLocalizedText(
  value: unknown,
  label: string,
  maxLength: number,
): Record<string, GameManifestLocalizedText> | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) failManifest(`${label} must be an object`);
  const entries = Object.entries(value);
  if (entries.length === 0 || entries.length > 32) {
    failManifest(`${label} must contain 1-32 locales`);
  }
  const localized: Record<string, GameManifestLocalizedText> = {};
  for (const [locale, text] of entries) {
    if (!isLocaleTag(locale)) failManifest(`${label} has an invalid locale`);
    if (isTrimmedText(text, 1, maxLength)) {
      localized[locale] = text;
      continue;
    }
    if (!isRecord(text)) {
      failManifest(`${label}.${locale} must be localized text`);
    }
    assertManifestKeys(text, ["value", "dir", "lang"], `${label}.${locale}`);
    if (!isTrimmedText(text.value, 1, maxLength)) {
      failManifest(`${label}.${locale}.value is invalid`);
    }
    if (
      text.dir !== undefined &&
      text.dir !== "auto" &&
      text.dir !== "ltr" &&
      text.dir !== "rtl"
    ) {
      failManifest(`${label}.${locale}.dir is invalid`);
    }
    if (
      text.lang !== undefined &&
      (typeof text.lang !== "string" || !isLocaleTag(text.lang))
    ) {
      failManifest(`${label}.${locale}.lang is invalid`);
    }
    localized[locale] = {
      value: text.value as string,
      ...(typeof text.dir === "string"
        ? { dir: text.dir as GameManifestTextDirection }
        : {}),
      ...(typeof text.lang === "string" ? { lang: text.lang } : {}),
    };
  }
  return localized;
}

function parseManifestCategories(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.length > 32 ||
    !value.every((category) => isTrimmedText(category, 1, 100))
  ) {
    failManifest("categories must contain 1-32 non-empty strings");
  }
  return [...value] as string[];
}

function parseManifestIcons(value: unknown): GameManifestIcon[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length === 0 || value.length > 16) {
    failManifest("icons must contain 1-16 image resources");
  }
  return value.map((entry, index) => {
    const label = `icons.${index}`;
    if (!isRecord(entry)) failManifest(`${label} must be an object`);
    assertManifestKeys(entry, ["src", "sizes", "type", "purpose"], label);
    if (!isRelativeOrWebUrl(entry.src, 2_048)) {
      failManifest(`${label}.src must be a relative or HTTPS URL`);
    }
    if (entry.sizes !== undefined && !isIconSizes(entry.sizes)) {
      failManifest(`${label}.sizes is invalid`);
    }
    if (entry.type !== undefined && !isImageMimeType(entry.type)) {
      failManifest(`${label}.type must be an image MIME type`);
    }
    if (entry.purpose !== undefined && !isIconPurpose(entry.purpose)) {
      failManifest(`${label}.purpose is invalid`);
    }
    return {
      src: entry.src as string,
      ...(typeof entry.sizes === "string" ? { sizes: entry.sizes } : {}),
      ...(typeof entry.type === "string" ? { type: entry.type } : {}),
      ...(typeof entry.purpose === "string" ? { purpose: entry.purpose } : {}),
    };
  });
}

function parseManifestModes(value: unknown): GameManifest["modes"] {
  if (!isRecord(value)) failManifest("modes must be an object");
  const modes = value as Record<string, unknown>;
  assertManifestKeys(modes, ["solo", "room"], "modes");
  const hasSolo = modes.solo !== undefined;
  const hasRoom = modes.room !== undefined;
  if (!hasSolo && !hasRoom) failManifest("modes must declare solo or room");
  if (
    hasSolo &&
    (!isRecord(modes.solo) || Object.keys(modes.solo).length > 0)
  ) {
    failManifest("modes.solo must be an empty object");
  }
  let room: GameManifestRoomMode | undefined;
  if (hasRoom) {
    if (!isRecord(modes.room)) failManifest("modes.room must be an object");
    const input = modes.room as Record<string, unknown>;
    assertManifestKeys(input, ["players", "server"], "modes.room");
    if (!isRecord(input.players)) {
      failManifest("modes.room.players must be an object");
    }
    const players = input.players as Record<string, unknown>;
    assertManifestKeys(players, ["min", "max"], "modes.room.players");
    if (
      !isPlayerLimit(players.min) ||
      !isPlayerLimit(players.max) ||
      players.min > players.max
    ) {
      failManifest("room player limits must be ordered integers from 1 to 32");
    }
    if (!isRecord(input.server)) {
      failManifest("modes.room.server must be an object");
    }
    const server = input.server as Record<string, unknown>;
    assertManifestKeys(
      server,
      ["runtime", "entry", "persistence"],
      "modes.room.server",
    );
    if (
      server.runtime !== "lua" ||
      !isRelativeOrWebUrl(server.entry, 2_048) ||
      (server.persistence !== "durable" && server.persistence !== "live")
    ) {
      failManifest(
        "modes.room.server requires a Lua entry and durable or live persistence",
      );
    }
    room = {
      players: {
        min: players.min as number,
        max: players.max as number,
      },
      server: {
        runtime: "lua",
        entry: server.entry as string,
        persistence: server.persistence as "durable" | "live",
      },
    };
  }
  return {
    ...(hasSolo ? { solo: {} } : {}),
    ...(room ? { room } : {}),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function assertManifestKeys(
  value: Record<string, unknown>,
  allowed: string[],
  label: string,
): void {
  const unexpected = Object.keys(value).find((key) => !allowed.includes(key));
  if (unexpected)
    failManifest(`${label} contains unknown field: ${unexpected}`);
}

function isProtocolVersion(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 1 &&
    value <= 255
  );
}

function isPlayerLimit(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 1 &&
    value <= 32
  );
}

function isLocaleTag(value: string): boolean {
  return (
    value.length <= 35 && /^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/.test(value)
  );
}

function isManifestOrientation(
  value: unknown,
): value is GameManifestOrientation {
  return (
    value === "any" ||
    value === "natural" ||
    value === "portrait" ||
    value === "portrait-primary" ||
    value === "portrait-secondary" ||
    value === "landscape" ||
    value === "landscape-primary" ||
    value === "landscape-secondary"
  );
}

function isIconSizes(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= 256 &&
    /^(?:any|[1-9]\d*x[1-9]\d*)(?: (?:any|[1-9]\d*x[1-9]\d*))*$/.test(value)
  );
}

function isImageMimeType(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= 128 &&
    /^image\/[A-Za-z0-9][A-Za-z0-9.+-]*$/.test(value)
  );
}

function isIconPurpose(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 64) return false;
  const purposes = value.split(" ");
  return (
    purposes.length > 0 &&
    new Set(purposes).size === purposes.length &&
    purposes.every(
      (purpose) =>
        purpose === "any" || purpose === "maskable" || purpose === "monochrome",
    )
  );
}

function isTrimmedText(
  value: unknown,
  minLength: number,
  maxLength: number,
): value is string {
  return (
    typeof value === "string" &&
    value.length >= minLength &&
    value.length <= maxLength &&
    value.trim() === value
  );
}

function isRelativeOrWebUrl(
  value: unknown,
  maxLength: number,
): value is string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maxLength ||
    value.trim() !== value
  ) {
    return false;
  }
  try {
    const url = new URL(value, "https://manifest.invalid/");
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}

function failManifest(message: string): never {
  throw new GameManifestValidationError(message);
}

export interface JsonRpcRequest {
  jsonrpc: typeof JSON_RPC_VERSION;
  id: string;
  method: string;
  params?: JsonValue;
}

export interface JsonRpcNotification {
  jsonrpc: typeof JSON_RPC_VERSION;
  method: string;
  params?: JsonValue;
}

export interface JsonRpcSuccess {
  jsonrpc: typeof JSON_RPC_VERSION;
  id: string | null;
  result: JsonValue;
}

export interface JsonRpcErrorObject {
  code: number;
  message: string;
  data?: JsonValue;
}

export interface JsonRpcFailure {
  jsonrpc: typeof JSON_RPC_VERSION;
  id: string | null;
  error: JsonRpcErrorObject;
}

export type JsonRpcMessage =
  | JsonRpcRequest
  | JsonRpcNotification
  | JsonRpcSuccess
  | JsonRpcFailure;

export const JsonRpcErrorCode = {
  InvalidRequest: -32600,
  MethodNotFound: -32601,
  InvalidParams: -32602,
  InternalError: -32603,
  PlatformError: -32000,
} as const;

/** RTT to the current game authority. Unknown readings omit rttMs, never use zero. */
export interface PlatformLatency {
  rttMs?: number;
  transport: "platform" | "local" | "webrtc" | "relay";
  status: "ready" | "measuring" | "unavailable";
}

export interface RoomSnapshot {
  type: "snapshot" | "state";
  state: JsonValue;
  matchId: string;
  version: number;
  serverTime: number;
  scriptHash: string;
  events?: JsonValue[];
}

/**
 * Platform-owned room membership and lifecycle state. This is independent of
 * the game's authoritative snapshot and is safe to broadcast while playing.
 */
export interface RoomPresence {
  /** Room membership/lifecycle message used on HTTP and WebSocket surfaces. */
  type: "room.presence";
  /** Monotonically increases whenever room membership or lifecycle changes. */
  revision: number;
  phase: "lobby" | "playing";
  players: RoomPlayer[];
  spectators: RoomSpectator[];
  /** Room manager's member ID; may belong to players or spectators. */
  ownerId: string;
  minPlayers: number;
  maxPlayers: number;
  /** Experimental transport selection, changed only in the lobby. */
  connectionMode?: "platform" | "local-host" | "local-relay";
  localHost?: {
    id: string;
    instanceId: string;
    matchId: string;
    players: RoomPlayer[];
    startedAt: number;
  };
}

/** Bootstrap endpoint available only to the pinned browser host. */
export interface RoomLocalRuntime {
  matchId: string;
  startedAt: number;
  script: string;
  scriptHash: string;
  context: JsonValue;
  liveRoom: boolean;
}

/** Cloud starts include a snapshot; local starts bootstrap in the host browser. */
export interface RoomStart {
  presence: RoomPresence;
  snapshot?: RoomSnapshot;
}

/** Result of explicitly leaving a room. */
export interface RoomLeave {
  left: true;
  /** True when this departure removed the final room member. */
  roomClosed: boolean;
}

export interface ActionError {
  code: string;
  message: string;
}

export type RoomActionResult =
  | {
      type: "action-result";
      requestId: string;
      accepted: true;
      matchId: string;
      version: number;
    }
  | {
      type: "action-result";
      requestId: string;
      accepted: false;
      matchId: string;
      version: number;
      error: ActionError;
    };

export interface RoomActionResponse {
  result: RoomActionResult;
  /** Present when this request produced a new authoritative state version. */
  update?: RoomSnapshot;
}

export interface RoomPlayer {
  id: string;
  /** Optional platform display name. Omit it when the player is anonymous. */
  name?: string;
  /** Room-scoped proxy URL. It stops resolving when this membership ends. */
  avatarUrl?: string;
  /** One-based position in the room. Positions remain empty when a player spectates. */
  seat: number;
  ready: boolean;
}

export interface RoomSpectator {
  id: string;
  /** Optional platform display name. Omit it when the spectator is anonymous. */
  name?: string;
  /** Room-scoped proxy URL. It stops resolving when this membership ends. */
  avatarUrl?: string;
}

export interface RoomJoin extends RoomPresence {
  selfId: string;
}

export interface RoomError {
  type: "error";
  error: string;
}
