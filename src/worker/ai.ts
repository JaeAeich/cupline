// Adapter over Workers AI. The rest of the app only knows transcribe / render / reply / speak,
// so swapping a model is a change to this file alone.
import { Buffer } from "node:buffer";
import { z } from "zod";
import type { Lang, Mode } from "../../shared/protocol";
import { operatorPrompt, renderPrompt, speakerWords } from "./prompts";
import { toPhoneRate } from "./wav";

const STT = "@cf/openai/whisper-large-v3-turbo";
const LLM = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";
const TTS = "@cf/myshell-ai/melotts";

// MeloTTS spells two language codes its own way.
const MELO_LANG: Partial<Record<Lang, string>> = { ja: "jp", ko: "kr" };

// Words MeloTTS mispronounces, respelled for the ear only; captions keep the real spelling.
const SAY_IT_LIKE: [RegExp, string][] = [[/Cupline/gi, "Cup line"]];

// Phrases Whisper is known to invent from silence or noise.
const HALLUCINATIONS = [/^\W*$/, /^thanks? (you )?for watching/i, /^subtitles? by/i];

export type ChatMessage = { role: "user" | "assistant"; content: string };

/** Thrown when the account's free daily neurons are gone. */
export class BudgetExhausted extends Error {}

export async function transcribe(ai: Ai, clip: string): Promise<string | null> {
  const out = await run(() => ai.run(STT, { audio: clip, vad_filter: true }));
  const text = out.text.trim();
  return HALLUCINATIONS.some((pattern) => pattern.test(text)) ? null : text;
}

// Deciding "abusive" *before* writing the text makes the model actually look for abuse.
const Rendered = z.object({ abusive: z.boolean(), text: z.string() });

export async function render(ai: Ai, text: string, lang: Lang, mode: Mode, recent: string[]) {
  const { abusive, text: rendered } = await askJson(ai, Rendered, renderPrompt(lang, mode), [
    { role: "user", content: speakerWords(text, recent) },
  ]);
  return { safe: !abusive, text: rendered };
}

const Reply = z.object({ text: z.string() });

export async function reply(ai: Ai, lang: Lang, mode: Mode, conversation: readonly ChatMessage[]) {
  const { text } = await askJson(ai, Reply, operatorPrompt(lang, mode), conversation);
  return text;
}

/** Returns base64 audio (telephone-rate WAV), or "" when there is nothing left to say. */
export async function speak(ai: Ai, text: string, lang: Lang): Promise<string> {
  if (!text.trim()) return "";
  const spoken = SAY_IT_LIKE.reduce((line, [word, sound]) => line.replace(word, sound), text);
  const out = await run(() => ai.run(TTS, { prompt: spoken, lang: MELO_LANG[lang] ?? lang }));
  const bytes = out instanceof Uint8Array ? out : Buffer.from(out.audio, "base64");
  return Buffer.from(toPhoneRate(bytes)).toString("base64");
}

async function askJson<T>(ai: Ai, schema: z.ZodType<T>, system: string, messages: readonly ChatMessage[]) {
  const out = await run(() =>
    ai.run(LLM, {
      messages: [{ role: "system", content: system }, ...messages],
      response_format: { type: "json_schema", json_schema: z.toJSONSchema(schema) },
      max_tokens: 250,
      temperature: 0.3,
    }),
  );
  // We never use batch mode, so the output always has `response`. In JSON mode it is
  // sometimes an already-parsed object rather than a string.
  const { response } = out as { response: unknown };
  return schema.parse(typeof response === "string" ? JSON.parse(response) : response);
}

/** One retry for flaky inference; budget errors are surfaced, not retried. */
async function run<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (error) {
    if (/4006|neurons/i.test(String(error))) throw new BudgetExhausted();
    return call();
  }
}
