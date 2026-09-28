// Client-side adapter over the Agents SDK: one Line = this cup's connection to a string.
import { AgentClient } from "agents/client";
import type { Prefs, ServerPush, SpeakResult, StringState } from "../../shared/protocol";

export type LineEvents = {
  onState: (state: StringState) => void;
  onPush: (push: ServerPush) => void;
};

export type Line = ReturnType<typeof pickUp>;

export function pickUp(stringName: string, prefs: Prefs, events: LineEvents) {
  const client = new AgentClient<StringState>({
    agent: "StringAgent",
    name: stringName,
    host: location.host,
    query: prefs,
    onStateUpdate: (state) => events.onState(state),
  });

  client.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data));
    // The SDK shares this socket with its own frames; ours carry "delivery" or "notice".
    if (message.type === "delivery" || message.type === "notice") events.onPush(message);
  });

  return {
    /** This cup's id, to tell ourselves apart in the string's state. */
    id: client.id,
    speak: (clip: string) => client.call<SpeakResult>("speak", [clip]),
    type: (text: string) => client.call<SpeakResult>("type", [text]),
    setPrefs: (next: Prefs) => client.call("setPrefs", [next]),
    callOperator: () => client.call("callOperator", [], { timeout: 60_000 }),
    playMessages: (limit?: number) => client.call("playMessages", limit ? [limit] : [], { timeout: 90_000 }),
    hangUp: () => client.close(),
  };
}
