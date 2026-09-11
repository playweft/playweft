import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { X } from "lucide-react";
import { useI18n } from "@/app/i18n";

export interface DialogAction {
  label: string;
  variant?: "primary" | "danger";
  onSelect?(): void;
}

interface DialogProps {
  title: string;
  children: ReactNode;
  onDismiss(): void;
  actions?: DialogAction[];
  contentLayout?: "padded" | "flush";
  size?: "default" | "wide" | "large";
  fullscreen?: boolean;
}

export default function Dialog({
  title,
  children,
  onDismiss,
  actions,
  contentLayout = "padded",
  size = "default",
  fullscreen = false,
}: DialogProps) {
  const { t } = useI18n();
  const [closing, setClosing] = useState(false);
  const afterClose = useRef<(() => void) | undefined>(undefined);
  const dialog = useRef<HTMLDialogElement>(null);

  const close = (after?: () => void) => {
    afterClose.current = after;
    setClosing(true);
  };

  useLayoutEffect(() => {
    const element = dialog.current;
    if (!element) return;
    element.showModal();
    return () => element.close();
  }, []);

  useEffect(() => {
    if (!closing) return;
    const finish = () => {
      onDismiss();
      afterClose.current?.();
    };
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      finish();
      return;
    }
    const timeout = window.setTimeout(finish, 180);
    return () => window.clearTimeout(timeout);
  }, [closing, onDismiss]);

  return (
    <dialog
      ref={dialog}
      className={`dialog-layer${fullscreen ? " dialog-layer-fullscreen" : ""} ${closing ? "dialog-closing" : ""}`}
      aria-labelledby="dialog-title"
      onCancel={(event) => {
        event.preventDefault();
        close();
      }}
    >
      <button
        className="dialog-backdrop"
        type="button"
        tabIndex={-1}
        aria-label={t("closeDialog", { title })}
        onClick={() => close()}
      />
      <section className={`dialog dialog-${size}${fullscreen ? " dialog-fullscreen" : ""}`}>
        <header className="dialog-header">
          <h2 id="dialog-title">{title}</h2>
          <button
            type="button"
            onClick={() => close()}
            aria-label={t("closeDialog", { title })}
          >
            <X aria-hidden="true" />
          </button>
        </header>
        <div className={`dialog-content dialog-content-${contentLayout}`}>
          {children}
        </div>
        {actions && (
          <footer className="dialog-actions">
            {actions.map((action) => (
              <button
                key={action.label}
                className={`dialog-action${action.variant ? ` dialog-action-${action.variant}` : ""}`}
                type="button"
                onClick={() => close(action.onSelect)}
              >
                {action.label}
              </button>
            ))}
          </footer>
        )}
      </section>
    </dialog>
  );
}
