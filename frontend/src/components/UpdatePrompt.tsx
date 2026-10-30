import { useRegisterSW } from "virtual:pwa-register/react";

/** The app never reloads itself mid-consultation; the user chooses when to update. */
export function UpdatePrompt() {
  const {
    offlineReady: [offlineReady, setOfflineReady],
    needRefresh: [needRefresh, setNeedRefresh],
    updateServiceWorker,
  } = useRegisterSW();

  if (!offlineReady && !needRefresh) return null;
  return (
    <div className="toast" role="status">
      {needRefresh ? (
        <>
          <span>A new version is available. Your saved work is kept.</span>
          <button onClick={() => void updateServiceWorker(true)}>Update</button>
          <button className="link" onClick={() => setNeedRefresh(false)}>
            Later
          </button>
        </>
      ) : (
        <>
          <span>Ready to work offline.</span>
          <button className="link" onClick={() => setOfflineReady(false)}>
            OK
          </button>
        </>
      )}
    </div>
  );
}
