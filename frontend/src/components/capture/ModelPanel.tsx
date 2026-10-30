import { useLiveQuery } from "dexie-react-hooks";
import { useEffect, useState } from "react";
import { aiReadiness, downloadOcrLanguages, downloadSpeechModel, setSpeechModel } from "../../ai";
import { deviceProfile, type DeviceProfile } from "../../ai/device";
import { SPEECH_MODELS } from "../../ai/models";
import { useApp } from "../../app/AppContext";
import { useConnectivity } from "../../app/hooks";

/** Lets the health worker fetch AI models while they still have a connection. */
export function ModelPanel({ model, ocrLangs }: { model: string; ocrLangs: string }) {
  const { db } = useApp();
  const connectivity = useConnectivity();
  const ready = useLiveQuery(() => aiReadiness(db), [db]);
  const [device, setDevice] = useState<DeviceProfile | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void deviceProfile().then(setDevice);
  }, []);

  const speechReady = ready?.speech.includes(model) ?? false;
  const ocrReady = ready?.ocr.includes(ocrLangs) ?? false;

  async function run(label: string, fn: () => Promise<void>) {
    setBusy(label);
    setError(null);
    setProgress(null);
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
      setProgress(null);
    }
  }

  return (
    <details className="card model-panel" open={!speechReady || !ocrReady}>
      <summary>
        Offline AI models{" "}
        <span className={`chip ${speechReady && ocrReady ? "chip-synced" : "chip-pending"}`}>
          {speechReady && ocrReady ? "Ready offline" : "Download needed"}
        </span>
      </summary>
      {device && (
        <p className="muted small">
          This device: {device.webgpu ? "GPU acceleration (WebGPU)" : "CPU only (WASM)"}
          {device.memoryGb ? ` · ~${device.memoryGb} GB RAM` : ""} · {device.cores} cores
          {device.lowEnd ? " · low-end: Whisper Base or Tiny recommended" : ""}
        </p>
      )}
      <div className="model-row">
        <label>
          Speech model
          <select value={model} onChange={(e) => void setSpeechModel(db, e.target.value)} disabled={!!busy}>
            {SPEECH_MODELS.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label} (~{m.sizeMb} MB){ready?.speech.includes(m.id) ? " ✓" : ""}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          disabled={!!busy || connectivity === "offline"}
          onClick={() => void run("speech", () => downloadSpeechModel(db, model, setProgress))}
        >
          {speechReady ? "Re-check" : "Download"}
        </button>
      </div>
      <p className="muted small">{SPEECH_MODELS.find((m) => m.id === model)?.note}</p>
      <div className="model-row">
        <span>
          Document reading (OCR): <strong>{ocrLangs}</strong> {ocrReady ? "✓" : ""}
        </span>
        <button
          type="button"
          disabled={!!busy || connectivity === "offline"}
          onClick={() => void run("ocr", () => downloadOcrLanguages(db, ocrLangs))}
        >
          {ocrReady ? "Re-check" : "Download"}
        </button>
      </div>
      {busy && (
        <div className="processing">
          <span className="spinner" />
          Downloading {busy === "speech" ? "speech model" : "OCR language data"}…
          {progress != null && <progress max={1} value={progress} />}
        </div>
      )}
      {error && <p className="error">{error}</p>}
      {connectivity === "offline" && !(speechReady && ocrReady) && (
        <p className="muted small">Connect to the internet once to download the models.</p>
      )}
    </details>
  );
}
