import { useEffect, useRef, useState } from "react";
import { MAX_RECORDING_SECONDS, Recorder } from "../../ai/audio";

function mmss(s: number) {
  return `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
}

export function VoiceRecorder({ onRecorded }: { onRecorded: (blob: Blob, durationS: number | null) => void }) {
  const recorder = useRef<Recorder | null>(null);
  const [recording, setRecording] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [level, setLevel] = useState(0);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!recording) return;
    const t = setInterval(() => {
      const r = recorder.current;
      if (!r) return;
      setElapsed(r.elapsedSeconds());
      setLevel(r.level());
      if (r.elapsedSeconds() >= MAX_RECORDING_SECONDS) void stop();
    }, 150);
    return () => clearInterval(t);
  }, [recording]);

  useEffect(() => () => recorder.current?.cancel(), []);

  async function start() {
    setError(null);
    if (!navigator.mediaDevices?.getUserMedia) {
      setError("This browser cannot record audio here (a secure HTTPS connection is required).");
      return;
    }
    try {
      recorder.current = new Recorder();
      await recorder.current.start();
      setElapsed(0);
      setRecording(true);
    } catch (e) {
      recorder.current = null;
      setError(
        e instanceof DOMException && e.name === "NotAllowedError"
          ? "Microphone permission was denied. Allow it in the browser settings."
          : "Could not start the microphone.",
      );
    }
  }

  async function stop() {
    const r = recorder.current;
    if (!r?.recording) return;
    setRecording(false);
    const { blob, durationS } = await r.stop();
    recorder.current = null;
    onRecorded(blob, durationS);
  }

  return (
    <div className="recorder">
      {recording ? (
        <button key="stop" type="button" className="record-btn recording" onClick={() => void stop()}>
          <span className="rec-dot" /> Stop · {mmss(elapsed)}
        </button>
      ) : (
        <button key="start" type="button" className="record-btn" onClick={() => void start()}>
          🎙 Record voice note
        </button>
      )}
      {recording && (
        <div className="level" aria-hidden>
          <div style={{ width: `${Math.round(level * 100)}%` }} />
        </div>
      )}
      <label className="file-btn">
        Upload audio file
        <input
          type="file"
          accept="audio/*"
          hidden
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) onRecorded(file, null);
            e.target.value = "";
          }}
        />
      </label>
      {error && <p className="error">{error}</p>}
    </div>
  );
}
