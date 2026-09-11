import { useCallback, useEffect, useRef, useState } from "react";
import { registerSW } from "virtual:pwa-register";
import {
  enforceAppLoadPolicy,
  readAppLoadPolicy,
  subscribeToAppLoadPolicy,
  type AppLoadPolicy,
} from "@/app/app-load-policy";

const UPDATE_CHECK_INTERVAL_MS = 30 * 60 * 1_000;

export function usePwaUpdate() {
  const [loadPolicy, setLoadPolicy] =
    useState<AppLoadPolicy>(readAppLoadPolicy);
  const [registration, setRegistration] = useState<ServiceWorkerRegistration>();
  const [updating, setUpdating] = useState(false);
  const lastUpdateCheck = useRef(0);
  const reloadRequested = useRef(false);
  const [updateAvailable, setUpdateAvailable] = useState(false);
  const updateServiceWorker = useRef<(() => Promise<void>) | undefined>(
    undefined,
  );
  const registrationGeneration = useRef(0);
  const cleanupPromise = useRef<Promise<void>>(Promise.resolve());
  const shouldRegisterServiceWorker = loadPolicy !== "cache-disabled";

  useEffect(
    () => subscribeToAppLoadPolicy(() => setLoadPolicy(readAppLoadPolicy)),
    [],
  );

  useEffect(() => {
    const generation = ++registrationGeneration.current;
    if (!shouldRegisterServiceWorker) {
      updateServiceWorker.current = undefined;
      setRegistration(undefined);
      setUpdateAvailable(false);
      cleanupPromise.current = enforceAppLoadPolicy(loadPolicy);
      return;
    }

    void cleanupPromise.current.then(() => {
      if (generation !== registrationGeneration.current) return;
      updateServiceWorker.current = registerSW({
        immediate: true,
        onNeedReload() {
          if (reloadRequested.current) window.location.reload();
        },
        onNeedRefresh() {
          if (generation === registrationGeneration.current) {
            setUpdateAvailable(true);
          }
        },
        onRegisteredSW(_scriptUrl, nextRegistration) {
          if (generation === registrationGeneration.current) {
            setRegistration(nextRegistration);
            // The policy may have been selected immediately before this
            // registration existed, so persist and deliver it again now.
            void enforceAppLoadPolicy(readAppLoadPolicy());
          }
        },
        onRegisterError(error) {
          console.error(
            "Could not register the Playweft service worker",
            error,
          );
        },
      });
    });
  }, [shouldRegisterServiceWorker]);

  useEffect(() => {
    if (loadPolicy !== "update-prompt") setUpdateAvailable(false);
  }, [loadPolicy]);

  const checkForUpdate = useCallback(
    (force = false) => {
      if (
        loadPolicy !== "update-prompt" ||
        !registration ||
        !navigator.onLine
      ) {
        return;
      }
      const now = Date.now();
      if (!force && now - lastUpdateCheck.current < UPDATE_CHECK_INTERVAL_MS)
        return;
      lastUpdateCheck.current = now;
      void registration.update().catch(() => {
        // Keep the cached version running when the update check cannot connect.
      });
    },
    [loadPolicy, registration],
  );

  useEffect(() => {
    if (!registration) return;
    const checkWhenVisible = () => {
      if (document.visibilityState === "visible") checkForUpdate();
    };
    const checkWhenOnline = () => checkForUpdate(true);
    const interval = window.setInterval(
      checkForUpdate,
      UPDATE_CHECK_INTERVAL_MS,
    );
    document.addEventListener("visibilitychange", checkWhenVisible);
    window.addEventListener("online", checkWhenOnline);
    return () => {
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", checkWhenVisible);
      window.removeEventListener("online", checkWhenOnline);
    };
  }, [checkForUpdate, registration]);

  const applyUpdate = useCallback(async () => {
    if (updating) return;
    const update = updateServiceWorker.current;
    if (!update) return;
    reloadRequested.current = true;
    setUpdating(true);
    try {
      await update();
    } catch (error) {
      reloadRequested.current = false;
      setUpdating(false);
      console.error("Could not activate the Playweft update", error);
    }
  }, [updating]);

  const dismissUpdate = useCallback(() => {
    setUpdateAvailable(false);
  }, [setUpdateAvailable]);

  return {
    applyUpdate,
    dismissUpdate,
    loadPolicy,
    updateAvailable,
    updating,
  };
}
