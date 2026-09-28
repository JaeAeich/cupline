import { defineConfig } from "vitest/config";

// Unit tests run in plain Node: the AI adapter takes the binding as a parameter, so a fake stands in.
// The full path through real Workers AI is covered by `node scripts/smoke.ts` against `npm run dev`.
export default defineConfig({ test: { include: ["test/**/*.test.ts"] } });
