// Worker entry: static assets are served by the platform; this only handles strings and admin.
import { getAgentByName, routeAgentRequest } from "agents";

import { PLACE_HEADERS } from "./string-agent";

export { StringAgent } from "./string-agent";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/admin/purge") return purge(request, env, url);

    const response = await routeAgentRequest(request, env, { onBeforeConnect: beforeConnect });
    return response ?? new Response("Not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;

/**
 * Other websites must not be able to spend this app's AI budget through our sockets.
 * Everyone else is let through, carrying the approximate place Cloudflare derives from their IP,
 * so the string can tell how long it is. Headers a client tries to send itself are dropped.
 */
function beforeConnect(request: Request): Request | Response {
  const origin = request.headers.get("Origin");
  if (origin && new URL(origin).host !== new URL(request.url).host) {
    return new Response("Forbidden", { status: 403 });
  }
  const headers = new Headers(request.headers);
  headers.delete(PLACE_HEADERS.lat);
  headers.delete(PLACE_HEADERS.lon);
  const { latitude, longitude } = request.cf ?? {};
  if (typeof latitude === "string" && typeof longitude === "string") {
    headers.set(PLACE_HEADERS.lat, latitude);
    headers.set(PLACE_HEADERS.lon, longitude);
  }
  return new Request(request, { headers });
}

/** POST /admin/purge?string=main with `Authorization: Bearer <ADMIN_TOKEN>` deletes left messages. */
async function purge(request: Request, env: Env, url: URL): Promise<Response> {
  const authorized = env.ADMIN_TOKEN && request.headers.get("Authorization") === `Bearer ${env.ADMIN_TOKEN}`;
  if (request.method !== "POST" || !authorized) return new Response("Forbidden", { status: 403 });

  const string = await getAgentByName(env.StringAgent, url.searchParams.get("string") ?? "main");
  await string.purgeMessages();
  return new Response("Purged");
}
