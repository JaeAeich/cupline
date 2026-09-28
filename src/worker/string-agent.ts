// One StringAgent per string. It is the mediator between the cups on it:
// cups never talk to each other directly, everything they say passes through here.

import { Agent, type Connection, type ConnectionContext, callable, getCurrentAgent } from "agents";
import { z } from "zod";
import { distanceKm, type Place } from "../../shared/geo";
import {
  CLOSE_BUSY,
  Clip,
  type Delivery,
  type Failure,
  type HeardAs,
  MAX_CUPS_PER_STRING,
  OPERATOR_TURN_LIMIT,
  Prefs,
  type ServerPush,
  type SpeakResult,
  type StringState,
  Typed,
  type Voice,
} from "../../shared/protocol";
import { BudgetExhausted, type ChatMessage, render, reply, speak, transcribe } from "./ai";
import { PINNED_MESSAGE } from "./prompts";

/** Where the Worker puts the caller's approximate place; see beforeConnect in index.ts. */
export const PLACE_HEADERS = { lat: "x-cupline-lat", lon: "x-cupline-lon" } as const;

/** Private, per-connection state. Survives hibernation via connection.setState. */
type CupState = {
  prefs: Prefs;
  ip: string;
  place: Place | null; // never broadcast: other cups only ever see a rounded distance
  withOperator: boolean;
  operatorTurns: number;
  operatorChat: readonly ChatMessage[];
};
type Cup = Connection<CupState>;

type MessageRow = { id: string; text: string; voice: Voice };
type RenderRow = { caption: string; audio: string };

const DEFAULT_PREFS: Prefs = { lang: "en", mode: "faithful", voice: "mid" };
const OPERATOR_VOICE: Voice = "low";
const MAIN_STRING = "main";
const KEEP_MESSAGES = 5;
const MESSAGE_TTL_SECONDS = 72 * 60 * 60;
const HISTORY_TTL_MS = 24 * 60 * 60 * 1000;
const HISTORY_TURNS = 6;
const MessageLimit = z
  .number()
  .int()
  .min(1)
  .max(KEEP_MESSAGES + 1); // pinned + the kept messages

class TurnFailure extends Error {
  constructor(readonly code: Failure) {
    super(code);
  }
}

export class StringAgent extends Agent<Env, StringState> {
  initialState: StringState = { cups: [], waiting: 0, distanceKm: null };

  // Turns are handled one at a time so they arrive in the order they were spoken.
  private turnQueue: Promise<unknown> = Promise.resolve();

  onStart() {
    this.sql`CREATE TABLE IF NOT EXISTS turns (text TEXT NOT NULL, at INTEGER NOT NULL)`;
    this.sql`CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY, text TEXT NOT NULL, voice TEXT NOT NULL,
      at INTEGER NOT NULL, pinned INTEGER NOT NULL DEFAULT 0)`;
    this.sql`CREATE TABLE IF NOT EXISTS renders (
      message_id TEXT NOT NULL, lang TEXT NOT NULL, mode TEXT NOT NULL,
      caption TEXT NOT NULL, audio TEXT NOT NULL, PRIMARY KEY (message_id, lang, mode))`;
    if (this.name === MAIN_STRING) this.pinMessage(PINNED_MESSAGE);
  }

  /** Cups only read the string's state; only the string writes it. */
  validateStateChange(_next: StringState, source: Connection | "server") {
    if (source !== "server") throw new Error("String state is read-only");
  }

  onConnect(cup: Cup, { request }: ConnectionContext) {
    if (this.cups().length >= MAX_CUPS_PER_STRING) {
      // The cup hangs up when it hears "busy"; the close is for clients that ignore it.
      push(cup, { type: "notice", code: "busy" });
      return cup.close(CLOSE_BUSY, "The line's busy");
    }

    const requested = Prefs.safeParse(Object.fromEntries(new URL(request.url).searchParams));
    cup.setState({
      prefs: requested.success ? requested.data : DEFAULT_PREFS,
      ip: request.headers.get("cf-connecting-ip") ?? "local",
      place: placeFrom(request.headers),
      withOperator: false,
      operatorTurns: 0,
      operatorChat: [],
    });
    this.handOffFromOperator();
    this.syncState();
  }

  onClose() {
    this.syncState();
  }

  @callable()
  setPrefs(prefs: unknown) {
    const cup = this.caller();
    cup.setState({ ...stateOf(cup), prefs: Prefs.parse(prefs) });
    this.syncState();
  }

  @callable()
  async speak(clip: unknown): Promise<SpeakResult> {
    const cup = this.caller();
    const audio = Clip.parse(clip);
    await this.checkRateLimit(cup);
    this.notifyOthers(cup, { type: "notice", code: "speaking" });
    return this.enqueue(async () => {
      const [original, stt] = await timed(() => transcribe(this.env.AI, audio));
      if (!original) return { status: "silent", original: "" };
      return this.takeTurn(cup, original, stt);
    });
  }

