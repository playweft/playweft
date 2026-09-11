import Dialog from "@/components/Dialog";
import { useI18n } from "@/app/i18n";

interface GameHelpDialogProps {
  name: string;
  url: string;
  onClose(): void;
}

export default function GameHelpDialog({
  name,
  url,
  onClose,
}: GameHelpDialogProps) {
  const { t } = useI18n();

  return (
    <Dialog
      title={t("gameHelp")}
      contentLayout="flush"
      fullscreen
      onDismiss={onClose}
    >
      <iframe
        className="game-help-frame"
        title={t("gameHelpTitle", { name })}
        src={url}
      />
    </Dialog>
  );
}
