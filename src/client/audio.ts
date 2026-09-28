// Microphone in, tin can out. Everything here is the browser's own Web Audio / MediaRecorder.
import type { Voice } from "../../shared/protocol";

const MAX_CLIP_MS = 15_000;
const MIN_CLIP_MS = 500;
const SILENCE = 0.01; // RMS below this for a whole clip means nobody spoke

// Voice presets are applied on the listener's side. Changing the rate shifts pitch and pace
// together, like a toy; "wobbly" adds vibrato on top.
const VOICE_RATE: Record<Voice, number> = { low: 0.86, mid: 1, high: 1.16, wobbly: 1 };

/** Loudness (RMS) of whatever is flowing through an analyser right now, roughly 0–1. */
export function loudness(analyser: AnalyserNode): number {
  const samples = new Float32Array(analyser.fftSize);
  analyser.getFloatTimeDomainData(samples);
  return Math.sqrt(samples.reduce((sum, sample) => sum + sample * sample, 0) / samples.length);
}

export class Recorder {
  readonly level: AnalyserNode;
  private stream?: MediaStream;
  private recorder?: MediaRecorder;
  private clip?: Promise<Blob>;
  private startedAt = 0;
  private peak = 0;
  private timers: number[] = [];

  constructor(
    private readonly context: AudioContext,
    private readonly onLimitReached: () => void,
  ) {
    this.level = context.createAnalyser();
  }

  /** Throws if the microphone is unavailable or permission is denied. */
  async start() {
    if (!this.stream) {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true },
      });
      this.context.createMediaStreamSource(this.stream).connect(this.level);
    }
    const recorder = new MediaRecorder(this.stream);
    const chunks: Blob[] = [];
    recorder.ondataavailable = (event) => chunks.push(event.data);
    this.clip = new Promise((resolve) => {
      recorder.onstop = () => resolve(new Blob(chunks, { type: recorder.mimeType }));
    });
    recorder.start();
    this.recorder = recorder;
    this.startedAt = Date.now();
    this.peak = 0;
    this.timers = [
      window.setInterval(() => (this.peak = Math.max(this.peak, loudness(this.level))), 100),
      window.setTimeout(this.onLimitReached, MAX_CLIP_MS),
    ];
  }

  /** Base64 audio, or null when the clip was too short or silent (Whisper invents words from silence). */
  async stop(): Promise<string | null> {
    const { recorder, clip } = this;
    if (!recorder || recorder.state === "inactive" || !clip) return null;
    for (const timer of this.timers) clearTimeout(timer);
    recorder.stop();
    const blob = await clip;
    if (Date.now() - this.startedAt < MIN_CLIP_MS || this.peak < SILENCE) return null;
    return blobToBase64(blob);
  }
}

export class Speaker {
  readonly level: AnalyserNode;
  private readonly input: AudioNode;
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly context: AudioContext) {
    this.level = context.createAnalyser();
    this.level.connect(context.destination);
    this.input = tinCan(context, this.level);
  }

  /** Plays after anything already playing, so turns never talk over each other. */
  play(base64Audio: string, voice: Voice): Promise<void> {
    const turn = this.queue.then(() => this.playNow(base64Audio, voice));
    this.queue = turn.catch(() => {});
    return turn;
  }

  private async playNow(base64Audio: string, voice: Voice) {
    const bytes = await (await fetch(`data:audio/wav;base64,${base64Audio}`)).arrayBuffer();
    const buffer = await this.context.decodeAudioData(bytes);
    const source = new AudioBufferSourceNode(this.context, { buffer, playbackRate: VOICE_RATE[voice] });
    if (voice === "wobbly") vibrato(this.context, source);
    source.connect(this.input);
    const ended = new Promise((resolve) => source.addEventListener("ended", resolve));
    source.start();
    await ended;
  }
}

/** Band-limit to telephone range, add a metallic ring and a little grit: the sound of a tin can. */
function tinCan(context: AudioContext, output: AudioNode): AudioNode {
  const highpass = new BiquadFilterNode(context, { type: "highpass", frequency: 350 });
  const lowpass = new BiquadFilterNode(context, { type: "lowpass", frequency: 3200 });
  const ring = new BiquadFilterNode(context, { type: "peaking", frequency: 1700, Q: 4, gain: 7 });
  const grit = new WaveShaperNode(context, { curve: softClip(2.5), oversample: "2x" });
  highpass.connect(lowpass).connect(ring).connect(grit).connect(output);
  return highpass;
}

function softClip(drive: number): Float32Array<ArrayBuffer> {
  return Float32Array.from({ length: 1024 }, (_, i) => Math.tanh(drive * ((i / 1023) * 2 - 1)));
}

function vibrato(context: AudioContext, source: AudioBufferSourceNode) {
  const lfo = new OscillatorNode(context, { frequency: 6 });
  const depth = new GainNode(context, { gain: 90 }); // cents
  lfo.connect(depth).connect(source.detune);
  lfo.start();
  source.addEventListener("ended", () => lfo.stop());
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",")[1] ?? "");
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}