  @callable()
  async type(text: unknown): Promise<SpeakResult> {
    const cup = this.caller();
    const original = Typed.parse(text);
    await this.checkRateLimit(cup);
    this.notifyOthers(cup, { type: "notice", code: "speaking" });
    return this.enqueue(() => this.takeTurn(cup, original));
  }

  @callable()
  callOperator() {
    const cup = this.caller();
    if (this.othersThan(cup).length) return;
    cup.setState({ ...stateOf(cup), withOperator: true });
    return this.enqueue(() =>
      this.operatorSays(cup, "(The caller just picked up and nobody else is here. Greet them.)"),
    );
  }

  /** Plays what's waiting in the cup, pinned message first. `limit` 1 replays just the top one. */
  @callable()
  playMessages(limit: unknown = KEEP_MESSAGES + 1) {
    const cup = this.caller();
    const count = MessageLimit.parse(limit);
    return this.enqueue(async () => {
      const messages = this.sql<MessageRow>`
        SELECT id, text, voice FROM messages ORDER BY pinned DESC, at DESC LIMIT ${count}`;
      for (const message of messages) {
        push(cup, await this.renderMessage(message, stateOf(cup).prefs));
      }
    });
  }

  /** Scheduled by leaveInCup. */
  expireMessage({ id }: { id: string }) {
    this.sql`DELETE FROM messages WHERE id = ${id}`;
    this.forgetStaleRenders();
    this.syncState();
  }

  /** Admin only: reachable through Durable Object RPC from the Worker, not from cups. */
  purgeMessages() {
    this.sql`DELETE FROM messages WHERE pinned = 0`;
    this.forgetStaleRenders();
    this.syncState();
  }

  // --- A turn: someone said something. Who hears it depends on who is on the line. ---

  private takeTurn(speaker: Cup, original: string, stt?: number): Promise<SpeakResult> {
    const listeners = this.othersThan(speaker);
    if (listeners.length) return this.relay(speaker, original, listeners, stt);
    if (stateOf(speaker).withOperator) return this.talkToOperator(speaker, original);
    return this.leaveInCup(speaker, original);
  }

  private async relay(speaker: Cup, original: string, listeners: Cup[], stt?: number) {
    const recent = this.recentTurns();
    this.rememberTurn(original);
    const heard = await Promise.all(
      listeners.map(async (listener): Promise<HeardAs> => {
        const { lang, mode } = stateOf(listener).prefs;
        const [rendered, llm] = await timed(() => render(this.env.AI, original, lang, mode, recent));
        const [audio, tts] = await timed(() => speak(this.env.AI, rendered.text, lang));
        push(listener, {
          type: "delivery",
          from: "cup",
          caption: rendered.text,
          original,
          audio,
          voice: stateOf(speaker).prefs.voice,
          ms: { stt, llm, tts },
        });
        return { lang, mode, caption: rendered.text };
      }),
    );
    return { status: "delivered", original, heard } as const;
  }

  private async talkToOperator(cup: Cup, original: string) {
    if (stateOf(cup).operatorTurns >= OPERATOR_TURN_LIMIT) throw new TurnFailure("operator-tired");
    await this.operatorSays(cup, original);
    return { status: "operator", original } as const;
  }

  private async operatorSays(cup: Cup, callerWords: string) {
    const state = stateOf(cup);
    const { lang, mode } = state.prefs;
    const chat: ChatMessage[] = [...state.operatorChat, { role: "user", content: callerWords }];
    const [text, llm] = await timed(() => reply(this.env.AI, lang, mode, chat));
    const [audio, tts] = await timed(() => speak(this.env.AI, text, lang));
    cup.setState({
      ...stateOf(cup),
      operatorTurns: state.operatorTurns + 1,
      operatorChat: [...chat, { role: "assistant" as const, content: text }].slice(-12),
    });
    push(cup, {
      type: "delivery",
      from: "operator",
      caption: text,
      original: text,
      audio,
      voice: OPERATOR_VOICE,
      ms: { llm, tts },
    });
  }

  private async leaveInCup(speaker: Cup, original: string) {
    // The same words twice would only make the cup repeat itself.
    const [duplicate] = this.sql`SELECT 1 FROM messages WHERE text = ${original}`;
    if (duplicate) return { status: "left-in-cup", original } as const;

    // Moderate before anything is kept for strangers.
    const { safe } = await render(this.env.AI, original, "en", "faithful", []);
    if (!safe) return { status: "refused", original } as const;

    const id = crypto.randomUUID();
    const { voice } = stateOf(speaker).prefs;
    this.sql`INSERT INTO messages (id, text, voice, at) VALUES (${id}, ${original}, ${voice}, ${Date.now()})`;
    this.sql`DELETE FROM messages WHERE pinned = 0 AND id NOT IN (
      SELECT id FROM messages WHERE pinned = 0 ORDER BY at DESC LIMIT ${KEEP_MESSAGES})`;
    await this.schedule(MESSAGE_TTL_SECONDS, "expireMessage", { id });
    this.forgetStaleRenders();
    this.syncState();
    return { status: "left-in-cup", original } as const;
  }

