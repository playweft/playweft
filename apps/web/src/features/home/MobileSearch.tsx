import { useEffect, useRef, useState } from "react";
import { ChevronLeft, Search } from "lucide-react";
import { useI18n } from "@/app/i18n";

interface MobileSearchProps {
  value: string;
  onChange(value: string): void;
  onSubmit(): void;
}

export default function MobileSearch({ value, onChange, onSubmit }: MobileSearchProps) {
  const { t } = useI18n();
  const dialog = useRef<HTMLDialogElement>(null);
  const input = useRef<HTMLInputElement>(null);
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
    const desktop = window.matchMedia("(min-width: 621px)");
    const motion = window.matchMedia("(prefers-reduced-motion: reduce)");
    const finishPlaceholder = () => {
      if (motion.matches && dialog.current?.open && closeTimer.current === undefined) setExpandedPlaceholder(true);
    };
    const closeOnDesktop = () => { if (desktop.matches) finishClose(); };
    desktop.addEventListener("change", closeOnDesktop);
    motion.addEventListener("change", finishPlaceholder);
    return () => {
      desktop.removeEventListener("change", closeOnDesktop);
      motion.removeEventListener("change", finishPlaceholder);
      window.clearTimeout(closeTimer.current);
    };
  }, []);

  const open = () => {
    const element = dialog.current;
    const source = trigger.current;
    if (!element || !source || element.open) return;
    const bounds = source.getBoundingClientRect();
    element.style.setProperty("--search-from-width", `${bounds.width}px`);
    element.style.setProperty("--search-from-x", `${bounds.left - 63}px`);
    setExpandedPlaceholder(window.matchMedia("(prefers-reduced-motion: reduce)").matches);
    element.showModal();
    // Keep focus synchronous with the tap so Safari can open its keyboard.
    input.current?.focus({ preventScroll: true });
  };

  return (
    <>
      <button ref={trigger} type="button" className="mobile-search-trigger"
        aria-label={t("openGameOrRoom")} aria-haspopup="dialog" onClick={open}>
        <Search size={18} aria-hidden="true" />
        <span>{t("search")}</span>
      </button>
      <dialog ref={dialog} className={`mobile-search-dialog${closing ? " mobile-search-dialog-closing" : ""}`} aria-label={t("openGameOrRoom")}
        onCancel={event => { event.preventDefault(); close(); }}
        onKeyDownCapture={event => {
          if (event.key === "Escape") { event.preventDefault(); close(); }
        }}
        onClick={event => { if (event.target === event.currentTarget) close(); }}>
        <div className="mobile-search-background" aria-hidden="true" />
        <header className="mobile-search-header">
          <form className="launch-form mobile-search-form" onSubmit={event => {
            event.preventDefault();
            finishClose();
            onSubmit();
          }}>
            <label className="sr-only" htmlFor="mobile-game-url">{t("gameUrlOrRoomCode")}</label>
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
            <button className="mobile-search-close" type="button"
              aria-label={t("back")} onClick={close}>
              <ChevronLeft size={24} aria-hidden="true" />
            </button>
          </form>
        </header>
      </dialog>
    </>
  );
}
