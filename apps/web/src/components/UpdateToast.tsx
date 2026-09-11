import { useEffect, useState } from "react";
import { RefreshCw, X } from "lucide-react";
import { useI18n } from "@/app/i18n";

interface UpdateToastProps {
  updating: boolean;
  onRefresh(): void;
  onDismiss(): void;
}

export default function UpdateToast({
  updating,
  onRefresh,
  onDismiss,
}: UpdateToastProps) {
  const { t } = useI18n();
  const [closing, setClosing] = useState(false);

  useEffect(() => {
    if (!closing) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      onDismiss();
      return;
    }
    const timeout = window.setTimeout(onDismiss, 180);
    return () => window.clearTimeout(timeout);
  }, [closing, onDismiss]);

  return (
    <aside
      className={`update-toast ${closing ? "update-toast-closing" : ""}`}
      role="status"
      aria-live="polite"
    >
      <p>{t("updateAvailable")}</p>
      <div className="update-toast-actions">
        <button
          type="button"
          aria-label={t("refreshToUpdate")}
          title={t("refreshToUpdate")}
          disabled={updating}
          onClick={onRefresh}
        >
          <RefreshCw
            className={updating ? "update-toast-refreshing" : undefined}
            aria-hidden="true"
          />
        </button>
        <button
          type="button"
          aria-label={t("dismissUpdate")}
          title={t("dismissUpdate")}
          disabled={updating}
          onClick={() => setClosing(true)}
        >
          <X aria-hidden="true" />
        </button>
      </div>
    </aside>
  );
}