  /** Messages are re-voiced per listener; each (message, lang, mode) is rendered once, then cached. */
  private async renderMessage(message: MessageRow, { lang, mode }: Prefs): Promise<Delivery> {
    const delivery = (caption: string, audio: string, llm = 0, tts = 0): Delivery => ({
      type: "delivery",
      from: "message",
      caption,
      original: message.text,
      audio,
      voice: message.voice,
      ms: { llm, tts },
    });
    const [cached] = this.sql<RenderRow>`
      SELECT caption, audio FROM renders
      WHERE message_id = ${message.id} AND lang = ${lang} AND mode = ${mode}`;
    if (cached) return delivery(cached.caption, cached.audio);

    const [rendered, llm] = await timed(() => render(this.env.AI, message.text, lang, mode, []));
    const [audio, tts] = await timed(() => speak(this.env.AI, rendered.text, lang));
    this.sql`INSERT OR REPLACE INTO renders (message_id, lang, mode, caption, audio)
      VALUES (${message.id}, ${lang}, ${mode}, ${rendered.text}, ${audio})`;
    return delivery(rendered.text, audio, llm, tts);
  }

  // --- Bookkeeping ---

  private pinMessage(text: string) {
    this.sql`DELETE FROM messages WHERE pinned = 1 AND text != ${text}`;
    this.sql`INSERT OR IGNORE INTO messages (id, text, voice, at, pinned)
      VALUES ('pinned', ${text}, ${"mid" satisfies Voice}, 0, 1)`;
    this.forgetStaleRenders();
  }

  private forgetStaleRenders() {
    this.sql`DELETE FROM renders WHERE message_id NOT IN (SELECT id FROM messages)`;
  }

  private rememberTurn(text: string) {
    this.sql`INSERT INTO turns (text, at) VALUES (${text}, ${Date.now()})`;
    this.sql`DELETE FROM turns WHERE at < ${Date.now() - HISTORY_TTL_MS}`;
  }

  private recentTurns(): string[] {
    const rows = this.sql<{ text: string }>`
      SELECT text FROM turns ORDER BY at DESC LIMIT ${HISTORY_TURNS}`;
    return rows.map((row) => row.text).reverse();
  }

  private syncState() {
    const [{ count }] = this.sql<{ count: number }>`SELECT COUNT(*) AS count FROM messages`;
    const cups = this.cups();
    const [here, there] = cups.map((cup) => stateOf(cup).place);
    this.setState({
      cups: cups.map((cup) => ({ id: cup.id, prefs: stateOf(cup).prefs })),
      waiting: count,
      distanceKm: here && there ? distanceKm(here, there) : null,
    });
  }

  /** A second person picked up: the Operator steps aside. */
  private handOffFromOperator() {
    for (const cup of this.cups()) {
      if (!stateOf(cup).withOperator) continue;
      cup.setState({ ...stateOf(cup), withOperator: false });
      push(cup, { type: "notice", code: "handoff" });
    }
  }

  private async checkRateLimit(cup: Cup) {
    const { success } = await this.env.TURN_LIMITER.limit({ key: stateOf(cup).ip });
    if (!success) throw new TurnFailure("rate-limited");
  }

  private enqueue<T>(work: () => Promise<T>): Promise<T> {
    const result = this.turnQueue.then(work);
    this.turnQueue = result.catch(() => {});
    return result.catch((error: unknown) => {
      throw toTurnFailure(error);
    });
  }

  private notifyOthers(cup: Cup, message: ServerPush) {
    for (const other of this.othersThan(cup)) push(other, message);
  }

  private cups(): Cup[] {
    return [...this.getConnections<CupState>()].filter((cup) => cup.state);
  }

  private othersThan(cup: Cup): Cup[] {
    return this.cups().filter((other) => other.id !== cup.id);
  }

  private caller(): Cup {
    const { connection } = getCurrentAgent();
    if (!connection) throw new Error("Only cups can call the string");
    return connection as Cup;
  }
}

function placeFrom(headers: Headers): Place | null {
  const lat = Number(headers.get(PLACE_HEADERS.lat));
  const lon = Number(headers.get(PLACE_HEADERS.lon));
  return headers.has(PLACE_HEADERS.lat) && Number.isFinite(lat) && Number.isFinite(lon) ? { lat, lon } : null;
}

function stateOf(cup: Cup): CupState {
  if (!cup.state) throw new Error(`Cup ${cup.id} has no state yet`);
  return cup.state;
}

function push(cup: Cup, message: ServerPush) {
  cup.send(JSON.stringify(message));
}

function toTurnFailure(error: unknown): TurnFailure {
  if (error instanceof TurnFailure) return error;
  if (error instanceof BudgetExhausted) return new TurnFailure("worn-thin");
  console.error("Turn failed", error);
  return new TurnFailure("slack");
}

/** Runs work and reports how long it took, for the telemetry shown on the string. */
async function timed<T>(work: () => Promise<T>): Promise<[T, number]> {
  const start = Date.now();
  const result = await work();
  return [result, Date.now() - start];
}
