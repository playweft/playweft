import { useI18n } from "@/app/i18n";

export default function GameLoading({ name, icon }: { name: string; icon?: string }) {
  const { t } = useI18n();
  return (
    <div className="solo-loading" role="status" aria-label={t("loadingGame")}>
      <div className="solo-loading-game">
        {icon ? (
          <img className="solo-loading-icon" src={icon} alt="" referrerPolicy="no-referrer" />
        ) : (
          <span className="solo-loading-icon solo-loading-icon-fallback">
            {name.slice(0, 2).toUpperCase()}
          </span>
        )}
        <strong>{name}</strong>
      </div>
      <div className="solo-loading-progress">
        <span className="loading-spinner" aria-hidden="true" />
      </div>
    </div>
  );
}
