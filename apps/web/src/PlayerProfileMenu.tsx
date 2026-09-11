import { CircleUserRound, LogIn, LogOut, Pencil, Settings } from "lucide-react";
import { useEffect, useState } from "react";
import AnchoredMenu from "./AnchoredMenu";
import Dialog from "./Dialog";
import SettingsDialog from "./SettingsDialog";
import { useI18n } from "./i18n";
import {
  getPlatformSession,
  logoutPlatformSession,
  type PlatformSessionStatus,
  xLoginUrl,
} from "./platform-api";
import {
  MAX_PLAYER_NICKNAME_LENGTH,
  normalizePlayerNickname,
} from "./player-profile";

export default function PlayerProfileMenu({
  nickname,
  onNicknameChange,
}: {
  nickname: string;
  onNicknameChange(value: string): void;
}) {
  const { t } = useI18n();
  const [nicknameDialogOpen, setNicknameDialogOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(openSettingsFromLocation);
  const [draftNickname, setDraftNickname] = useState(nickname);
  const [session, setSession] = useState<PlatformSessionStatus>();
  const [avatarFailed, setAvatarFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void getPlatformSession()
      .then((nextSession) => {
        if (cancelled) return;
        setSession(nextSession);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => setAvatarFailed(false), [session?.avatarUrl]);

  useEffect(() => {
    const url = new URL(window.location.href);
    if (url.searchParams.get("settings") !== "1") return;
    url.searchParams.delete("settings");
    window.history.replaceState(
      window.history.state,
      "",
      `${url.pathname}${url.search}${url.hash}`,
    );
  }, []);

  const editNickname = () => {
    setDraftNickname(nickname || session?.name || "");
    setNicknameDialogOpen(true);
  };

  const signInWithX = () => window.location.assign(xLoginUrl());
  const signOut = async () => {
    try {
      await logoutPlatformSession();
    } finally {
      window.location.assign("/");
    }
  };

  const signedInWithX = session?.provider === "x";
  const avatarUrl =
    signedInWithX && !avatarFailed ? session.avatarUrl : undefined;

  const accountAvatar = avatarUrl ? (
    <img
      src={avatarUrl}
      alt=""
      height={36}
      referrerPolicy="no-referrer"
      onError={() => setAvatarFailed(true)}
      width={36}
    />
  ) : (
    <CircleUserRound aria-hidden="true" />
  );

  return (
    <div className="player-profile">
      <AnchoredMenu
        ariaLabel={t("accountMenu")}
        backdropClassName="profile-menu-backdrop"
        className="profile-menu"
        disabled={nicknameDialogOpen || settingsOpen}
        openOnHover
        trigger={({
          anchorRef,
          expanded,
          onClick,
          onMouseEnter,
          onMouseLeave,
        }) => (
          <button
            ref={anchorRef}
            className="player-profile-button"
            type="button"
            aria-label={t("accountMenu")}
            aria-haspopup="menu"
            aria-expanded={expanded}
            title={nickname || t("accountMenu")}
            onClick={onClick}
            onMouseEnter={onMouseEnter}
            onMouseLeave={onMouseLeave}
          >
            {accountAvatar}
          </button>
        )}
      >
        {(closeMenu) => (
          <>
            <div className="profile-menu-account">
              <span className="profile-menu-avatar" aria-hidden="true">
                {accountAvatar}
              </span>
              <div
                className={`profile-menu-nickname${nickname || session?.name ? "" : " profile-menu-nickname-empty"}`}
                title={nickname || session?.name || t("nicknameNotSet")}
              >
                <span>{nickname || session?.name || t("nicknameNotSet")}</span>
                {signedInWithX && session.username && (
                  <small>@{session.username} · X</small>
                )}
              </div>
            </div>
            <div className="profile-menu-divider" role="separator" />
            <button
              type="button"
              role="menuitem"
              onClick={() => closeMenu(() => setSettingsOpen(true))}
            >
              <Settings aria-hidden="true" />
              <span>{t("settings")}</span>
            </button>
            <div className="profile-menu-divider" role="separator" />
            {signedInWithX ? (
              <button
                type="button"
                role="menuitem"
                onClick={() => closeMenu(() => void signOut())}
              >
                <LogOut aria-hidden="true" />
                <span>{t("signOut")}</span>
              </button>
            ) : (
              <button
                type="button"
                role="menuitem"
                onClick={() => closeMenu(signInWithX)}
              >
                <LogIn aria-hidden="true" />
                <span>{t("signInWithX")}</span>
              </button>
            )}
            <button
              type="button"
              role="menuitem"
              onClick={() => closeMenu(editNickname)}
            >
              <Pencil aria-hidden="true" />
              <span>{t("editNickname")}</span>
            </button>
          </>
        )}
      </AnchoredMenu>
      {nicknameDialogOpen && (
        <Dialog
          title={t("editNickname")}
          onDismiss={() => setNicknameDialogOpen(false)}
          actions={[
            { label: t("cancel") },
            {
              label: t("save"),
              variant: "primary",
              onSelect: () =>
                onNicknameChange(normalizePlayerNickname(draftNickname)),
            },
          ]}
        >
          <label className="nickname-field">
            <span>{t("nickname")}</span>
            <input
              autoFocus
              type="text"
              maxLength={MAX_PLAYER_NICKNAME_LENGTH}
              placeholder={t("nicknamePlaceholder")}
              value={draftNickname}
              onChange={(event) => setDraftNickname(event.target.value)}
            />
            <small>{t("nicknameStoredLocally")}</small>
          </label>
        </Dialog>
      )}
      {settingsOpen && <SettingsDialog onBack={() => setSettingsOpen(false)} />}
    </div>
  );
}

function openSettingsFromLocation(): boolean {
  return new URL(window.location.href).searchParams.get("settings") === "1";
}
