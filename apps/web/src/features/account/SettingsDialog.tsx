import { ArrowLeft } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  applyAppLoadPolicy,
  readAppLoadPolicy,
  type AppLoadPolicy,
} from "@/app/app-load-policy";
import {
  beginCloudflareOAuth,
  getCloudflareAccounts,
  getCloudflareStatus,
  selectCloudflareAccount,
  type CloudflareAccountsResponse,
  type CloudflareStatus,
} from "@/platform/platform-api";
import ErrorToast from "@/components/ErrorToast";
import { useI18n } from "@/app/i18n";

export default function SettingsDialog({ onBack }: { onBack(): void }) {
  const { t } = useI18n();
  const dialog = useRef<HTMLDialogElement>(null);
  const [closing, setClosing] = useState(false);
  const [loadPolicy, setLoadPolicy] = useState(readAppLoadPolicy);
  const [applyingPolicy, setApplyingPolicy] = useState(false);
  const [cloudflareStatus, setCloudflareStatus] = useState<
    CloudflareStatus | undefined
  >();
  const [cloudflareOAuthFailed, setCloudflareOAuthFailed] = useState(
    cloudflareOAuthFailureFromLocation,
  );
  const [cloudflareOAuthStarting, setCloudflareOAuthStarting] =
    useState(false);
  const [cloudflareAccounts, setCloudflareAccounts] = useState<
    CloudflareAccountsResponse | undefined
  >();
  const [updatingCloudflareAccount, setUpdatingCloudflareAccount] =
    useState(false);
  const finished = useRef(false);

  const finish = () => {
    if (finished.current) return;
    finished.current = true;
    onBack();
  };

  const close = () => {
    if (closing) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      finish();
      return;
    }
    setClosing(true);
  };

  useLayoutEffect(() => {
    const element = dialog.current;
    if (!element) return;
    element.showModal();
    return () => element.close();
  }, []);

  useEffect(() => {
    let cancelled = false;
    void getCloudflareStatus()
      .then((status) => {
        if (!cancelled) setCloudflareStatus(status);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!cloudflareStatus?.connected || cloudflareStatus.needsReconnect) {
      setCloudflareAccounts(undefined);
      return;
    }
    let cancelled = false;
    void getCloudflareAccounts()
      .then((accounts) => {
        if (!cancelled) setCloudflareAccounts(accounts);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [cloudflareStatus?.connected, cloudflareStatus?.needsReconnect]);

  useEffect(() => {
    if (!cloudflareOAuthFailed) return;
    const url = new URL(window.location.href);
    if (url.searchParams.get("cloudflare") !== "failed") return;
    url.searchParams.delete("cloudflare");
    window.history.replaceState(
      window.history.state,
      "",
      `${url.pathname}${url.search}${url.hash}`,
    );
  }, [cloudflareOAuthFailed]);

  const updateLoadPolicy = (nextPolicy: AppLoadPolicy) => {
    if (nextPolicy === loadPolicy || applyingPolicy) return;
    setLoadPolicy(nextPolicy);
    setApplyingPolicy(true);
    void applyAppLoadPolicy(nextPolicy).finally(() => setApplyingPolicy(false));
  };

  const connectCloudflare = () => {
    if (cloudflareOAuthStarting) return;
    setCloudflareOAuthStarting(true);
    void beginCloudflareOAuth().catch(() => {
      setCloudflareOAuthStarting(false);
      setCloudflareOAuthFailed(true);
    });
  };

  const updateCloudflareAccount = (accountId: string) => {
    if (updatingCloudflareAccount || !cloudflareAccounts) return;
    const previousAccountId = cloudflareAccounts.accountId;
    setCloudflareAccounts({ ...cloudflareAccounts, accountId });
    setUpdatingCloudflareAccount(true);
    void selectCloudflareAccount(accountId)
      .catch(() => {
        setCloudflareAccounts((current) =>
          current ? { ...current, accountId: previousAccountId } : current,
        );
      })
      .finally(() => setUpdatingCloudflareAccount(false));
  };

  return (
    <dialog
      ref={dialog}
      className={`settings-dialog-layer${closing ? " settings-dialog-closing" : ""}`}
      aria-labelledby="settings-dialog-title"
      onAnimationEnd={(event) => {
        if (
          !closing ||
          event.target !== event.currentTarget ||
          event.animationName !== "settings-dialog-out"
        ) {
          return;
        }
        finish();
      }}
      onCancel={(event) => {
        event.preventDefault();
        close();
      }}
    >
      <header className="settings-dialog-header">
        <button
          className="settings-dialog-back"
          type="button"
          aria-label={t("back")}
          autoFocus
          onClick={close}
        >
          <ArrowLeft aria-hidden="true" />
        </button>
        <h2 id="settings-dialog-title">{t("settings")}</h2>
      </header>
      <main className="settings-dialog-scroll">
        <div className="settings-dialog-content">
          <section className="settings-card" aria-label={t("appLoadingMode")}>
            <label className="settings-list-item">
              <span>{t("appLoadingMode")}</span>
              <select
                aria-label={t("appLoadingMode")}
                disabled={applyingPolicy}
                value={loadPolicy}
                onChange={(event) =>
                  updateLoadPolicy(event.target.value as AppLoadPolicy)
                }
              >
                <option value="cache-disabled">{t("cacheDisabled")}</option>
                <option value="network-first">{t("networkFirst")}</option>
                <option value="update-prompt">{t("updatePrompt")}</option>
                <option value="local-only">{t("localOnly")}</option>
              </select>
            </label>
          </section>
          {cloudflareStatus?.enabled && (
            <section
              className="settings-card"
              aria-label="Cloudflare"
            >
              {cloudflareStatus.connected ? (
                <>
                  <div className="settings-list-item">
                    <span>Cloudflare</span>
                    <span
                      className="settings-list-value"
                      title={
                        cloudflareStatus.displayName ??
                        cloudflareStatus.email
                      }
                    >
                      {cloudflareStatus.displayName ??
                        cloudflareStatus.email ??
                        t("cloudflareConnected")}
                    </span>
                  </div>
                  {cloudflareStatus.needsReconnect ? (
                    <button
                      className="settings-list-item settings-list-button"
                      type="button"
                      disabled={cloudflareOAuthStarting}
                      onClick={connectCloudflare}
                    >
                      {t("updateCloudflareAuthorization")}
                    </button>
                  ) : (
                    <>
                      {cloudflareAccounts &&
                        cloudflareAccounts.accounts.length > 0 && (
                          <label className="settings-list-item">
                            <span>{t("cloudflareAccount")}</span>
                            <select
                              aria-label={t("cloudflareAccount")}
                              disabled={updatingCloudflareAccount}
                              value={cloudflareAccounts.accountId ?? ""}
                              onChange={(event) =>
                                updateCloudflareAccount(event.target.value)
                              }
                            >
                              <option value="" disabled>
                                {t("selectCloudflareAccount")}
                              </option>
                              {cloudflareAccounts.accounts.map((account) => (
                                <option key={account.id} value={account.id}>
                                  {account.name}
                                </option>
                              ))}
                            </select>
                          </label>
                        )}
                      {!cloudflareStatus.scopes?.includes("ai.write") && (
                        <button
                          className="settings-list-item settings-list-button"
                          type="button"
                          disabled={cloudflareOAuthStarting}
                          onClick={connectCloudflare}
                        >
                          {t("authorizeWorkersAi")}
                        </button>
                      )}
                    </>
                  )}
                </>
              ) : (
                <button
                  className="settings-list-item settings-list-button"
                  type="button"
                  disabled={cloudflareOAuthStarting}
                  onClick={connectCloudflare}
                >
                  {t("connectCloudflare")}
                </button>
              )}
            </section>
          )}
        </div>
      </main>
      {cloudflareOAuthFailed && (
        <ErrorToast
          message={t("cloudflareOAuthFailed")}
          onDismiss={() => setCloudflareOAuthFailed(false)}
        />
      )}
    </dialog>
  );
}

function cloudflareOAuthFailureFromLocation(): boolean {
  return new URL(window.location.href).searchParams.get("cloudflare") === "failed";
}
