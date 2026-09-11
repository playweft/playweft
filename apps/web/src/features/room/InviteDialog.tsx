import { useEffect, useState } from "react";
import QRCode from "qrcode";
import Dialog from "@/components/Dialog";
import { useI18n } from "@/app/i18n";
import RoomIdCopy from "@/features/room/RoomIdCopy";

interface InviteDialogProps {
  roomId: string;
  url: string;
  onRoomIdCopyError(): void;
  onClose(): void;
}

export default function InviteDialog({
  roomId,
  url,
  onRoomIdCopyError,
  onClose,
}: InviteDialogProps) {
  const { t } = useI18n();
  const [qrCode, setQrCode] = useState<string>();

  useEffect(() => {
    let cancelled = false;
    void QRCode.toDataURL(url, {
      width: 256,
      margin: 1,
      color: { dark: "#202124", light: "#ffffff" },
    }).then((value) => {
      if (!cancelled) setQrCode(value);
    });
    return () => {
      cancelled = true;
    };
  }, [url]);

  return (
    <Dialog title={t("invitePlayers")} onDismiss={onClose}>
      <div className="invite-dialog-content">
        {qrCode ? (
          <img
            src={qrCode}
            alt={t("qrCodeForRoomLink")}
            width={192}
            height={192}
          />
        ) : (
          <span
            className="invite-dialog-loading"
            aria-label={t("generatingQrCode")}
          />
        )}
        <div className="room-id invite-dialog-room-id">
          <RoomIdCopy roomId={roomId} onCopyError={onRoomIdCopyError} />
        </div>
      </div>
    </Dialog>
  );
}
