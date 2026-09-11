import { useEffect, useRef, useState } from "react";
import { ChevronRight } from "lucide-react";
import Dialog from "@/components/Dialog";
import type { ShelfGame } from "@/features/game/GameShelf";
import { localizeGameName, useI18n } from "@/app/i18n";
import { roomIdFromInput } from "@/features/game/game-launch";

interface LaunchChoiceDialogProps {
  game: ShelfGame;
  roomCode: string;
  onRoomCodeChange(value: string): void;
  onClose(): void;
  onPlaySolo(): void;
  onCreateRoom(): void;
  onJoinRoom(roomId: string): void;
}

export default function LaunchChoiceDialog({
  game,
  roomCode,
  onRoomCodeChange,
  onClose,
  onPlaySolo,
  onCreateRoom,
  onJoinRoom,
}: LaunchChoiceDialogProps) {
  const { locale, t } = useI18n();
  const roomId = roomIdFromInput(roomCode);
  const gameName = localizeGameName(game, locale);
  const [joinRoomOpen, setJoinRoomOpen] = useState(false);
  const roomCodeInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!joinRoomOpen) return;
    roomCodeInput.current?.focus();
  }, [joinRoomOpen]);

  return (
    <Dialog title={t("playGame")} contentLayout="flush" onDismiss={onClose}>
      <div className="launch-choice">
        <div className="launch-choice-game">
          <span className="shelf-art">
            {game.icon ? (
              <img src={game.icon} alt="" referrerPolicy="no-referrer" />
            ) : (
              <span>{gameName.slice(0, 2).toUpperCase()}</span>
            )}
          </span>
          <strong>{gameName}</strong>
        </div>
        <hr className="launch-choice-divider" />
        <div
          className={`launch-choice-panels ${
            joinRoomOpen ? "launch-choice-panels-join" : ""
          }`}
        >
          <div className="launch-choice-menu" aria-hidden={joinRoomOpen}>
            <button type="button" disabled={joinRoomOpen} onClick={onPlaySolo}>
              <span>{t("playSolo")}</span>
              <ChevronRight aria-hidden="true" />
            </button>
            <hr className="launch-choice-divider" />
            <button
              type="button"
              disabled={joinRoomOpen}
              onClick={onCreateRoom}
            >
              <span>{t("createRoom")}</span>
              <ChevronRight aria-hidden="true" />
            </button>
            <hr className="launch-choice-divider" />
            <button
              type="button"
              disabled={joinRoomOpen}
              onClick={() => setJoinRoomOpen(true)}
            >
              <span>{t("joinRoom")}</span>
              <ChevronRight aria-hidden="true" />
            </button>
          </div>
          <div className="launch-choice-join-panel" aria-hidden={!joinRoomOpen}>
            <form
              id="launch-choice-room-form"
              className="launch-choice-join"
              onSubmit={(event) => {
                event.preventDefault();
                if (roomId) onJoinRoom(roomId);
              }}
            >
              <div className="launch-choice-join-field">
                <input
                  ref={roomCodeInput}
                  type="text"
                  disabled={!joinRoomOpen}
                  placeholder={t("enterRoomCode")}
                  value={roomCode}
                  onChange={(event) => onRoomCodeChange(event.target.value)}
                />
              </div>
              <hr className="launch-choice-divider" />
              <div className="launch-choice-join-actions">
                <button
                  type="button"
                  disabled={!joinRoomOpen}
                  onClick={() => setJoinRoomOpen(false)}
                >
                  {t("back")}
                </button>
                <hr className="launch-choice-divider-vertical" />
                <button type="submit" disabled={!joinRoomOpen || !roomId}>
                  {t("joinRoom")}
                </button>
              </div>
            </form>
          </div>
        </div>
      </div>
    </Dialog>
  );
}
