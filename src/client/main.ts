// Wires the page together: the scene, the audio, this cup's line to the string, and the UI.
import {
  LANGUAGES,
  Prefs,
  type ServerPush,
  type SpeakResult,
  type StringState,
  VOICES,
} from "../../shared/protocol";
import { loudness, Recorder, Speaker } from "./audio";
import { type Line, pickUp } from "./line";
import { type CupScene, createScene } from "./scene";
import * as ui from "./ui";

const IDLE_MS = 2 * 60 * 1000;
const PREFS_KEY = "cupline:prefs";

let stringName = new URLSearchParams(location.search).get("s") ?? "main";
let prefs = loadPrefs();
let line: Line | null = null;
let state: StringState = { cups: [], waiting: 0, distanceKm: null };
let withOperator = false;
let lastHeardFrom: "cup" | "operator" | "message" | null = null;
let playedWaitingMessage = false;
let talking = false;
let idleTimer = 0;
let audio: { recorder: Recorder; speaker: Speaker } | null = null;

const { elements } = ui;
const scene = tryCreateScene();
ui.buildPrefsForm(prefs);

// --- Picking up and putting down ---

function startCall() {
  audio ??= createAudio(); // must run inside the click: browsers only unlock audio on a gesture
  scene?.pickUp();
  ui.showPhase("call");
  withOperator = false;
  line = pickUp(stringName, prefs, { onState: onStringState, onPush });
  touch();
}

function putDown(message: string) {
  line?.hangUp();
  line = null;
  clearTimeout(idleTimer);
  scene?.putDown();
  ui.showPhase("put-down", message);
}

/** Any activity keeps the line open; two quiet minutes and the cup is put down for you. */
function touch() {
  clearTimeout(idleTimer);
  idleTimer = window.setTimeout(
    () => putDown("You put the cup down. It had gone quiet for a while."),
    IDLE_MS,
  );
}

// --- What the string tells us ---

function onStringState(next: StringState) {
  state = next;
  renderOtherEnd();
  // The first time we find the line empty with something waiting, play it: the cup is never silent.
  if (!playedWaitingMessage && otherEnd().kind === "nobody" && state.waiting > 0) {
    playedWaitingMessage = true;
    void run("Reeling in a message…", () => line?.playMessages(1));
  }
}

function onPush(push: ServerPush) {
  touch();
  if (push.type === "delivery") {
    lastHeardFrom = push.from;
    ui.setStatus("");
    ui.showHeard(push, state.distanceKm);
    if (push.audio) void audio?.speaker.play(push.audio, push.voice);
    return;
  }
  if (push.code === "speaking") {
    scene?.sendPulse();
    ui.setStatus("Someone's talking. Their words are on the way…");
  } else if (push.code === "handoff") {
    withOperator = false;
    renderOtherEnd();
    ui.setStatus("Someone just picked up the other end. The Operator steps aside.");
  } else if (push.code === "busy") {
    putDown("The line's busy: two cups to a string. Try again soon, or hand a friend a private cup.");
  }
}

function otherEnd(): ui.OtherEnd {
  const stranger = state.cups.find((cup) => cup.id !== line?.id);
  if (stranger) return { kind: "stranger", prefs: stranger.prefs };
  return withOperator ? { kind: "operator" } : { kind: "nobody" };
}

function renderOtherEnd() {
  ui.showOtherEnd(otherEnd(), state.waiting, state.distanceKm);
}

// --- What we send ---

/** Runs a call to the string with a status line, a pulse on the string, and friendly failures. */
async function run<T>(status: string, work: () => Promise<T> | undefined): Promise<T | undefined> {
  ui.setStatus(status);
  scene?.sendPulse();
  touch();
  try {
    const result = await work();
    ui.setStatus("");
    return result;
  } catch (error) {
    ui.showFailure(error);
  }
}

async function send(work: () => Promise<SpeakResult> | undefined) {
  const result = await run("Sending it down the string…", work);
  if (result) ui.showSaid(result);
}

