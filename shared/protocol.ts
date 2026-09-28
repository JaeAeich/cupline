// The contract between a cup (browser) and a string (StringAgent).
// Zod schemas validate anything that crosses the wire; types are inferred from them.
import { z } from "zod";

export const LANGUAGES = ["en", "es", "fr", "zh", "ja", "ko"] as const;
export const MODES = ["faithful", "gist", "telegram"] as const;
export const VOICES = ["low", "mid", "high", "wobbly"] as const;

export const Prefs = z.object({
  lang: z.enum(LANGUAGES),
  mode: z.enum(MODES),
  voice: z.enum(VOICES),
});
export type Prefs = z.infer<typeof Prefs>;
export type Lang = Prefs["lang"];
export type Mode = Prefs["mode"];
export type Voice = Prefs["voice"];

// ~15 s of compressed audio, base64-encoded, stays well under this.
export const Clip = z.string().min(1).max(1_400_000);
export const Typed = z.string().trim().min(1).max(500);

export const MAX_CUPS_PER_STRING = 2;
export const OPERATOR_TURN_LIMIT = 10;

/** Public string state, synced to every cup by the Agents SDK. */
export type CupInfo = { id: string; prefs: Prefs };
/** `distanceKm`: how far apart the two cups are, rounded; null unless two cups with known places. */
export type StringState = { cups: CupInfo[]; waiting: number; distanceKm: number | null };

/** What a speaker learns after talking: how each listener actually heard them. */
export type HeardAs = { lang: Lang; mode: Mode; caption: string };
export type SpeakResult =
  | { status: "delivered"; original: string; heard: HeardAs[] }
  | { status: "left-in-cup" | "refused" | "silent" | "operator"; original: string };

/** Server → cup pushes (sent next to the SDK's own protocol frames). */
export type Delivery = {
  type: "delivery";
  from: "cup" | "operator" | "message";
  caption: string;
  original: string;
  audio: string; // base64 WAV at telephone rate, "" if nothing was left to say
  voice: Voice;
  ms: { stt?: number; llm: number; tts: number };
};
export type Notice = { type: "notice"; code: "speaking" | "handoff" | "busy" };
export type ServerPush = Delivery | Notice;

/** Why a call to the string failed; sent as the RPC error message. */
export const FAILURES = ["rate-limited", "worn-thin", "slack", "operator-tired"] as const;
export type Failure = (typeof FAILURES)[number];

export const CLOSE_BUSY = 4001; // 4000–4999 are terminal: the client won't auto-reconnect
