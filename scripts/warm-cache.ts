// Pre-renders the pinned message in every language and mode, so each visitor's first message is
// instant and free. Run after deploying, and again whenever PINNED_MESSAGE changes (~650 neurons).
// Usage: node scripts/warm-cache.ts [host]
import { AgentClient } from "agents/client";
import { LANGUAGES, MODES } from "../shared/protocol.ts";

const host = process.argv[2] ?? "cupline.jaeaeich.com";
const cup = new AgentClient({ agent: "StringAgent", name: "main", host });
await cup.ready;

for (const lang of LANGUAGES) {
  for (const mode of MODES) {
    const start = Date.now();
    const heard = new Promise<{ ms: { llm: number } }>((resolve) => {
      const onMessage = (event: MessageEvent) => {
        const message = JSON.parse(String(event.data));
        if (message.type !== "delivery") return;
        cup.removeEventListener("message", onMessage);
        resolve(message);
      };
      cup.addEventListener("message", onMessage);
    });
    await cup.call("setPrefs", [{ lang, mode, voice: "mid" }]);
    await cup.call("playMessages", [1], { timeout: 60_000 });
    const { ms } = await heard;
    console.log(`${lang} ${mode.padEnd(8)} ${ms.llm ? "rendered" : "cached  "} ${Date.now() - start} ms`);
  }
}
cup.close();