async function startTalking() {
  if (!audio || !line || talking) return;
  talking = true;
  ui.setTalking(true);
  touch();
  try {
    await audio.recorder.start();
    if (!talking) await audio.recorder.stop(); // released before the mic was ready
  } catch {
    talking = false;
    ui.setTalking(false);
    ui.setStatus("No microphone? Type into the cup instead.");
    ui.elements.typed.focus();
  }
}

async function finishTalking() {
  if (!talking || !audio) return;
  talking = false;
  ui.setTalking(false);
  const clip = await audio.recorder.stop();
  if (!clip) return ui.setStatus("Didn't catch that. Hold the cup while you speak.");
  await send(() => line?.speak(clip));
}

function changePrefs() {
  prefs = ui.readPrefs();
  localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
  void line?.setPrefs(prefs);
  // Alone with a message? Say it again the new way. That's the whole trick, on demand.
  if (lastHeardFrom === "message" && otherEnd().kind === "nobody") {
    void run("Saying it again, your way…", () => line?.playMessages(1));
  }
}

async function handToSomeone() {
  stringName = crypto.randomUUID();
  const url = new URL(location.href);
  url.search = `?s=${stringName}`;
  history.replaceState(null, "", url);
  line?.hangUp();
  startCall(); // we move onto the private string too
  await ui.showShareDialog(url.href);
}

// --- Wiring ---

elements.pickUp.addEventListener("click", startCall);
elements.pickUpAgain.addEventListener("click", startCall);
elements.hangUp.addEventListener("click", () => putDown("You put the cup down."));
elements.playMessages.addEventListener("click", () =>
  run("Reeling in the messages…", () => line?.playMessages()),
);
elements.callOperator.addEventListener("click", () => {
  withOperator = true;
  renderOtherEnd();
  void run("Ringing the Operator…", () => line?.callOperator());
});
elements.share.addEventListener("click", handToSomeone);
for (const control of [elements.voice, elements.lang, elements.modes]) {
  control.addEventListener("change", changePrefs);
}

elements.talk.addEventListener("pointerdown", (event) => {
  elements.talk.setPointerCapture(event.pointerId);
  void startTalking();
});
elements.talk.addEventListener("pointerup", finishTalking);
elements.talk.addEventListener("pointercancel", finishTalking);
elements.talk.addEventListener("contextmenu", (event) => event.preventDefault());

const typingSomewhere = (target: EventTarget | null) =>
  target instanceof HTMLInputElement || target instanceof HTMLSelectElement;
addEventListener("keydown", (event) => {
  if (event.code !== "Space" || event.repeat || typingSomewhere(event.target) || !line) return;
  event.preventDefault();
  void startTalking();
});
addEventListener("keyup", (event) => {
  if (event.code === "Space" && !typingSomewhere(event.target)) void finishTalking();
});

elements.typeForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const text = elements.typed.value.trim();
  if (!text) return;
  elements.typed.value = "";
  void send(() => line?.type(text));
});

// --- Setup helpers ---

function createAudio() {
  const context = new AudioContext();
  const speaker = new Speaker(context);
  const recorder = new Recorder(context, finishTalking);
  scene?.listenTo(() => Math.max(loudness(recorder.level), loudness(speaker.level)));
  return { recorder, speaker };
}

function tryCreateScene(): CupScene | null {
  try {
    const created = createScene(elements.canvas, matchMedia("(prefers-reduced-motion: reduce)").matches);
    requestAnimationFrame(() => document.body.classList.add("scene-ready"));
    return created;
  } catch (error) {
    console.warn("No 3D scene, keeping the poster:", error); // everything else still works
    return null;
  }
}

function loadPrefs(): Prefs {
  try {
    const saved = Prefs.safeParse(JSON.parse(localStorage.getItem(PREFS_KEY) ?? "null"));
    if (saved.success) return saved.data;
  } catch {}
  const browserLang = navigator.language.slice(0, 2);
  const lang = LANGUAGES.find((known) => known === browserLang) ?? "en";
  const voice = VOICES[Math.floor(Math.random() * VOICES.length)] ?? "mid";
  return { lang, mode: "faithful", voice };
}
