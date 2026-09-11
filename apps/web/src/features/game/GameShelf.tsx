import {
  DndContext,
  MouseSensor,
  TouchSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  arrayMove,
  rectSortingStrategy,
  useSortable,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ComponentPropsWithRef,
  type HTMLAttributes,
  type TouchEvent as ReactTouchEvent,
} from "react";
import type { FeaturedGame } from "@/features/game/featured-games";
import type { DiscoveredGame as RecentGame } from "@/features/game/game-manifest";
import { localizeGameName, useI18n } from "@/app/i18n";
import type { MenuPosition } from "@/components/Menu";

export type ShelfGame = RecentGame | FeaturedGame;
export type GameShelfKind = "favorite" | "recent" | "recommended";
export type ShelfGamePhase = "entering" | "exiting";

interface GameShelfProps {
  title: string;
  kind: GameShelfKind;
  games: ShelfGame[];
  activeGameId?: string;
  getItemClassName?(game: ShelfGame): string;
  onItemAnimationEnd?(game: ShelfGame): void;
  onSelect(game: ShelfGame): void;
  onOpenMenu(
    game: ShelfGame,
    kind: GameShelfKind,
    position: MenuPosition,
  ): void;
  onReorder?(games: ShelfGame[]): void;
  onDismissMenu?(): void;
}

interface ShelfGameCardProps {
  game: ShelfGame;
  kind: GameShelfKind;
  activeGameId?: string;
  className?: string;
  onAnimationEnd?(): void;
  onSelect(game: ShelfGame): void;
  onOpenMenu(
    game: ShelfGame,
    kind: GameShelfKind,
    position: MenuPosition,
  ): void;
  onTouchStart?(game: ShelfGame, event: ReactTouchEvent<HTMLButtonElement>): void;
  onTouchMove?(game: ShelfGame, event: ReactTouchEvent<HTMLButtonElement>): void;
  onTouchEnd?(game: ShelfGame): void;
  onTouchCancel?(game: ShelfGame): void;
  buttonProps?: HTMLAttributes<HTMLButtonElement>;
  slotProps?: ComponentPropsWithRef<"div">;
}

interface TouchMenuPress {
  game: ShelfGame;
  x: number;
  y: number;
  timer?: number;
  opened: boolean;
}

interface DropTransition {
  gameId: string;
  fromX: number;
  fromY: number;
}

const DRAG_START_DISTANCE_PX = 8;
const TOUCH_MENU_DELAY_MS = 400;
const TOUCH_LONG_PRESS_DELAY_MS = TOUCH_MENU_DELAY_MS;
const TOUCH_MOVEMENT_TOLERANCE_PX = 5;
const SORTABLE_TRANSITION = {
  duration: 140,
  easing: "cubic-bezier(0.22, 1, 0.36, 1)",
};

