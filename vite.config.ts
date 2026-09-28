import { cloudflare } from "@cloudflare/vite-plugin";
import agents from "agents/vite";
import { defineConfig } from "vite";

// agents(): transforms the @callable() decorators. cloudflare(): runs the Worker inside Vite's dev server.
export default defineConfig({
  plugins: [agents(), cloudflare()],
  // Bundle client dependencies once at startup. Discovering them during a page load raced with the
  // dev-server restarts the Cloudflare plugin does, and left the page waiting forever.
  optimizeDeps: { include: ["three", "gsap", "qrcode", "zod", "agents/client"] },
});
