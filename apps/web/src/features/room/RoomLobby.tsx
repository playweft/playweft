import { useState } from "react";
import { Eye, MoreHorizontal, Share2, UserRound } from "lucide-react";
import { useI18n } from "@/app/i18n";
import Menu from "@/components/Menu";
import RoomIdCopy from "./RoomIdCopy";
import RoomSeats from "./RoomSeats";
import type { RoomControls } from "./useRoomControls";

export default function RoomLobby({
  roomId,
  controls,
}: {
  roomId: string;
  controls: RoomControls;
}) {
  const { locale, t } = useI18n();
  const {
    gameName,
    gameIconHref,
    requestBack,
    setError,
    spectatorCount,
    inviteDialogOpen,
    setInviteDialogOpen,
    lobby,
    selfId,
    isOwner,
    selfPlayer,
    isSpectating,
    firstOpenSeat,
    starting,
    start,
    startUnavailableReason,
    startUnavailableHint,
    startUnavailableHintClosing,
    showStartUnavailableHint,
    setStartUnavailableHint,
    setStartUnavailableHintClosing,
    setReady,
    joinFirstOpenSeat,
    copied,
    shareInvite,
    phase,
    gameHelpHref,
    setGameInfoOpen,
    setGameHelpOpen,
    setChangeGameOpen,
    setDissolveDialogOpen,
    chooseSeat,
  } = controls;
  const [spectatorMenuOpen, setSpectatorMenuOpen] = useState(false);
  const [spectatorMenuAnchor, setSpectatorMenuAnchor] =
    useState<HTMLButtonElement>();
  const [lobbyMenuOpen, setLobbyMenuOpen] = useState(false);
  const [lobbyMenuAnchor, setLobbyMenuAnchor] = useState<HTMLButtonElement>();
  return (
    <>
      <>
        <div className="room-id">
          <RoomIdCopy
            roomId={roomId}
            onCopyError={() => setError(t("roomNumberCopyFailed"))}
          />
          <div className="room-id-controls">
            <button
              className="room-id-control"
              type="button"
              aria-label={t("spectatorCount", {
                count: spectatorCount,
                suffix: locale === "en" && spectatorCount !== 1 ? "s" : "",
              })}
              aria-haspopup="dialog"
              aria-expanded={spectatorMenuOpen}
              title={t("spectators")}
              onClick={(event) => {
                setSpectatorMenuAnchor(event.currentTarget);
                setSpectatorMenuOpen(true);
              }}
            >
              <Eye aria-hidden="true" />
              {spectatorCount > 0 && (
                <span className="room-id-control-badge" aria-hidden="true">
                  {spectatorCount > 99 ? "99+" : spectatorCount}
                </span>
              )}
            </button>
            <button
              className="room-id-control"
              type="button"
              aria-label={t("shareRoom")}
              aria-haspopup="dialog"
              aria-expanded={inviteDialogOpen}
              title={t("shareRoom")}
              onClick={() => setInviteDialogOpen(true)}
            >
              <Share2 aria-hidden="true" />
            </button>
            <button
              className="room-id-control"
              type="button"
              aria-label={t("roomOptions")}
              aria-expanded={lobbyMenuOpen}
              onClick={(event) => {
                setLobbyMenuAnchor(event.currentTarget);
                setLobbyMenuOpen(true);
              }}
            >
              <MoreHorizontal aria-hidden="true" />
            </button>
          </div>
        </div>
        <header className="room-hero">
          <div className="room-hero-heading">
            {gameIconHref && (
              <img
                className="room-hero-icon"
                src={gameIconHref}
                alt=""
                referrerPolicy="no-referrer"
              />
            )}
            <h1>{gameName}</h1>
          </div>
        </header>
        <section className="lobby-panel" aria-live="polite">
          <RoomSeats controls={controls} />
        </section>
        <div className="room-actions">
          {isOwner && (
            <button
              className="primary start-game"
              aria-disabled={startUnavailableReason ? true : undefined}
              aria-describedby={
                startUnavailableHint ? "start-unavailable-hint" : undefined
              }
              onClick={() => {
                if (startUnavailableReason) {
                  showStartUnavailableHint();
                  return;
                }
                void start();
              }}
            >
              {starting ? t("starting") : t("startGame")}
              {startUnavailableHint && (
                <span
                  className={`start-game-tooltip ${startUnavailableHintClosing ? "start-game-tooltip-exiting" : ""}`}
                  id="start-unavailable-hint"
                  role="tooltip"
                  onAnimationEnd={() => {
                    if (!startUnavailableHintClosing) return;
                    setStartUnavailableHint(undefined);
                    setStartUnavailableHintClosing(false);
                  }}
                >
                  {startUnavailableHint}
                </span>
              )}
            </button>
          )}
          {!isOwner && selfPlayer && (
            <button
              className={
                selfPlayer.ready ? "cancel-ready" : "primary start-game"
              }
              onClick={() => void setReady()}
            >
              {selfPlayer.ready ? t("cancelReady") : t("ready")}
            </button>
          )}
          {!isOwner && isSpectating && (
            <button
              className="primary start-game"
              disabled={firstOpenSeat === undefined}
              onClick={() => void joinFirstOpenSeat()}
            >
              {t("joinRoom")}
            </button>
          )}
          <button type="button" onClick={() => void shareInvite()}>
            {copied ? t("inviteLinkCopied") : t("shareRoomAction")}
          </button>
        </div>
      </>
      {phase === "lobby" && lobbyMenuOpen && lobbyMenuAnchor && (
        <Menu
          ariaLabel={t("roomOptions")}
          anchor={lobbyMenuAnchor}
          className="lobby-menu"
          onClose={() => setLobbyMenuOpen(false)}
        >
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setLobbyMenuOpen(false);
              setGameInfoOpen(true);
            }}
          >
            {t("gameInfo")}
          </button>
          {gameHelpHref && (
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setLobbyMenuOpen(false);
                setGameHelpOpen(true);
              }}
            >
              {t("gameHelp")}
            </button>
          )}
          {isOwner && (
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setLobbyMenuOpen(false);
                setChangeGameOpen(true);
              }}
            >
              {t("changeGame")}
            </button>
          )}
          {isOwner ? (
            <button
              className="menu-danger"
              type="button"
              role="menuitem"
              onClick={() => {
                setLobbyMenuOpen(false);
                setDissolveDialogOpen(true);
              }}
            >
              {t("dissolveRoomAction")}
            </button>
          ) : (
            <button
              className="menu-danger"
              type="button"
              role="menuitem"
              onClick={() => {
                setLobbyMenuOpen(false);
                requestBack();
              }}
            >
              {t("leaveRoomAction")}
            </button>
          )}
        </Menu>
      )}
      {phase === "lobby" && spectatorMenuOpen && spectatorMenuAnchor && (
        <Menu
          ariaLabel={t("spectators")}
          anchor={spectatorMenuAnchor}
          className="spectator-menu"
          role="dialog"
          onClose={() => setSpectatorMenuOpen(false)}
        >
          {(closeMenu) => (
            <>
              {selfPlayer && !isOwner && (
                <>
                  <button
                    className="spectator-menu-action"
                    type="button"
                    onClick={() => closeMenu(() => void chooseSeat(null))}
                  >
                    <Eye aria-hidden="true" />
                    <span>{t("switchToSpectating")}</span>
                  </button>
                  <div className="spectator-menu-divider" role="separator" />
                </>
              )}
              <div className="spectator-menu-heading">{t("spectators")}</div>
              {spectatorCount > 0 ? (
                <ul className="spectator-menu-list">
                  {lobby?.spectators.map((spectator, index) => (
                    <li key={spectator.id}>
                      <span className="spectator-menu-avatar">
                        {spectator.avatarUrl ? (
                          <img
                            src={spectator.avatarUrl}
                            alt=""
                            loading="lazy"
                            referrerPolicy="no-referrer"
                          />
                        ) : (
                          <UserRound aria-hidden="true" />
                        )}
                      </span>
                      <span className="spectator-menu-name">
                        {spectator.name ||
                          t("spectatorFallback", { number: index + 1 })}
                      </span>
                      {spectator.id === selfId && <small>{t("you")}</small>}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="spectator-menu-empty">{t("noSpectators")}</p>
              )}
            </>
          )}
        </Menu>
      )}
    </>
  );
}