export default function GameShelf({
  title,
  kind,
  games,
  activeGameId,
  getItemClassName,
  onItemAnimationEnd,
  onSelect,
  onOpenMenu,
  onReorder,
  onDismissMenu,
}: GameShelfProps) {
  const [dropTransition, setDropTransition] = useState<DropTransition>();
  const gameNodes = useRef(new Map<string, HTMLDivElement>());
  const touchMenuPress = useRef<TouchMenuPress | undefined>(undefined);
  const sortable = Boolean(onReorder && games.length > 1);
  const sensors = useSensors(
    useSensor(MouseSensor, {
      activationConstraint: { distance: DRAG_START_DISTANCE_PX },
    }),
    useSensor(TouchSensor, {
      activationConstraint: {
        delay: TOUCH_LONG_PRESS_DELAY_MS,
        tolerance: TOUCH_MOVEMENT_TOLERANCE_PX,
      },
    }),
  );
  const titleId = `${title.toLowerCase().replaceAll(" ", "-")}-title`;
  const clearTouchMenuPress = () => {
    const press = touchMenuPress.current;
    if (press?.timer !== undefined) window.clearTimeout(press.timer);
    touchMenuPress.current = undefined;
  };
  const registerGameNode = useCallback(
    (gameId: string, node: HTMLDivElement | null) => {
      if (node) gameNodes.current.set(gameId, node);
      else gameNodes.current.delete(gameId);
    },
    [],
  );
  const finishDropTransition = useCallback((gameId: string) => {
    setDropTransition((current) =>
      current?.gameId === gameId ? undefined : current,
    );
  }, []);
  const startTouchMenu = (
    game: ShelfGame,
    event: ReactTouchEvent<HTMLButtonElement>,
  ) => {
    const touch = event.touches[0];
    if (!touch) return;
    clearTouchMenuPress();
    const press: TouchMenuPress = {
      game,
      x: touch.clientX,
      y: touch.clientY,
      opened: false,
    };
    press.timer = window.setTimeout(() => {
      if (touchMenuPress.current !== press) return;
      press.opened = true;
      press.timer = undefined;
      onOpenMenu(game, kind, { left: press.x, top: press.y });
    }, TOUCH_MENU_DELAY_MS);
    touchMenuPress.current = press;
  };
  const moveTouchMenu = (
    game: ShelfGame,
    event: ReactTouchEvent<HTMLButtonElement>,
  ) => {
    const press = touchMenuPress.current;
    const touch = event.touches[0];
    if (!press || press.game.manifestId !== game.manifestId || !touch) return;
    if (
      !press.opened &&
      Math.hypot(touch.clientX - press.x, touch.clientY - press.y) >
        TOUCH_MOVEMENT_TOLERANCE_PX
    ) {
      clearTouchMenuPress();
    }
  };
  useEffect(() => clearTouchMenuPress, []);
  const content = (
    <section className="game-shelf" aria-labelledby={titleId}>
      <div className="shelf-heading">
        <h2 id={titleId}>{title}</h2>
      </div>
      <div className="shelf-row">
        {games.map((game) => {
          const props: ShelfGameCardProps = {
            game,
            kind,
            activeGameId,
            className: getItemClassName?.(game),
            onAnimationEnd: () => onItemAnimationEnd?.(game),
            onSelect,
            onOpenMenu,
            onTouchStart: startTouchMenu,
            onTouchMove: moveTouchMenu,
            onTouchEnd: clearTouchMenuPress,
            onTouchCancel: clearTouchMenuPress,
          };
          return sortable ? (
            <SortableShelfGameCard
              key={game.manifestId}
              {...props}
              dropTransition={dropTransition}
              onDropTransitionEnd={finishDropTransition}
              onNodeChange={registerGameNode}
            />
          ) : (
            <ShelfGameCard key={game.manifestId} {...props} />
          );
        })}
      </div>
    </section>
  );

  if (!sortable || !onReorder) return content;

  const onDragStart = ({ activatorEvent }: DragStartEvent) => {
    if (!("touches" in activatorEvent)) onDismissMenu?.();
  };

  const onDragMove = () => {
    if (!touchMenuPress.current?.opened) return;
    clearTouchMenuPress();
    onDismissMenu?.();
  };

  const onDragEnd = ({ active, over }: DragEndEvent) => {
    clearTouchMenuPress();
    if (!over || active.id === over.id) return;
    const fromIndex = games.findIndex((game) => game.manifestId === active.id);
    const toIndex = games.findIndex((game) => game.manifestId === over.id);
    if (fromIndex < 0 || toIndex < 0) return;
    const rect = gameNodes.current.get(String(active.id))?.getBoundingClientRect();
    if (rect) {
      setDropTransition({
        gameId: String(active.id),
        fromX: rect.left,
        fromY: rect.top,
      });
    }
    onReorder(arrayMove(games, fromIndex, toIndex));
  };

  return (
    <DndContext
      collisionDetection={closestCenter}
      sensors={sensors}
      onDragStart={onDragStart}
      onDragMove={onDragMove}
      onDragCancel={() => {
        setDropTransition(undefined);
        clearTouchMenuPress();
      }}
      onDragEnd={onDragEnd}
    >
      <SortableContext
        items={games.map((game) => game.manifestId)}
        strategy={rectSortingStrategy}
      >
        {content}
      </SortableContext>
    </DndContext>
  );
}

