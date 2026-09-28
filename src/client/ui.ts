// Everything the page shows. No logic about strings or audio lives here, only rendering.
import QRCode from "qrcode";
import {
  type Delivery,
  FAILURES,
  type Failure,
  LANGUAGES,
  type Lang,
  MODES,
  type Mode,
  type Prefs,
  type SpeakResult,
  VOICES,
  type Voice,
} from "../../shared/protocol";
import { describeDistance, travelTale } from "./travel";

export type Phase = "landing" | "call" | "put-down";
export type OtherEnd = { kind: "nobody" } | { kind: "operator" } | { kind: "stranger"; prefs: Prefs };

const MODE_COPY: Record<Mode, [label: string, description: string]> = {
  faithful: ["Faithful", "Translated, tone kept"],
  gist: ["Gist", "Just the point, one sentence"],
  telegram: ["Telegram", "TERSE STOP CHARMING STOP"],
};
const VOICE_COPY: Record<Voice, string> = { low: "Low", mid: "Middling", high: "High", wobbly: "Wobbly" };

const FAILURE_COPY: Record<Failure, string> = {
  "rate-limited": "Easy there. The string needs a breather; try again in a minute.",
  "worn-thin": "The string's worn thin for today. Come back tomorrow.",
  slack: "That didn't make it down the string. Try again?",
  "operator-tired": "The Operator has other lines ringing. Leave a message in the cup instead?",
};
const RESULT_COPY: Record<SpeakResult["status"], string> = {
  delivered: "",
  operator: "",
  "left-in-cup": "Left in the cup. The next person to pick up will hear it.",
  refused: "The cup wouldn't keep that one.",
  silent: "The string didn't catch any words.",
};

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

export const elements = {
  canvas: $<HTMLCanvasElement>("scene"),
  pickUp: $<HTMLButtonElement>("pick-up"),
  pickUpAgain: $<HTMLButtonElement>("pick-up-again"),
  voice: $<HTMLSelectElement>("voice"),
  lang: $<HTMLSelectElement>("lang"),
  modes: $<HTMLDivElement>("modes"),
  talk: $<HTMLButtonElement>("talk"),
  typeForm: $<HTMLFormElement>("type-form"),
  typed: $<HTMLInputElement>("typed"),
  hangUp: $<HTMLButtonElement>("hang-up"),
  playMessages: $<HTMLButtonElement>("play-messages"),
  callOperator: $<HTMLButtonElement>("call-operator"),
  share: $<HTMLButtonElement>("share"),
};

/** Languages are listed in their own script: 日本語, not "Japanese". */
const nativeName = (lang: Lang) => new Intl.DisplayNames([lang], { type: "language" }).of(lang) ?? lang;

export function buildPrefsForm(prefs: Prefs) {
  elements.voice.replaceChildren(...VOICES.map((voice) => new Option(VOICE_COPY[voice], voice)));
  elements.lang.replaceChildren(...LANGUAGES.map((lang) => new Option(nativeName(lang), lang)));
  elements.modes.replaceChildren(
    ...MODES.map((mode) => {
      const [label, description] = MODE_COPY[mode];
      const option = document.createElement("label");
      option.innerHTML = `<input type="radio" name="mode" value="${mode}" /><b>${label}</b><small>${description}</small>`;
      return option;
    }),
  );
  showPrefs(prefs);
}

function showPrefs({ voice, lang, mode }: Prefs) {
  elements.voice.value = voice;
  elements.lang.value = lang;
  const radio = elements.modes.querySelector<HTMLInputElement>(`input[value="${mode}"]`);
  if (radio) radio.checked = true;
}

export function readPrefs(): Prefs {
  const mode = elements.modes.querySelector<HTMLInputElement>("input:checked")?.value;
  return { voice: elements.voice.value, lang: elements.lang.value, mode } as Prefs;
}

export function showPhase(phase: Phase, putDownText?: string) {
  document.body.dataset.phase = phase;
  if (putDownText) $("put-down-text").textContent = putDownText;
}

