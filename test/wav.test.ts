import { describe, expect, it } from "vitest";
import { toPhoneRate } from "../src/worker/wav";

/** A mono 16-bit PCM WAV, optionally with a LIST chunk before the audio like some encoders write. */
function wav(sampleRate: number, samples: Int16Array, withListChunk = false): Uint8Array {
  const list = withListChunk ? 12 : 0;
  const view = new DataView(new ArrayBuffer(44 + list + samples.byteLength));
  const text = (at: number, value: string) => {
    for (let i = 0; i < value.length; i++) view.setUint8(at + i, value.charCodeAt(i));
  };
  text(0, "RIFF");
  view.setUint32(4, 36 + list + samples.byteLength, true);
  text(8, "WAVE");
  text(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  if (withListChunk) {
    text(36, "LIST");
    view.setUint32(40, 4, true);
    text(44, "INFO");
  }
  text(36 + list, "data");
  view.setUint32(40 + list, samples.byteLength, true);
  const bytes = new Uint8Array(view.buffer);
  bytes.set(new Uint8Array(samples.buffer), 44 + list);
  return bytes;
}

const header = (bytes: Uint8Array) => new DataView(bytes.buffer, bytes.byteOffset);

describe("toPhoneRate", () => {
  it("shrinks MeloTTS's 44.1 kHz speech about fivefold", () => {
    const oneSecond = Int16Array.from({ length: 44_100 }, (_, i) => Math.round(8000 * Math.sin(i / 20)));
    const out = toPhoneRate(wav(44_100, oneSecond));
    expect(header(out).getUint32(24, true)).toBe(8820);
    expect(out.byteLength).toBe(44 + 8820 * 2);
  });

  it("averages each block of samples", () => {
    const out = toPhoneRate(wav(40_000, Int16Array.from([100, 200, 300, 400, 500, -5, -5, -5, -5, -5])));
    expect([...new Int16Array(out.buffer.slice(44))]).toEqual([300, -5]);
  });

  it("finds the audio after other chunks", () => {
    const out = toPhoneRate(wav(44_100, new Int16Array(4410).fill(1000), true));
    expect([...new Int16Array(out.buffer.slice(44))].every((sample) => sample === 1000)).toBe(true);
  });

  it("leaves anything that isn't 16-bit PCM WAV alone", () => {
    const mp3ish = new Uint8Array([0xff, 0xfb, 0x90, 0x00]);
    expect(toPhoneRate(mp3ish)).toBe(mp3ish);
  });
});
