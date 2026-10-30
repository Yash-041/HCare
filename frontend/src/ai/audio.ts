/** Microphone recording and conversion to the 16 kHz mono Float32 PCM that Whisper expects. */

export const WHISPER_SAMPLE_RATE = 16_000;
export const MAX_RECORDING_SECONDS = 5 * 60;

function pickMimeType(): string | undefined {
  const candidates = ["audio/webm;codecs=opus", "audio/ogg;codecs=opus", "audio/mp4", "audio/webm"];
  return candidates.find((t) => typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(t));
}

export class Recorder {
  private recorder: MediaRecorder | null = null;
  private stream: MediaStream | null = null;
  private chunks: Blob[] = [];
  private analyser: AnalyserNode | null = null;
  private audioCtx: AudioContext | null = null;
  private startedAt = 0;

  get recording(): boolean {
    return this.recorder?.state === "recording";
  }

  elapsedSeconds(): number {
    return this.recording ? (performance.now() - this.startedAt) / 1000 : 0;
  }

  async start(): Promise<void> {
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    const mimeType = pickMimeType();
    this.recorder = new MediaRecorder(this.stream, mimeType ? { mimeType, audioBitsPerSecond: 32_000 } : undefined);
    this.chunks = [];
    this.recorder.ondataavailable = (e) => {
      if (e.data.size > 0) this.chunks.push(e.data);
    };
    // Timeslice: if the tab is killed mid-recording, earlier chunks were already delivered.
    this.recorder.start(1000);
    this.startedAt = performance.now();

    this.audioCtx = new AudioContext();
    this.analyser = this.audioCtx.createAnalyser();
    this.analyser.fftSize = 512;
    this.audioCtx.createMediaStreamSource(this.stream).connect(this.analyser);
  }

  /** 0..1 input level for a simple meter. */
  level(): number {
    if (!this.analyser) return 0;
    const buf = new Uint8Array(this.analyser.fftSize);
    this.analyser.getByteTimeDomainData(buf);
    let peak = 0;
    for (const v of buf) peak = Math.max(peak, Math.abs(v - 128));
    return Math.min(1, peak / 100);
  }

  stop(): Promise<{ blob: Blob; durationS: number }> {
    const recorder = this.recorder;
    if (!recorder) return Promise.reject(new Error("not recording"));
    const durationS = this.elapsedSeconds();
    return new Promise((resolve) => {
      recorder.onstop = () => {
        const blob = new Blob(this.chunks, { type: recorder.mimeType || "audio/webm" });
        this.release();
        resolve({ blob, durationS });
      };
      recorder.stop();
    });
  }

  cancel() {
    if (this.recorder && this.recorder.state !== "inactive") this.recorder.stop();
    this.release();
  }

  private release() {
    this.stream?.getTracks().forEach((t) => t.stop());
    void this.audioCtx?.close();
    this.stream = null;
    this.recorder = null;
    this.analyser = null;
    this.audioCtx = null;
  }
}

/**
 * Decode any browser-supported audio (webm/opus, mp4, wav, mp3...) to 16 kHz mono.
 * decodeAudioData resamples to the context's rate, so an OfflineAudioContext at 16 kHz
 * does the resampling for us.
 */
export async function decodeTo16kMono(blob: Blob): Promise<{ samples: Float32Array; durationS: number }> {
  const ctx = new OfflineAudioContext(1, 1, WHISPER_SAMPLE_RATE);
  const buffer = await ctx.decodeAudioData(await blob.arrayBuffer());
  const samples = new Float32Array(buffer.length);
  for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
    const data = buffer.getChannelData(ch);
    for (let i = 0; i < data.length; i++) samples[i] += data[i] / buffer.numberOfChannels;
  }
  return { samples, durationS: buffer.duration };
}
