import { useI18n } from "@/app/i18n";

export interface GamePermissionPromptState {
  gameName: string;
  origin: string;
}

export default function GamePermissionPrompt({
  prompt,
  title,
  remembered,
  onAllow,
  onDeny,
}: {
  prompt?: GamePermissionPromptState;
  title: string;
  remembered: string;
  onAllow(): void;
  onDeny(): void;
}) {
  const { t } = useI18n();
  if (!prompt) return null;
  return (
    <section
      className="permission-prompt"
      role="alertdialog"
      aria-labelledby="game-permission-prompt-title"
    >
      <div>
        <strong id="game-permission-prompt-title">{title}</strong>
        <span>{prompt.origin}</span>
        <small>{remembered}</small>
      </div>
      <div className="permission-prompt-actions">
        <button type="button" autoFocus onClick={onDeny}>
          {t("deny")}
        </button>
        <button className="primary" type="button" onClick={onAllow}>
          {t("allowOnce")}
        </button>
      </div>
    </section>
  );
}
