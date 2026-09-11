import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type MouseEventHandler,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { useI18n } from "@/app/i18n";

export interface MenuPosition {
  left: number;
  top: number;
}

interface MenuProps {
  ariaLabel: string;
  children: ReactNode | ((close: MenuClose) => ReactNode);
  anchor?: HTMLElement;
  anchorHoverGuard?: boolean;
  autoFocus?: boolean;
  backdropClassName?: string;
  className?: string;
  position?: MenuPosition;
  role?: "dialog" | "menu";
  style?: CSSProperties;
  onMouseEnter?: MouseEventHandler<HTMLDivElement>;
  onMouseLeave?: MouseEventHandler<HTMLDivElement>;
  onClose(): void;
}

const MENU_GUTTER = 12;
export type MenuClose = (afterClose?: () => void) => void;

export interface MenuHandle {
  close: MenuClose;
}

const Menu = forwardRef<MenuHandle, MenuProps>(function Menu(
  {
    ariaLabel,
    children,
    anchor,
    anchorHoverGuard = false,
    autoFocus = true,
    backdropClassName = "",
    className = "",
    position,
    role = "menu",
    style,
    onMouseEnter,
    onMouseLeave,
    onClose,
  },
  forwardedRef,
) {
  const { t } = useI18n();
  const menu = useRef<HTMLDivElement>(null);
  const afterClose = useRef<(() => void) | undefined>(undefined);
  const closingRef = useRef(false);
  const [closing, setClosing] = useState(false);
  const [anchorGuardStyle, setAnchorGuardStyle] = useState<CSSProperties>();
  const [computedPosition, setComputedPosition] = useState<CSSProperties>();
  const close = useCallback<MenuClose>((after) => {
    if (closingRef.current) return;
    closingRef.current = true;
    afterClose.current = after;
    setClosing(true);
  }, []);

  useImperativeHandle(forwardedRef, () => ({ close }), [close]);

  useLayoutEffect(() => {
    const element = menu.current;
    if (!element) return;
    const width = element.offsetWidth;
    const height = element.offsetHeight;
    const maxLeft = window.innerWidth - width - MENU_GUTTER;
    const maxTop = window.innerHeight - height - MENU_GUTTER;

    if (position) {
      const left = clamp(position.left, MENU_GUTTER, maxLeft);
      const top = clamp(position.top, MENU_GUTTER, maxTop);
      setComputedPosition({
        left,
        top,
        transformOrigin: `${clamp(position.left - left, MENU_GUTTER, width - MENU_GUTTER)}px ${clamp(position.top - top, MENU_GUTTER, height - MENU_GUTTER)}px`,
      });
      return;
    }

    if (!anchor) {
      setAnchorGuardStyle(undefined);
      return;
    }
    const anchorRect = anchor.getBoundingClientRect();
    setAnchorGuardStyle(
      anchorHoverGuard
        ? {
            top: anchorRect.top,
            left: anchorRect.left,
            width: anchorRect.width,
            height: anchorRect.height,
          }
        : undefined,
    );
    const preferredTop = anchorRect.bottom + 8;
    const flippedTop = anchorRect.top - height - 8;
    const opensAbove = preferredTop > maxTop && flippedTop >= MENU_GUTTER;
    const left = clamp(anchorRect.right - width, MENU_GUTTER, maxLeft);
    const top = clamp(opensAbove ? flippedTop : preferredTop, MENU_GUTTER, maxTop);
    setComputedPosition({
      top,
      left,
      transformOrigin: `${clamp(anchorRect.left + anchorRect.width / 2 - left, MENU_GUTTER, width - MENU_GUTTER)}px ${opensAbove ? "bottom" : "top"}`,
    });
  }, [anchor, anchorHoverGuard, position]);

  useEffect(() => {
    if (autoFocus) {
      const firstAction = menu.current?.querySelector<HTMLButtonElement>(
        "button:not(:disabled)",
      );
      (firstAction ?? (role === "dialog" ? menu.current : undefined))?.focus();
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    const closeFromViewportChange = () => close();
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("resize", closeFromViewportChange);
    window.addEventListener("scroll", closeFromViewportChange, true);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("resize", closeFromViewportChange);
      window.removeEventListener("scroll", closeFromViewportChange, true);
    };
  }, [autoFocus, close, role]);

  useEffect(() => {
    if (!closing) return;
    const finish = () => {
      onClose();
      afterClose.current?.();
    };
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      finish();
      return;
    }
    const timeout = window.setTimeout(finish, 170);
    return () => window.clearTimeout(timeout);
  }, [closing, onClose]);

  return createPortal(
    <>
      <button
        className={`menu-backdrop ${backdropClassName} ${closing ? "menu-backdrop-closing" : ""}`}
        type="button"
        aria-label={t("closeMenu", { label: ariaLabel })}
        onClick={() => close()}
      />
      {anchorGuardStyle && (
        <div
          className="menu-anchor-hover-guard"
          style={anchorGuardStyle}
          aria-hidden="true"
          onMouseEnter={closing ? undefined : onMouseEnter}
          onMouseLeave={closing ? undefined : onMouseLeave}
          onClick={() => {
            // The guard exists only to bridge the gap between an anchor and
            // its hover-opened menu. Forward its click so the trigger remains
            // the single owner of menu toggle semantics.
            anchor?.click();
          }}
        />
      )}
      <div
        ref={menu}
        className={`menu ${className} ${closing ? "menu-closing" : ""}`}
        role={role}
        aria-label={ariaLabel}
        tabIndex={role === "dialog" ? -1 : undefined}
        style={{ ...computedPosition, ...style }}
        onMouseEnter={closing ? undefined : onMouseEnter}
        onMouseLeave={closing ? undefined : onMouseLeave}
      >
        {typeof children === "function" ? children(close) : children}
      </div>
    </>,
    document.body,
  );
});

export default Menu;

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(value, max));
}
