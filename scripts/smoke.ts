// End-to-end smoke test against a running dev server (`npm run dev`). Uses real Workers AI.
// Usage: node scripts/smoke.ts [host]
import { AgentClient } from "agents/client";
import type { ServerPush, SpeakResult } from "../shared/protocol.ts";

const host = process.argv[2] ?? "localhost:5173";
const string = `smoke-${Date.now()}`;

function pickUp(label: string, query: Record<string, string>) {
  const client = new AgentClient({ agent: "StringAgent", name: string, host, query });
  const inbox: ServerPush[] = [];
  client.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data));
    if (message.type === "delivery" || message.type === "notice") {
      inbox.push(message);
      const text =
        message.type === "delivery"
          ? `${message.from}: ${message.caption} ${JSON.stringify(message.ms)}`
          : message.code;
      console.log(`  [${label} hears] ${text}`);
    }
  });
  client.addEventListener("close", (event) =>
    console.log(`  [${label}] closed ${(event as CloseEvent).code}`),
  );
  return { client, inbox };
}

const step = async (title: string, work: () => Promise<unknown>) => {
  const start = Date.now();
  const result = await work();
  console.log(`${title} (${Date.now() - start} ms)`, result === undefined ? "" : JSON.stringify(result));
};

const a = pickUp("A", { lang: "en", mode: "faithful", voice: "mid" });
await a.client.ready;
await step("A types into an empty string", () =>
  a.client.call<SpeakResult>("type", ["Hi, I'm Javed. Anyone out there?"]),
);
await step("A calls the Operator", () => a.client.call("callOperator"));
await step("A talks to the Operator", () => a.client.call("type", ["What is this place?"]));

const b = pickUp("B", { lang: "ja", mode: "telegram", voice: "high" });
await b.client.ready;
await new Promise((resolve) => setTimeout(resolve, 500));
await step("A speaks to B (ja/telegram)", () =>
  a.client.call("type", ["Want to get pizza on Tuesday? Bring Javed's dog."]),
);
await step("B plays messages", () => b.client.call("playMessages"));

const lastAudio = [...b.inbox].reverse().find((m) => m.type === "delivery");
if (lastAudio?.type === "delivery") {
  await step("B speaks (mp3 clip) to A", () => b.client.call("speak", [lastAudio.audio]));
}
const c = pickUp("C", { lang: "fr", mode: "gist", voice: "low" });
await new Promise((resolve) => setTimeout(resolve, 1500));
for (const cup of [a, b, c]) cup.client.close();