export function showOtherEnd(other: OtherEnd, waiting: number, distanceKm: number | null) {
  const titles = { nobody: "The other cup", operator: "The Operator", stranger: "Someone picked up" };
  const subtitles = {
    nobody: "Dangling at the far end. Nobody's holding it yet.",
    operator: "An AI, keeping you company until someone picks up.",
    stranger: "",
  };
  $("them-title").textContent = titles[other.kind];
  $("them-subtitle").textContent = subtitles[other.kind];
  $("them-details").hidden = other.kind !== "stranger";
  if (other.kind === "stranger") {
    const [modeLabel] = MODE_COPY[other.prefs.mode];
    $("them-voice").textContent = VOICE_COPY[other.prefs.voice];
    $("them-hears").textContent = `${nativeName(other.prefs.lang)} · ${modeLabel}`;
  }
  $("them-distance-row").hidden = other.kind !== "stranger" || distanceKm === null;
  if (distanceKm !== null) $("them-distance").textContent = describeDistance(distanceKm);
  $("empty-line").hidden = other.kind !== "nobody";
  elements.playMessages.hidden = waiting === 0;
  elements.playMessages.textContent = `▶ ${waiting} ${waiting === 1 ? "message" : "messages"} in the cup`;
}

const MAX_LINES = 30;
const WHO: Record<Delivery["from"], string> = {
  cup: "Them",
  operator: "The Operator",
  message: "Left in the cup",
};

/** Something arrived down the string: add it to the conversation, newest at the bottom. */
export function showHeard(delivery: Delivery, distanceKm: number | null) {
  const { stt, llm, tts } = delivery.ms;
  const timings = [stt && `stt ${stt}ms`, llm && `llm ${llm}ms`, tts && `tts ${tts}ms`].filter(Boolean);
  addLine(delivery.from === "cup" ? "them" : delivery.from, {
    who: WHO[delivery.from],
    words: delivery.caption || "(the string muffled that)",
    original: delivery.from !== "operator" && delivery.original !== delivery.caption ? delivery.original : "",
    travel: delivery.from === "cup" && distanceKm !== null ? travelTale(distanceKm, delivery.ms) : "",
    meta: timings.length ? timings.join(" · ") : "from the cup's memory · 0 neurons",
  });
}

/** What we said, and how it came out at the other end. */
export function showSaid(result: SpeakResult) {
  setStatus(RESULT_COPY[result.status]);
  if (!result.original || result.status === "refused" || result.status === "silent") return;
  const [heard] = result.status === "delivered" ? result.heard : [];
  const meta = heard
    ? `They heard: “${heard.caption}”`
    : result.status === "left-in-cup"
      ? "Waiting in the cup for the next person."
      : "";
  addLine("you", { who: "You", words: result.original, original: "", travel: "", meta });
}

type Line = { who: string; words: string; original: string; travel: string; meta: string };

function addLine(kind: "them" | "you" | "operator" | "message", line: Line) {
  const feed = $("conversation");
  const template = $<HTMLTemplateElement>("line-template");
  const item = template.content.firstElementChild?.cloneNode(true) as HTMLLIElement;
  const part = (selector: string) => item.querySelector(selector) as HTMLElement;
  item.classList.add(`from-${kind}`);
  part(".who").textContent = line.who; // textContent, never innerHTML: these are strangers' words
  part(".words").textContent = line.words;
  part(".original").hidden = !line.original;
  part(".original p").textContent = line.original;
  part(".travel").textContent = line.travel;
  part(".meta").textContent = line.meta;
  feed.append(item);
  while (feed.children.length > MAX_LINES) feed.firstElementChild?.remove();
  feed.scrollTo({ top: feed.scrollHeight, behavior: "smooth" });
}

export function showFailure(error: unknown) {
  const code = error instanceof Error ? error.message : "";
  const failure = FAILURES.find((known) => known === code) ?? "slack";
  setStatus(FAILURE_COPY[failure]);
}

export function setStatus(text: string) {
  $("status").textContent = text;
}

export function setTalking(talking: boolean) {
  elements.talk.setAttribute("aria-pressed", String(talking));
  $("talk-label").textContent = talking ? "Listening…" : "Hold to talk";
}

export async function showShareDialog(url: string) {
  const qr = $<HTMLImageElement>("qr");
  qr.src = await QRCode.toDataURL(url, {
    width: 440,
    margin: 1,
    color: { dark: "#2a2140", light: "#f4eadb" },
  });
  const link = $<HTMLAnchorElement>("share-link");
  link.href = url;
  link.textContent = url;
  $<HTMLDialogElement>("share-dialog").showModal();
}
