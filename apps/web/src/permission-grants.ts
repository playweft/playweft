const PERMISSION_GRANTS_KEY = "playweft:permission-grants:v1";
const MAX_GRANTED_GAMES = 128;
const KNOWN_PERMISSIONS = new Set<PlatformPermission>([
  "clipboardRead",
  "profileAvatar",
  "languageModelV1",
]);

// Permission names intentionally include the policy version when a grant can
// result in remote work or user charges. Adding a broader language-model
// policy must therefore require fresh approval instead of silently expanding
// an earlier decision.
export type PlatformPermission =
  | "clipboardRead"
  | "profileAvatar"
  | "languageModelV1";
type PermissionGrants = Record<string, PlatformPermission[]>;

export function hasPermissionGrant(
  manifestId: string,
  permission: PlatformPermission,
): boolean {
  return readPermissionGrants()[manifestId]?.includes(permission) ?? false;
}

export function rememberPermissionGrant(
  manifestId: string,
  permission: PlatformPermission,
): void {
  const grants = readPermissionGrants();
  const permissions = new Set(grants[manifestId] ?? []);
  permissions.add(permission);

  // Reinsert the game so the most recently used grants survive the size cap.
  delete grants[manifestId];
  grants[manifestId] = [...permissions];
  const bounded = Object.fromEntries(
    Object.entries(grants).slice(-MAX_GRANTED_GAMES),
  );
  try {
    localStorage.setItem(PERMISSION_GRANTS_KEY, JSON.stringify(bounded));
  } catch {
    // Storage may be unavailable. The current authorization still succeeds.
  }
}

function readPermissionGrants(): PermissionGrants {
  try {
    const value = JSON.parse(
      localStorage.getItem(PERMISSION_GRANTS_KEY) ?? "{}",
    ) as unknown;
    if (!isRecord(value)) return {};
    return Object.fromEntries(
      Object.entries(value)
        .filter(([manifestId, permissions]) =>
          manifestId.length > 0 && Array.isArray(permissions),
        )
        .map(([manifestId, permissions]) => [
          manifestId,
          [...new Set(
            (permissions as unknown[]).filter(
              (item): item is PlatformPermission =>
                typeof item === "string" &&
                KNOWN_PERMISSIONS.has(item as PlatformPermission),
            ),
          )],
        ])
        .filter(([, permissions]) => permissions.length > 0)
        .slice(-MAX_GRANTED_GAMES),
    );
  } catch {
    return {};
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
