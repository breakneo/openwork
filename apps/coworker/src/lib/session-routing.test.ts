import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import type { NativeV2CatalogModel, NativeV2Session } from "@openwork/headless-threads/v2";
import { configureCoworkerSessionAccess, sessionRouting, type CoworkerSessionAccess, type SessionOwner } from "./session-routing.ts";
import { createCoworkerThreads, WORKSPACE_STARTUP_TIMEOUT_MS } from "./threads.ts";

function catalogRoutingFixture(t: TestContext) {
  const owner = { slug: "alpha", createdAt: "original" };
  const state = { workspaceId: "ws_team" };
  const directories = new Map([["ws_original", "/original/alpha"], ["ws_team", "/team/.runtime"], ["ws_next_team", "/next-team/.runtime"]]);
  const reads: { path: string; directory: string; signal: AbortSignal }[] = [];
  const model: NativeV2CatalogModel = { providerID: "fixture", id: "model", modelID: "model", name: "Fixture model", enabled: true, status: "active", capabilities: { tools: true, input: ["text"], output: ["text"] }, variants: [], time: { released: 0 }, cost: [{ input: 1, output: 1 }], limit: { context: 1000, output: 100 } };
  const session: NativeV2Session = { id: "ses_old", location: { directory: "/original/alpha" }, projectID: "fixture", model, agent: "build", cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, time: { created: 1, updated: 2 } };
  const replies = new Map<string, unknown>([
    ["provider", { data: [{ id: "fixture", name: "Fixture", activation: "enabled", package: "fixture" }] }],
    ["model", { data: [model] }],
    ["integration", { data: [] }],
    ["model/default", { data: model }],
    ["skill", { data: [] }],
    ["session/ses_old", { data: session }],
    ["session/ses_old/message", { data: [], cursor: { previous: null, next: null } }],
    ["session/ses_old/inbox", { data: [] }],
    ["session/active", { data: {} }],
  ]);
  const timeouts = t.mock.method(AbortSignal, "timeout");
  t.mock.method(globalThis, "fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    assert.equal(init?.method ?? "GET", "GET");
    if (url.pathname === "/cloud-provider-sync/status") return Response.json({ hasSession: false, lastRun: null, providers: [], reloadPending: false, skippedProviders: [] });
    const match = /^\/workspace\/([^/]+)\/opencode2\/api\/(.+)$/.exec(url.pathname);
    assert.ok(match?.[1] && match[2], `Unexpected route: ${url.pathname}`);
    const directory = directories.get(decodeURIComponent(match[1]));
    assert.ok(directory);
    assert.ok(init?.signal);
    assert.equal(new Headers(init.headers).get("Authorization"), "Bearer synthetic");
    reads.push({ path: `${url.pathname}${url.search}`, directory, signal: init.signal });
    if (match[2].startsWith("agent/")) return Response.json({ data: { id: decodeURIComponent(match[2].slice("agent/".length)), permissions: [] } });
    assert.ok(replies.has(match[2]), `Unexpected API route: ${match[2]}`);
    return Response.json(replies.get(match[2]));
  });
  const access = {
    workspace: () => state.workspaceId,
    apiContract: () => "native-2",
    binding: t.mock.fn(async (requested: SessionOwner, sessionId: string) => {
      assert.deepEqual(requested, owner);
      if (sessionId !== "ses_old") throw new Error("No host owner");
      return { ...owner, sessionId, workspaceId: "ws_original", nativeWorkspaceId: "ws_original", directory: "/original/alpha", kind: "private" };
    }),
    list: t.mock.fn(async () => []),
    active: t.mock.fn(async () => ({})),
    create: t.mock.fn(async () => { throw new Error("This fixture must not create a session"); }),
  } satisfies CoworkerSessionAccess;
  configureCoworkerSessionAccess(access);
  t.after(() => configureCoworkerSessionAccess(undefined));
  return { owner, state, reads, timeouts, access };
}

test("background activity leaves legacy locations dormant until history is requested", async (t) => {
  t.mock.method(globalThis, "fetch", () => { throw new Error("No native location should be contacted by this fixture"); });
  const historyReads: boolean[] = [];
  configureCoworkerSessionAccess({
    workspace: () => "ws_team",
    list: async (_owner, includeLegacy = false) => { historyReads.push(includeLegacy); return []; },
    active: async () => ({}),
    binding: async () => { throw new Error("No owned session in this fixture"); },
    create: async () => { throw new Error("This is observation only"); },
  });
  t.after(() => configureCoworkerSessionAccess(undefined));
  const threads = createCoworkerThreads({ serverUrl: "http://127.0.0.1:8790", workspaceId: "ws_original", token: "synthetic", owner: { slug: "alpha", createdAt: "original" } });
  await threads.readActivity();
  await threads.listAllThreads(false);
  assert.deepEqual(historyReads, [false, false]);
  await threads.listAllThreads();
  assert.deepEqual(historyReads, [false, false, true]);
});