interface SortableShelfGameCardProps extends ShelfGameCardProps {
  dropTransition?: DropTransition;
  onDropTransitionEnd(gameId: string): void;
  onNodeChange(gameId: string, node: HTMLDivElement | null): void;
}

function SortableShelfGameCard({
  dropTransition,
  onDropTransitionEnd,
  onNodeChange,
  ...props
}: SortableShelfGameCardProps) {
  const { game } = props;
  const node = useRef<HTMLDivElement | null>(null);
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({
    id: game.manifestId,
    transition: SORTABLE_TRANSITION,
  });
  const isDropping = dropTransition?.gameId === game.manifestId;

  useLayoutEffect(() => {
    if (!isDropping || !dropTransition || !node.current) return;
    const target = node.current.getBoundingClientRect();
    const dx = dropTransition.fromX - target.left;
    const dy = dropTransition.fromY - target.top;
    if (!dx && !dy) {
      onDropTransitionEnd(game.manifestId);
      return;
    }
    const animation = node.current.animate(
      [
        { transform: `translate(${dx}px, ${dy}px)` },
        { transform: "translate(0, 0)" },
      ],
      {
        duration: window.matchMedia("(prefers-reduced-motion: reduce)").matches
          ? 0
          : SORTABLE_TRANSITION.duration,
        easing: SORTABLE_TRANSITION.easing,
      },
    );
    animation.onfinish = () => onDropTransitionEnd(game.manifestId);
    return () => animation.cancel();
  }, [dropTransition, game.manifestId, isDropping, onDropTransitionEnd]);

  return (
    <ShelfGameCard
      {...props}
      className={`${props.className ?? ""} ${isDragging ? "shelf-game-dragging" : ""}`}
      slotProps={{
        ref: (element) => {
          node.current = element;
          setNodeRef(element);
          onNodeChange(game.manifestId, element);
        },
        style: {
          transform: isDropping ? undefined : CSS.Transform.toString(transform),
          transition: isDropping ? "none" : transition,
        },
      }}
      buttonProps={{
        ...attributes,
        ...listeners,
      }}
    />
  );
}

function ShelfGameCard({
  game,
  kind,
  activeGameId,
  className,
  onAnimationEnd,
  onSelect,
  onOpenMenu,
  onTouchStart,
  onTouchMove,
  onTouchEnd,
  onTouchCancel,
  buttonProps,
  slotProps,
}: ShelfGameCardProps) {
  const { locale } = useI18n();
  return (
    <div
      {...slotProps}
      className={`shelf-game-slot ${activeGameId === game.manifestId ? "shelf-game-menu-target" : ""} ${className ?? ""}`}
      onAnimationEnd={(event) => {
        if (event.target === event.currentTarget) onAnimationEnd?.();
      }}
    >
      <button
        {...buttonProps}
        className="shelf-game"
        data-favorite-game-id={
          kind === "favorite" ? game.manifestId : undefined
        }
        onClick={() => onSelect(game)}
        onTouchStart={(event) => {
          buttonProps?.onTouchStart?.(event);
          onTouchStart?.(game, event);
        }}
        onTouchMove={(event) => {
          buttonProps?.onTouchMove?.(event);
          onTouchMove?.(game, event);
        }}
        onTouchEnd={(event) => {
          buttonProps?.onTouchEnd?.(event);
          onTouchEnd?.(game);
        }}
        onTouchCancel={(event) => {
          buttonProps?.onTouchCancel?.(event);
          onTouchCancel?.(game);
        }}
        onContextMenu={(event) => {
          event.preventDefault();
          event.currentTarget.focus();
          onOpenMenu(game, kind, {
            left: event.clientX,
            top: event.clientY,
          });
        }}
      >
        <span className="shelf-art">
          {game.icon ? (
            <img src={game.icon} alt="" referrerPolicy="no-referrer" />
          ) : (
            <span>{localizeGameName(game, locale).slice(0, 2).toUpperCase()}</span>
          )}
        </span>
        <span className="shelf-game-name">
          {localizeGameName(game, locale)}
        </span>
      </button>
    </div>
  );
}
