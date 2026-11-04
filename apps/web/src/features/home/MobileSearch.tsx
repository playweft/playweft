import { useEffect, useImperativeHandle, useRef, useState, type ReactNode, type Ref } from "react";
import { ChevronLeft, Search } from "lucide-react";
import { useI18n } from "@/app/i18n";

export interface SearchDialogHandle {
  open(source?: HTMLElement): void;
  close(): void;
}

interface MobileSearchProps {
  ref?: Ref<SearchDialogHandle>;
  children?: ReactNode;
  value: string;
  onChange(value: string): void;
  onSubmit(): boolean;
}

export default function MobileSearch({ ref, children, value, onChange, onSubmit }: MobileSearchProps) {
  const { t } = useI18n();
  const dialog = useRef<HTMLDialogElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const fieldSlot = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const closeTimer = useRef<number | undefined>(undefined);
  const [closing, setClosing] = useState(false);
  const [expandedPlaceholder, setExpandedPlaceholder] = useState(false);
  const finishClose = () => {
    window.clearTimeout(closeTimer.current);
    closeTimer.current = undefined;
    dialog.current?.close();
    setClosing(false);
    setExpandedPlaceholder(false);
  };
  const close = () => {
    if (!dialog.current?.open || closeTimer.current !== undefined) return;
    setExpandedPlaceholder(false);
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      finishClose();
      return;
    }
    setClosing(true);
    closeTimer.current = window.setTimeout(finishClose, 200);
  };

  useEffect(() => {
    const motion = window.matchMedia("(prefers-reduced-motion: reduce)");
    const finishPlaceholder = () => {
      if (motion.matches && dialog.current?.open && closeTimer.current === undefined) setExpandedPlaceholder(true);
    };
    motion.addEventListener("change", finishPlaceholder);
    return () => {
      motion.removeEventListener("change", finishPlaceholder);
      window.clearTimeout(closeTimer.current);
    };
  }, []);

  const open = (from?: HTMLElement) => {
    const element = dialog.current;
    const source = from ?? trigger.current;
    if (!element || !source || !fieldSlot.current || element.open) return;
    const bounds = source.getBoundingClientRect();
    element.style.setProperty("--search-from-width", `${bounds.width}px`);
    setExpandedPlaceholder(window.matchMedia("(prefers-reduced-motion: reduce)").matches);
    element.showModal();
    element.style.setProperty("--search-from-x", `${bounds.left - fieldSlot.current.getBoundingClientRect().left}px`);
    // Keep focus synchronous with the tap so Safari can open its keyboard.
    input.current?.focus({ preventScroll: true });
  };

  useImperativeHandle(ref, () => ({ open, close: finishClose }));

  return (
    <>
      <button ref={trigger} type="button" className="mobile-search-trigger"
        aria-label={t("openGameOrRoom")} aria-haspopup="dialog" onClick={() => open()}>
        <Search size={18} aria-hidden="true" />
        <span>{t("search")}</span>
      </button>
      <dialog ref={dialog} className={`mobile-search-dialog${closing ? " mobile-search-dialog-closing" : ""}`} aria-label={t("openGameOrRoom")}
        onCancel={event => { event.preventDefault(); close(); }}
        onKeyDownCapture={event => {
          if (event.key === "Escape") { event.preventDefault(); close(); }
        }}
        onClick={event => { if (event.target === event.currentTarget) close(); }}>
        <div className="mobile-search-background mobile-search-fade" aria-hidden="true" />
        <header className="mobile-search-header">
          <form className="launch-form mobile-search-form" onSubmit={event => {
            event.preventDefault();
            if (onSubmit()) finishClose();
          }}>
            <button className="mobile-search-close mobile-search-fade" type="button"
              aria-label={t("back")} onClick={close}>
              <ChevronLeft size={24} aria-hidden="true" />
            </button>
            <label className="sr-only" htmlFor="mobile-game-url">{t("gameUrlOrRoomCode")}</label>
            <div ref={fieldSlot} className="mobile-search-slot">
              <div className="url-input mobile-search-field" onAnimationEnd={event => {
                if (event.target === event.currentTarget && event.animationName === "mobile-search-expand" && !closing)
                  setExpandedPlaceholder(true);
              }}>
                <input ref={input} id="mobile-game-url" type="search" required autoComplete="off" enterKeyHint="go"
                  placeholder={t(expandedPlaceholder ? "gameLinkOrRoomCode" : "search")} value={value}
                  onChange={event => onChange(event.target.value)} />
                <button className="launch-submit" type="submit" disabled={!value.trim()} aria-label={t("openGameOrRoom")}>
                  <Search size={20} aria-hidden="true" />
                </button>
              </div>
            </div>
          </form>
        </header>
        <div className="mobile-search-content mobile-search-fade">{children}</div>
      </dialog>
    </>
  );
}