test("session reads follow host bindings while catalogs stay on the team location", async () => {
  const owner = { slug: "alpha", createdAt: "original" };
  const seen: string[] = [];
  const access: CoworkerSessionAccess = {
    workspace: () => "ws_team",
    binding: async (requested, sessionId) => {
      assert.deepEqual(requested, owner);
      if (sessionId !== "ses_old") throw new Error("No host owner");
      return { ...owner, sessionId, workspaceId: "ws_original", nativeWorkspaceId: "ws_original", directory: "/original/alpha", kind: "private" };
    },
    list: async () => [],
    create: async () => { throw new Error("Creation is a separate host operation"); },
  };
  const send = sessionRouting({ baseUrl: "http://127.0.0.1:8790", workspaceId: "ws_original", owner, access,
    fetch: async (url) => { seen.push(url); return Response.json({}); } });
  await send("http://127.0.0.1:8790/workspace/ws_original/opencode2/api/session/ses_old/message?limit=200");
  await send("http://127.0.0.1:8790/workspace/ws_original/opencode2/api/model");
  await send("http://127.0.0.1:8790/workspace/ws_original/opencode2/api/experimental/session/ses_old/wait", { method: "POST" });
  assert.deepEqual(seen, [
    "http://127.0.0.1:8790/workspace/ws_original/opencode2/api/session/ses_old/message?limit=200",
    "http://127.0.0.1:8790/workspace/ws_team/opencode2/api/model",
    "http://127.0.0.1:8790/workspace/ws_original/opencode2/api/experimental/session/ses_old/wait",
  ]);
  const list = await send("http://127.0.0.1:8790/workspace/ws_original/opencode2/api/session?limit=200");
  assert.deepEqual(await list.json(), { data: [], cursor: { next: null } });
  await assert.rejects(send("http://127.0.0.1:8790/workspace/ws_original/opencode2/api/session/ses_foreign/message"), /No host owner/);
  await assert.rejects(send("http://127.0.0.1:8790/workspace/ws_original/opencode2/api/session", { method: "POST", body: JSON.stringify({ metadata: { coworker: "alpha" } }) }), /host-owned creation/);
  await assert.rejects(send("http://127.0.0.1:8790/workspace/ws_other/opencode2/api/session/ses_old/message"), /native host/);
  await assert.rejects(send("http://127.0.0.1:8790/workspace/ws_original/opencode2/api/experimental/session/ses_foreign/wait", { method: "POST" }), /No host owner/);
  assert.equal(seen.length, 3);
});

test("legacy-owner preparation routes every metadata request to the team and keeps bound history on its original location", async (t) => {
  const { owner, state, reads, timeouts, access } = catalogRoutingFixture(t);
  const threads = createCoworkerThreads({ serverUrl: "http://127.0.0.1:8790", workspaceId: "ws_original", token: "synthetic", owner });
  const controller = new AbortController();
  await threads.prepare(controller.signal);
  assert.deepEqual(reads.map(({ path, directory }) => [path, directory]), [
    ["/workspace/ws_team/opencode2/api/agent/coworker-owner-alpha", "/team/.runtime"],
    ["/workspace/ws_team/opencode2/api/provider", "/team/.runtime"],
    ["/workspace/ws_team/opencode2/api/model", "/team/.runtime"],
    ["/workspace/ws_team/opencode2/api/integration", "/team/.runtime"],
    ["/workspace/ws_team/opencode2/api/model/default", "/team/.runtime"],
    ["/workspace/ws_team/opencode2/api/model/default", "/team/.runtime"],
  ]);
  assert.deepEqual(timeouts.mock.calls.map((call) => call.arguments[0]), [WORKSPACE_STARTUP_TIMEOUT_MS, WORKSPACE_STARTUP_TIMEOUT_MS, WORKSPACE_STARTUP_TIMEOUT_MS, WORKSPACE_STARTUP_TIMEOUT_MS, WORKSPACE_STARTUP_TIMEOUT_MS, 10_000, WORKSPACE_STARTUP_TIMEOUT_MS]);
  assert.equal(access.binding.mock.callCount(), 0);
  const reason = new Error("Preparation cancelled");
  controller.abort(reason);
  assert.ok(reads.every(({ signal }) => signal.aborted && signal.reason === reason));

  reads.length = 0;
  assert.deepEqual((await threads.listModelCatalog()).models.map((model) => model.id), ["fixture/model"]);
  await threads.listSkills();
  assert.deepEqual(reads.map(({ path, directory }) => [path, directory]), [
    ["/workspace/ws_team/opencode2/api/provider", "/team/.runtime"],
    ["/workspace/ws_team/opencode2/api/model", "/team/.runtime"],
    ["/workspace/ws_team/opencode2/api/integration", "/team/.runtime"],
    ["/workspace/ws_team/opencode2/api/model/default", "/team/.runtime"],
    ["/workspace/ws_team/opencode2/api/skill", "/team/.runtime"],
  ]);

  state.workspaceId = "";
  reads.length = 0;
  assert.equal((await threads.client.getThreadSnapshot("ses_old")).directory, "/original/alpha");
  assert.deepEqual(reads.map(({ path, directory }) => [path, directory]), [
    ["/workspace/ws_original/opencode2/api/session/ses_old", "/original/alpha"],
    ["/workspace/ws_original/opencode2/api/session/ses_old/message?limit=200&order=asc", "/original/alpha"],
    ["/workspace/ws_original/opencode2/api/session/ses_old/inbox", "/original/alpha"],
  ]);
  reads.length = 0;
  await assert.rejects(threads.client.getThreadSnapshot("ses_foreign"));
  assert.deepEqual(reads, []);
});

