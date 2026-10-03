import { useEffect, useRef, useState } from "react";
import { Armchair, Check, Crown, MoreHorizontal } from "lucide-react";
import { useI18n } from "@/app/i18n";
import type { RoomControls } from "./useRoomControls";

export default function RoomSeats({ controls }: { controls: RoomControls }) {
  const { t } = useI18n();
  const {
    lobby,
    selfId,
    isOwner,
    isSpectating,
    playerCapacity,
    chooseSeat,
    transferHost,
    kick,
  } = controls;
  const [playerMenuId, setPlayerMenuId] = useState<string>();
  const [playerMenuClosing, setPlayerMenuClosing] = useState(false);
  const menuTimer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(menuTimer.current), []);
  const playerGridClassName = [
    "player-grid",
    `player-grid-cols-${desktopPlayerGridColumns(playerCapacity)}`,
    `player-grid-mobile-cols-${mobilePlayerGridColumnsFor(playerCapacity)}`,
    `player-grid-${playerGridDensityFor(playerCapacity)}`,
  ].join(" ");
  const closePlayerMenu = (after?: () => void) => {
    if (!playerMenuId || playerMenuClosing) return;
    setPlayerMenuClosing(true);
    menuTimer.current = window.setTimeout(() => {
      setPlayerMenuId(undefined);
      setPlayerMenuClosing(false);
      after?.();
    }, 140);
  };

  const togglePlayerMenu = (playerId: string) => {
    if (playerMenuClosing) return;
    if (playerMenuId === playerId) {
      closePlayerMenu();
      return;
    }
    setPlayerMenuClosing(false);
    setPlayerMenuId(playerId);
  };

  return (
    <ol className={playerGridClassName}>
      {Array.from({ length: playerCapacity }, (_, index) => {
        const seat = index + 1;
        const player = lobby?.players.find(
          (candidate) => candidate.seat === seat,
        );
        if (!player)
          return (
            <li key={`seat-${seat}`} className="player-card player-card-empty">
              <button
                className="player-card-action"
                type="button"
                onClick={() => void chooseSeat(seat)}
                aria-label={
                  isSpectating
                    ? t("joinSeat", { seat })
                    : t("moveToSeat", { seat })
                }
              />
              <span className="player-avatar player-avatar-seat">
                <Armchair aria-hidden="true" />
              </span>
              <span className="player-card-copy">
                <strong className="player-name">{t("sitHere")}</strong>
              </span>
            </li>
          );
        const isSelf = player.id === selfId;
        const isHost = player.id === lobby?.ownerId;
        const playerName = player.name || t("player", { seat });
        return (
          <li
            key={player.id}
            className={`player-card player-card-occupied ${isSelf ? "player-card-self" : "player-card-other"} ${playerMenuId === player.id ? "player-card-menu-open" : ""}`}
          >
            <div className="player-avatar-wrap">
              <span
                className={`player-avatar avatar-${(seat - 1) % 4} ${isSelf ? "player-avatar-self" : ""}`}
                title={isSelf ? t("you") : undefined}
              >
                {player.avatarUrl ? (
                  <img
                    src={player.avatarUrl}
                    alt=""
                    referrerPolicy="no-referrer"
                  />
                ) : (
                  <>P{seat}</>
                )}
                {!isHost && (
                  <span
                    className={`player-ready-marker ${player.ready ? "player-ready-marker-ready" : "player-ready-marker-pending"}`}
                    title={player.ready ? t("ready") : t("notReady")}
                    aria-label={player.ready ? t("ready") : t("notReady")}
                  >
                    {player.ready && <Check aria-hidden="true" />}
                  </span>
                )}
              </span>
              {isOwner && !isSelf && (
                <>
                  {playerMenuId === player.id && (
                    <button
                      className={`player-menu-backdrop ${playerMenuClosing ? "player-menu-backdrop-closing" : ""}`}
                      type="button"
                      aria-label={t("closePlayerMenu")}
                      onClick={() => closePlayerMenu()}
                    />
                  )}
                  <button
                    className="player-menu-toggle"
                    type="button"
                    aria-label={t("playerOptions", {
                      name: playerName,
                    })}
                    aria-expanded={playerMenuId === player.id}
                    onClick={() => togglePlayerMenu(player.id)}
                  >
                    <MoreHorizontal aria-hidden="true" />
                  </button>
                  {playerMenuId === player.id && (
                    <div
                      className={`player-menu ${playerMenuClosing ? "player-menu-closing" : ""}`}
                      role="menu"
                    >
                      <button
                        type="button"
                        role="menuitem"
                        onClick={() =>
                          closePlayerMenu(() => void transferHost(player.id))
                        }
                      >
                        {t("makeHost")}
                      </button>
                      <button
                        className="player-menu-remove"
                        type="button"
                        role="menuitem"
                        onClick={() =>
                          closePlayerMenu(() => void kick(player.id))
                        }
                      >
                        {t("remove")}
                      </button>
                    </div>
                  )}
                </>
              )}
            </div>
            <span className="player-card-copy">
              <strong className="player-name" title={player.name}>
                {playerName}
                {isHost && (
                  <span
                    className="host-crown"
                    title={t("host")}
                    aria-label={t("host")}
                  >
                    <Crown aria-hidden="true" />
                  </span>
                )}
              </strong>
            </span>
          </li>
        );
      })}
    </ol>
  );
}

function desktopPlayerGridColumns(capacity: number): 2 | 3 | 4 {
  if (capacity <= 2) return 2;
  if (capacity === 3) return 3;
  if (capacity === 4) return 4;
  if (capacity <= 6 || capacity === 9) return 3;
  return 4;
}

function mobilePlayerGridColumnsFor(capacity: number): 1 | 2 | 3 | 4 {
  if (capacity <= 4) return 1;
  if (capacity <= 8) return 2;
  if (capacity <= 12) return 3;
  return 4;
}

function playerGridDensityFor(capacity: number): "full" | "compact" | "dense" {
  if (capacity <= 4) return "full";
  if (capacity <= 12) return "compact";
  return "dense";
}
