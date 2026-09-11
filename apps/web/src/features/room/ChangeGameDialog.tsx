import { useState } from "react";
import Dialog from "@/components/Dialog";
import { useFeaturedGames, type FeaturedGame } from "@/features/game/featured-games";
import type { DiscoveredGame as RecentGame } from "@/features/game/game-manifest";
import { localizeGameName, useI18n } from "@/app/i18n";
import { readRecentGames } from "@/features/game/recent-games";

interface ChangeGameDialogProps {
  onClose(): void;
  onSubmit(url: string): void;
}

export default function ChangeGameDialog({
  onClose,
  onSubmit,
}: ChangeGameDialogProps) {
  const { locale, t } = useI18n();
  const [url, setUrl] = useState("");
  const recentGames = readRecentGames();
  const featuredGames = useFeaturedGames();

  return (
    <Dialog
      title={t("changeGame")}
      size="wide"
      onDismiss={onClose}
      actions={[
        { label: t("cancel") },
        {
          label: t("changeGame"),
          variant: "primary",
          onSelect: () => onSubmit(url),
        },
      ]}
    >
      <form
        className="change-game-form"
        onSubmit={(event) => {
          event.preventDefault();
          onSubmit(url);
        }}
      >
        <label htmlFor="change-game-url">{t("gameUrl")}</label>
        <div className="change-game-url-input">
          <input
            id="change-game-url"
            type="url"
            required
            autoFocus
            autoComplete="off"
            placeholder={t("pasteStaticGameUrl")}
            value={url}
            onChange={(event) => setUrl(event.target.value)}
          />
        </div>
      </form>
      {recentGames.length > 0 && (
        <GameChoices
          title={t("recentlyPlayed")}
          games={recentGames}
          selectedUrl={url}
          onSelect={setUrl}
        />
      )}
      <GameChoices
        title={t("recommended")}
        games={featuredGames}
        selectedUrl={url}
        onSelect={setUrl}
      />
    </Dialog>
  );
}

function GameChoices({
  title,
  games,
  selectedUrl,
  onSelect,
}: {
  title: string;
  games: Array<RecentGame | FeaturedGame>;
  selectedUrl: string;
  onSelect(url: string): void;
}) {
  const { locale } = useI18n();
  return (
    <section
      className="change-game-choices"
      aria-labelledby={`change-${title.toLowerCase().replaceAll(" ", "-")}`}
    >
      <h3 id={`change-${title.toLowerCase().replaceAll(" ", "-")}`}>{title}</h3>
      <div className="change-game-list">
        {games.map((game) => (
          <button
            key={game.manifestUrl}
            className={`shelf-game ${game.manifestUrl === selectedUrl ? "change-game-choice-selected" : ""}`}
            type="button"
            aria-pressed={game.manifestUrl === selectedUrl}
            onClick={() => onSelect(game.manifestUrl)}
          >
            <span className="shelf-art">
              {game.icon ? (
                <img src={game.icon} alt="" referrerPolicy="no-referrer" />
              ) : (
                <span>
                  {localizeGameName(game, locale).slice(0, 2).toUpperCase()}
                </span>
              )}
            </span>
            <span className="shelf-game-name">
              {localizeGameName(game, locale)}
            </span>
          </button>
        ))}
      </div>
    </section>
  );
}
