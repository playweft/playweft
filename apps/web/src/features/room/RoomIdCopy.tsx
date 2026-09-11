import { useEffect, useRef, useState } from "react";
import { Check, Copy } from "lucide-react";
import { useI18n } from "@/app/i18n";

interface RoomIdCopyProps {
  roomId: string;
  onCopyError(): void;
}

export default function RoomIdCopy({
  roomId,
  onCopyError,
}: RoomIdCopyProps) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);
  const copiedTimer = useRef<number | undefined>(undefined);

  useEffect(
    () => () => window.clearTimeout(copiedTimer.current),
    [],
  );

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(roomId);
      setCopied(true);
      window.clearTimeout(copiedTimer.current);
      copiedTimer.current = window.setTimeout(() => setCopied(false), 1_500);
    } catch {
      onCopyError();
    }
  };

  const copyLabel = copied ? t("roomNumberCopied") : t("copyRoomNumber");

  return (
    <div className="room-id-copy">
      <span>{t("roomNumber", { roomId })}</span>
      <button
        className={`room-id-action ${copied ? "room-id-copy-copied" : ""}`}
        type="button"
        aria-label={copyLabel}
        title={copyLabel}
        onClick={() => void copy()}
      >
        {copied ? (
          <Check aria-hidden="true" />
        ) : (
          <Copy aria-hidden="true" />
        )}
      </button>
    </div>
  );
}
