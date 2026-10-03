import { useI18n } from "@/app/i18n";
import PlayerProfileMenu from "@/features/account/PlayerProfileMenu";

export default function RoomHeader({
  gameName,
  nickname,
  onNicknameChange,
  requestBack,
}: {
  gameName: string;
  nickname: string;
  onNicknameChange(value: string): void;
  requestBack(): void;
}) {
  const { t } = useI18n();
  return (
    <header className="topbar room-topbar">
      <button
        className="brand room-brand"
        onClick={requestBack}
        aria-label={t("backToPlayweftHome")}
      >
        <img className="brand-mark" src="/favicon.svg" alt="" />
        <span className="room-brand-name">playweft</span>
      </button>
      <span className="room-mobile-game-name" title={gameName}>
        {gameName}
      </span>
      <PlayerProfileMenu
        nickname={nickname}
        onNicknameChange={onNicknameChange}
      />
    </header>
  );
}