test("ownerless model catalogs keep the current team route and cancellation without guessing a session owner", async (t) => {
  const { state, reads, timeouts, access } = catalogRoutingFixture(t);
  const threads = createCoworkerThreads({ serverUrl: "http://127.0.0.1:8790", workspaceId: "ws_original", token: "synthetic" });
  state.workspaceId = "ws_next_team";
  const controller = new AbortController();
  assert.deepEqual((await threads.listModelCatalog(controller.signal)).models.map((model) => model.id), ["fixture/model"]);
  const expected = [
    ["/workspace/ws_next_team/opencode2/api/provider", "/next-team/.runtime"],
    ["/workspace/ws_next_team/opencode2/api/model", "/next-team/.runtime"],
    ["/workspace/ws_next_team/opencode2/api/integration", "/next-team/.runtime"],
    ["/workspace/ws_next_team/opencode2/api/model/default", "/next-team/.runtime"],
  ];
  assert.deepEqual(reads.map(({ path, directory }) => [path, directory]), expected);
  assert.deepEqual(timeouts.mock.calls.map((call) => call.arguments[0]), [WORKSPACE_STARTUP_TIMEOUT_MS, WORKSPACE_STARTUP_TIMEOUT_MS, WORKSPACE_STARTUP_TIMEOUT_MS, WORKSPACE_STARTUP_TIMEOUT_MS, 10_000]);
  const reason = new Error("Catalog cancelled");
  controller.abort(reason);
  assert.ok(reads.every(({ signal }) => signal.aborted && signal.reason === reason));
  reads.length = 0;
  await threads.listModels();
  assert.deepEqual(reads.map(({ path, directory }) => [path, directory]), expected);
  assert.deepEqual([access.binding, access.list, access.active, access.create].map((method) => method.mock.callCount()), [0, 0, 0, 0]);

  state.workspaceId = "";
  reads.length = 0;
  await assert.rejects(threads.listModelCatalog(new AbortController().signal));
  assert.deepEqual(reads, []);
  assert.equal((await threads.client.getThreadSnapshot("ses_old")).directory, "/original/alpha");
  assert.deepEqual(reads.map(({ path, directory }) => [path, directory]), [
    ["/workspace/ws_original/opencode2/api/session/ses_old", "/original/alpha"],
    ["/workspace/ws_original/opencode2/api/session/ses_old/message?limit=200&order=asc", "/original/alpha"],
    ["/workspace/ws_original/opencode2/api/session/ses_old/inbox", "/original/alpha"],
    ["/workspace/ws_original/opencode2/api/session/active", "/original/alpha"],
  ]);
  assert.deepEqual([access.binding, access.list, access.active, access.create].map((method) => method.mock.callCount()), [0, 0, 0, 0]);
});

test("standalone preparation retains its supplied workspace and beta build-agent behavior", async (t) => {
  const { reads } = catalogRoutingFixture(t);
  configureCoworkerSessionAccess(undefined);
  const threads = createCoworkerThreads({ serverUrl: "http://127.0.0.1:8790", workspaceId: "ws_original", token: "synthetic" });
  await threads.prepare(new AbortController().signal);
  assert.deepEqual(reads.map(({ path, directory }) => [path, directory]), [
    ["/workspace/ws_original/opencode2/api/agent/build", "/original/alpha"],
    ["/workspace/ws_original/opencode2/api/provider", "/original/alpha"],
    ["/workspace/ws_original/opencode2/api/model", "/original/alpha"],
    ["/workspace/ws_original/opencode2/api/integration", "/original/alpha"],
    ["/workspace/ws_original/opencode2/api/model/default", "/original/alpha"],
    ["/workspace/ws_original/opencode2/api/model/default", "/original/alpha"],
  ]);
});
