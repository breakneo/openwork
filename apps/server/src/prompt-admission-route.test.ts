import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer } from "./server.js";
import { withEngineDirectoryFence } from "./engine-directory-fence.js";
import type { ServerConfig, WorkspaceInfo } from "./types.js";

test("workspace ticket routes require authorization, cancel held dispatch, and preserve unticketed native forwarding", async () => {
  const root = await mkdtemp(join(tmpdir(), "openwork-prompt-ticket-"));
  let forwarded = 0;
  let leakedTicket = false;
  const engine = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    const path = new URL(request.url).pathname;
    if (path.endsWith("/prompt_async")) {
      forwarded++;
      leakedTicket = request.headers.has("x-openwork-prompt-ticket");
      return new Response(null, { status: 204 });
    }
    if (path === "/session" || path.endsWith("/message") || path === "/permission" || path === "/question") return Response.json([]);
    return Response.json({});
  } });
  const workspace: WorkspaceInfo = { id: "ws_ticket", name: "Ticket test", path: root, preset: "starter", workspaceType: "local", baseUrl: engine.url.toString() };
  const config: ServerConfig = {
    host: "127.0.0.1", port: 0, token: "owt_test_ticket", hostToken: "owt_host_ticket", configPath: join(root, "server.json"),
    approval: { mode: "auto", timeoutMs: 1000 }, corsOrigins: ["*"], workspaces: [workspace], authorizedRoots: [root], readOnly: false,
    startedAt: Date.now(), tokenSource: "cli", hostTokenSource: "cli", logFormat: "pretty", logRequests: false,
  };
  let server: Awaited<ReturnType<typeof startServer>> | undefined;
  let release = () => {};
  let held: Promise<void> | undefined;
  try {
    server = await startServer(config);
    const base = `http://127.0.0.1:${server.port}/workspace/${workspace.id}/opencode/session/ses_ticket`;
    const headers = { Authorization: `Bearer ${config.token}`, "Content-Type": "application/json" };
    const body = JSON.stringify({ messageID: "msg_ticket", parts: [{ type: "text", text: "hello" }] });
    expect((await fetch(`${base}/prompt-admission`, { method: "POST", body })).status).toBe(401);
    expect((await fetch(`${base}/prompt-admission/msg_ticket`)).status).toBe(401);
    const prepared = await fetch(`${base}/prompt-admission`, { method: "POST", headers, body });
    expect(prepared.status).toBe(200);
    const value: unknown = await prepared.json();
    if (!value || typeof value !== "object" || !("ticket" in value) || typeof value.ticket !== "string") throw new Error("Missing ticket");
    const ticket = value.ticket;
    expect(forwarded).toBe(0);
    held = withEngineDirectoryFence(config, workspace, () => new Promise<void>((resolve) => { release = resolve; }));
    await Promise.resolve();
    const original = fetch(`${base}/prompt_async`, { method: "POST", headers: { ...headers, "x-openwork-prompt-ticket": ticket }, body });
    // Cancellation is safe both before and after the dispatch request arrives.
    expect(await (await fetch(`${base}/prompt-admission/msg_ticket`, { method: "DELETE", headers })).json()).toMatchObject({ state: "cancelled" });
    expect((await original).status).toBe(409);
    release();
    await held;
    expect(forwarded).toBe(0);
    const deniedBody = JSON.stringify({ messageID: "msg_policy", parts: [] });
    const denied: unknown = await (await fetch(`${base}/prompt-admission`, { method: "POST", headers, body: deniedBody })).json();
    if (!denied || typeof denied !== "object" || !("ticket" in denied) || typeof denied.ticket !== "string") throw new Error("Missing policy-test ticket");
    // A server write policy can change between preparation and dispatch.
    config.readOnly = true;
    expect((await fetch(`${base}/prompt_async`, { method: "POST", headers: { ...headers, "x-openwork-prompt-ticket": denied.ticket }, body: deniedBody })).status).toBe(403);
    expect(await (await fetch(`${base}/prompt-admission/msg_policy`, { headers })).json()).toMatchObject({ state: "rejected" });
    config.readOnly = false;
    expect((await fetch(`${base}/prompt_async`, { method: "POST", headers: { ...headers, "x-openwork-prompt-ticket": denied.ticket }, body: deniedBody })).status).toBe(409);
    expect(forwarded).toBe(0);
    expect((await fetch(`${base}/prompt_async`, { method: "POST", headers, body: JSON.stringify({ messageID: "msg_legacy", parts: [] }) })).status).toBe(204);
    expect(forwarded).toBe(1);
    expect(leakedTicket).toBe(false);
    await server.stop();
    config.port = 0;
    server = await startServer(config);
    const restarted = `http://127.0.0.1:${server.port}/workspace/${workspace.id}/opencode/session/ses_ticket`;
    expect(await (await fetch(`${restarted}/prompt-admission/msg_ticket`, { headers })).json()).toMatchObject({ state: "unknown" });
    expect((await fetch(`${restarted}/prompt_async`, { method: "POST", headers: { ...headers, "x-openwork-prompt-ticket": ticket }, body })).status).toBe(409);
    expect(forwarded).toBe(1);
  } finally {
    release();
    await held;
    await server?.stop();
    engine.stop(true);
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);
