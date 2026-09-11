import {
  useEffect,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import Menu, { type MenuClose, type MenuHandle } from "@/components/Menu";

const HOVER_CLOSE_DELAY = 150;

export interface AnchoredMenuTriggerProps {
  anchorRef: RefObject<HTMLButtonElement | null>;
  expanded: boolean;
  onClick(): void;
  onMouseEnter(): void;
  onMouseLeave(): void;
}

interface AnchoredMenuProps {
  ariaLabel: string;
  children: ReactNode | ((close: MenuClose) => ReactNode);
  className?: string;
  backdropClassName?: string;
  disabled?: boolean;
  openOnHover?: boolean;
  trigger(props: AnchoredMenuTriggerProps): ReactNode;
}

export default function AnchoredMenu({
  ariaLabel,
  children,
  className,
  backdropClassName,
  disabled = false,
  openOnHover = false,
  trigger,
}: AnchoredMenuProps) {
  const anchor = useRef<HTMLButtonElement>(null);
  const menu = useRef<MenuHandle>(null);
  const hoverCloseTimer = useRef<number | undefined>(undefined);
  const suppressHoverOpen = useRef(false);
  const openedFromHover = useRef(false);
  const [open, setOpen] = useState(false);
  const [autoFocus, setAutoFocus] = useState(true);

  const cancelHoverClose = () => {
    window.clearTimeout(hoverCloseTimer.current);
    hoverCloseTimer.current = undefined;
  };

  const scheduleHoverClose = () => {
    if (!openOnHover || !window.matchMedia("(hover: hover)").matches) return;
    cancelHoverClose();
    hoverCloseTimer.current = window.setTimeout(() => {
      if (menu.current) {
        menu.current.close();
      } else {
        openedFromHover.current = false;
        setOpen(false);
      }
    }, HOVER_CLOSE_DELAY);
  };

  const prepareAnchorClickClose = () => {
    suppressHoverOpen.current = true;
    cancelHoverClose();
  };

  const promoteHoverMenu = () => {
    if (openedFromHover.current) {
      openedFromHover.current = false;
      cancelHoverClose();
      setAutoFocus(true);
      return true;
    }
    return false;
  };

  const openFromHover = () => {
    if (
      disabled ||
      !openOnHover ||
      !window.matchMedia("(hover: hover)").matches ||
      suppressHoverOpen.current
    ) {
      return;
    }
    cancelHoverClose();
    if (!open) openedFromHover.current = true;
    setAutoFocus(false);
    setOpen(true);
  };

  const leaveAnchor = () => {
    suppressHoverOpen.current = false;
    scheduleHoverClose();
  };

  const toggleFromAnchor = () => {
    if (disabled) return;
    if (open) {
      // A hover-opened menu survives its first click: that click turns it
      // into an explicit, keyboard-focused menu. A later click closes it.
      if (promoteHoverMenu()) return;
      prepareAnchorClickClose();
      menu.current?.close();
      return;
    }
    openedFromHover.current = false;
    cancelHoverClose();
    setAutoFocus(true);
    setOpen(true);
  };

  useEffect(() => () => window.clearTimeout(hoverCloseTimer.current), []);

  useEffect(() => {
    if (disabled && open) menu.current?.close();
  }, [disabled, open]);

  return (
    <>
      {trigger({
        anchorRef: anchor,
        expanded: open,
        onClick: toggleFromAnchor,
        onMouseEnter: openFromHover,
        onMouseLeave: leaveAnchor,
      })}
      {open && (
        <Menu
          ref={menu}
          ariaLabel={ariaLabel}
          anchor={anchor.current ?? undefined}
          anchorHoverGuard={openOnHover}
          autoFocus={autoFocus}
          backdropClassName={backdropClassName}
          className={className}
          onMouseEnter={cancelHoverClose}
          onMouseLeave={scheduleHoverClose}
          onClose={() => {
            openedFromHover.current = false;
            setOpen(false);
          }}
        >
          {children}
        </Menu>
      )}
    </>
  );
}
