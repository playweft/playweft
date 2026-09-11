const PLAYER_PROFILES_KEY = "playweft:player-profiles:v1";
const MAX_STORED_ACCOUNTS = 32;

export const MAX_PLAYER_NICKNAME_LENGTH = 24;

interface StoredPlayerProfiles {
  guest?: string;
  accounts: Record<string, string>;
}

export function readGuestPlayerNickname(): string {
  const profiles = readPlayerProfiles();
  if (profiles.guest) return profiles.guest;
  const nickname = generateRandomPlayerNickname();
  writePlayerProfiles({ ...profiles, guest: nickname });
  return nickname;
}

export function readAccountPlayerNickname(
  accountKey: string,
  defaultValue = "",
): string {
  const profiles = readPlayerProfiles();
  const stored = profiles.accounts[accountKey];
  if (stored) return stored;
  const nickname = normalizedOrRandomNickname(defaultValue);
  writePlayerProfiles({
    ...profiles,
    accounts: boundedAccounts(profiles.accounts, accountKey, nickname),
  });
  return nickname;
}

export function persistGuestPlayerNickname(value: string): string {
  const nickname = normalizedOrRandomNickname(value);
  const profiles = readPlayerProfiles();
  writePlayerProfiles({ ...profiles, guest: nickname });
  return nickname;
}

export function persistAccountPlayerNickname(
  accountKey: string,
  value: string,
): string {
  const nickname = normalizedOrRandomNickname(value);
  const profiles = readPlayerProfiles();
  writePlayerProfiles({
    ...profiles,
    accounts: boundedAccounts(profiles.accounts, accountKey, nickname),
  });
  return nickname;
}

export function generateRandomPlayerNickname(): string {
  const alphabet = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
  const random = crypto.getRandomValues(new Uint8Array(4));
  let suffix = "";
  for (const value of random) suffix += alphabet[value & 31];
  const prefix =
    typeof navigator !== "undefined" &&
    navigator.language.toLowerCase().startsWith("zh")
      ? "玩家"
      : "Player";
  return `${prefix}-${suffix}`;
}

export function normalizePlayerNickname(value: string): string {
  let nickname = "";
  for (const character of value.trim()) {
    if (nickname.length + character.length > MAX_PLAYER_NICKNAME_LENGTH) break;
    nickname += character;
  }
  return nickname;
}

function normalizedOrRandomNickname(value: string): string {
  return normalizePlayerNickname(value) || generateRandomPlayerNickname();
}

function readPlayerProfiles(): StoredPlayerProfiles {
  try {
    const value = JSON.parse(
      localStorage.getItem(PLAYER_PROFILES_KEY) ?? "{}",
    ) as unknown;
    if (!isRecord(value)) return { accounts: {} };
    const guest = normalizeStoredNickname(value.guest);
    const accounts = isRecord(value.accounts)
      ? normalizedAccounts(value.accounts)
      : {};
    return {
      ...(guest ? { guest } : {}),
      accounts,
    };
  } catch {
    return { accounts: {} };
  }
}

function writePlayerProfiles(profiles: StoredPlayerProfiles): void {
  try {
    localStorage.setItem(PLAYER_PROFILES_KEY, JSON.stringify(profiles));
  } catch {
    // Keep the in-memory profile usable when storage is unavailable.
  }
}

function normalizedAccounts(
  value: Record<string, unknown>,
): Record<string, string> {
  const accounts: Record<string, string> = {};
  for (const [accountKey, nicknameValue] of Object.entries(value)) {
    const nickname = normalizeStoredNickname(nicknameValue);
    if (accountKey.length > 0 && accountKey.length <= 128 && nickname) {
      accounts[accountKey] = nickname;
    }
  }
  return Object.fromEntries(
    Object.entries(accounts).slice(-MAX_STORED_ACCOUNTS),
  );
}

function boundedAccounts(
  current: Record<string, string>,
  accountKey: string,
  nickname: string,
): Record<string, string> {
  const next = { ...current };
  delete next[accountKey];
  next[accountKey] = nickname;
  return Object.fromEntries(
    Object.entries(next).slice(-MAX_STORED_ACCOUNTS),
  );
}

function normalizeStoredNickname(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const nickname = normalizePlayerNickname(value);
  return nickname === value && nickname ? nickname : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
