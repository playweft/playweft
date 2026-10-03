import { DoorClosed } from "lucide-react";
import { useI18n } from "@/app/i18n";
import type { RoomEntryFailure } from "./room-errors";

export function RoomEntryLoadingState() {
  const { t } = useI18n();
  return (
    <main className="room-entry-state">
      <div
        className="room-entry-state-content"
        role="status"
        aria-label={t("loadingGame")}
      >
        <span className="loading-spinner" aria-hidden="true" />
      </div>
    </main>
  );
}

export function RoomEntryFailureState({
  failure,
  onBack,
}: {
  failure: RoomEntryFailure;
  onBack(): void;
}) {
  const { t } = useI18n();
  return (
    <main className="room-entry-state">
      <div className="room-entry-state-content">
        <span className="room-entry-state-icon" aria-hidden="true">
          <DoorClosed />
        </span>
        <h1>
          {t(failure === "not-found" ? "roomNotFound" : "roomUnavailable")}
        </h1>
        <button className="primary" type="button" onClick={onBack}>
          {t("backHome")}
        </button>
      </div>
    </main>
  );
}
