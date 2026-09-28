// MeloTTS returns 44.1 kHz WAV: ~1 MB per 12 s of speech. The tin-can filter on the listener's side
// cuts everything above 3.2 kHz anyway, so we drop to telephone rate before storing or sending.
// A box-filter decimation is a few lines and costs almost no CPU; a resampling library would cost more.

const PHONE_RATE = 8000;

/** Downsamples 16-bit PCM WAV to roughly telephone rate. Anything else is returned untouched. */
export function toPhoneRate(wav: Uint8Array): Uint8Array {
  const format = readPcmFormat(wav);
  if (!format) return wav;
  const factor = Math.floor(format.sampleRate / PHONE_RATE);
  if (factor < 2) return wav;

  const input = new Int16Array(
    wav.buffer.slice(wav.byteOffset + format.dataStart, wav.byteOffset + format.dataEnd),
  );
  const channels = format.channels;
  const frames = Math.floor(input.length / channels / factor);
  const output = new Int16Array(frames);
  for (let frame = 0; frame < frames; frame++) {
    let sum = 0;
    const start = frame * factor * channels;
    for (let i = 0; i < factor * channels; i++) sum += input[start + i] ?? 0;
    output[frame] = sum / (factor * channels); // average the block: also mixes down to mono
  }
  return writeWav(output, Math.round(format.sampleRate / factor));
}

type PcmFormat = { channels: number; sampleRate: number; dataStart: number; dataEnd: number };

function readPcmFormat(wav: Uint8Array): PcmFormat | null {
  const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
  const tag = (at: number) => String.fromCharCode(...wav.subarray(at, at + 4));
  if (wav.byteLength < 44 || tag(0) !== "RIFF" || tag(8) !== "WAVE") return null;

  let channels = 0;
  let sampleRate = 0;
  let bitsPerSample = 0;
  for (let at = 12; at + 8 <= wav.byteLength; ) {
    const size = view.getUint32(at + 4, true);
    if (tag(at) === "fmt ") {
      const isPcm = view.getUint16(at + 8, true) === 1;
      if (!isPcm) return null;
      channels = view.getUint16(at + 10, true);
      sampleRate = view.getUint32(at + 12, true);
      bitsPerSample = view.getUint16(at + 22, true);
    } else if (tag(at) === "data") {
      if (bitsPerSample !== 16 || !channels) return null;
      return { channels, sampleRate, dataStart: at + 8, dataEnd: Math.min(at + 8 + size, wav.byteLength) };
    }
    at += 8 + size + (size % 2); // chunks are padded to an even length
  }
  return null;
}

function writeWav(samples: Int16Array, sampleRate: number): Uint8Array {
  const header = new DataView(new ArrayBuffer(44));
  const text = (at: number, value: string) => {
    for (let i = 0; i < value.length; i++) header.setUint8(at + i, value.charCodeAt(i));
  };
  text(0, "RIFF");
  header.setUint32(4, 36 + samples.byteLength, true);
  text(8, "WAVE");
  text(12, "fmt ");
  header.setUint32(16, 16, true); // fmt chunk size
  header.setUint16(20, 1, true); // PCM
  header.setUint16(22, 1, true); // mono
  header.setUint32(24, sampleRate, true);
  header.setUint32(28, sampleRate * 2, true); // bytes per second
  header.setUint16(32, 2, true); // bytes per frame
  header.setUint16(34, 16, true); // bits per sample
  text(36, "data");
  header.setUint32(40, samples.byteLength, true);

  const wav = new Uint8Array(44 + samples.byteLength);
  wav.set(new Uint8Array(header.buffer), 0);
  wav.set(new Uint8Array(samples.buffer), 44);
  return wav;
}
