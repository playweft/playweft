import { useI18n } from "@/app/i18n";

interface EntryOverlayProps {
  status: string;
  onCancel?(): void;
}

export default function EntryOverlay({
  status,
  onCancel,
}: EntryOverlayProps) {
  const { t } = useI18n();
  return (
    <div className="creating-overlay">
      <div className="creating-status" role="status" aria-live="polite">
        <span className="loading-spinner" aria-hidden="true" />
        <span>{status}</span>
      </div>
      {onCancel && (
        <button className="creating-cancel" type="button" onClick={onCancel}>
          {t("cancel")}
        </button>
      )}
    </div>
  );
}
