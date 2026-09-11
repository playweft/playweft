import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import { Info, Star, StarOff, Trash2 } from "lucide-react";
import type { FeaturedGame } from "@/features/game/featured-games";
import Menu, { type MenuHandle, type MenuPosition } from "@/components/Menu";
import type { DiscoveredGame as RecentGame } from "@/features/game/game-manifest";
import { localizeGameName, useI18n } from "@/app/i18n";

type MenuGame = RecentGame | FeaturedGame;

interface GameMenuProps {
  game: MenuGame;
  anchor?: HTMLElement;
  position?: MenuPosition;
  isFavorite: boolean;
  canDelete: boolean;
  closeRequested?: boolean;
  onClose(): void;
  onShowInfo(): void;
  onToggleFavorite(): void;
  onDelete(): void;
}

export interface GameMenuHandle {
  close(): void;
}

const GameMenu = forwardRef<GameMenuHandle, GameMenuProps>(function GameMenu({
  game,
  anchor,
  position,
  isFavorite,
  canDelete,
  closeRequested = false,
  onClose,
  onShowInfo,
  onToggleFavorite,
  onDelete,
}, forwardedRef) {
  const { locale, t } = useI18n();
  const menu = useRef<MenuHandle>(null);
  useImperativeHandle(forwardedRef, () => ({
    close: () => menu.current?.close(),
  }));

  useEffect(() => {
    if (closeRequested) menu.current?.close();
  }, [closeRequested]);

  const act = (action: () => void) => {
    menu.current?.close(action);
  };

  return (
    <Menu
      ref={menu}
      ariaLabel={t("gameActions", {
        name: localizeGameName(game, locale),
      })}
      anchor={anchor}
      position={position}
      backdropClassName="game-card-menu-backdrop"
      className="game-card-menu"
      onClose={onClose}
    >
      <button type="button" role="menuitem" onClick={() => act(onShowInfo)}>
        <Info aria-hidden="true" />
        <span>{t("gameInfo")}</span>
      </button>
      <button
        type="button"
        role="menuitem"
        onClick={() => act(onToggleFavorite)}
      >
        {isFavorite ? (
          <StarOff aria-hidden="true" />
        ) : (
          <Star aria-hidden="true" />
        )}
        <span>{isFavorite ? t("unfavorite") : t("favorite")}</span>
      </button>
      {canDelete && (
        <button
          className="menu-danger"
          type="button"
          role="menuitem"
          onClick={() => act(onDelete)}
        >
          <Trash2 aria-hidden="true" />
          <span>{t("delete")}</span>
        </button>
      )}
    </Menu>
  );
});

export default GameMenu;
