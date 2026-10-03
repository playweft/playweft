import Dialog from "@/components/Dialog";
import { useI18n } from "@/app/i18n";
import InviteDialog from "./InviteDialog";
import ChangeGameDialog from "./ChangeGameDialog";
import type { RoomControls } from "./useRoomControls";

export default function RoomDialogs({
  roomId,
  controls,
}: {
  roomId: string;
  controls: RoomControls;
}) {
  const { t } = useI18n();
  const {
    inviteDialogOpen,
    setInviteDialogOpen,
    setError,
    leaveDialogOpen,
    setLeaveDialogOpen,
    leave,
    dissolveDialogOpen,
    setDissolveDialogOpen,
    dissolve,
    changeGameOpen,
    setChangeGameOpen,
    changeGame,
  } = controls;
  return (
    <>
      {inviteDialogOpen && (
        <InviteDialog
          roomId={roomId}
          url={window.location.href}
          onRoomIdCopyError={() => setError(t("roomNumberCopyFailed"))}
          onClose={() => setInviteDialogOpen(false)}
        />
      )}
      {leaveDialogOpen && (
        <Dialog
          title={t("leaveRoom")}
          onDismiss={() => setLeaveDialogOpen(false)}
          actions={[
            { label: t("cancel") },
            {
              label: t("leave"),
              variant: "danger",
              onSelect: () => void leave(),
            },
          ]}
        >
          <p className="leave-dialog-copy">{t("needRoomLinkToReturn")}</p>
        </Dialog>
      )}
      {dissolveDialogOpen && (
        <Dialog
          title={t("dissolveRoom")}
          onDismiss={() => setDissolveDialogOpen(false)}
          actions={[
            { label: t("cancel") },
            {
              label: t("dissolveRoomAction"),
              variant: "danger",
              onSelect: () => void dissolve(),
            },
          ]}
        >
          <p className="leave-dialog-copy">{t("dissolveRoomDescription")}</p>
        </Dialog>
      )}
      {changeGameOpen && (
        <ChangeGameDialog
          onClose={() => setChangeGameOpen(false)}
          onSubmit={(url) => void changeGame(url)}
        />
      )}
    </>
  );
}
