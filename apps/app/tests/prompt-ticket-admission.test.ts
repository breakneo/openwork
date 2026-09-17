import { afterEach, expect, jest, test } from "bun:test";
import { createClient, readPromptAdmission, cancelPromptAdmission, PromptAdmissionUnknownError } from "../src/app/lib/opencode";
import { interruptSessionTurn } from "../src/app/lib/opencode-interruption";
import { PromptAdmissionLedger } from "../../server/src/prompt-admission";
import { withEngineDirectoryFence } from "../../server/src/engine-directory-fence";
import type { ServerConfig, WorkspaceInfo } from "../../server/src/types";
import { claimQueuedSend, dispatchQueuedDrain, getQueuedDrainState, resetQueuedDrainForTests, type QueuedDrainEvent } from "../src/react-app/domains/session/surface/queued-drain-machine";

const originalFetch = globalThis.fetch;
const originalWindow = globalThis.window;
let fixtureID = 0;
afterEach(() => {
  jest.useRealTimers();
  resetQueuedDrainForTests();
  Object.defineProperty(globalThis, "fetch", { configurable: true, value: originalFetch });
  Object.defineProperty(globalThis, "window", { configurable: true, value: originalWindow });
});

function gate() {
  let release = () => {};
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}

function setup(options: { legacy?: boolean; loseResponse?: boolean; held?: boolean; prepareStatus?: number; dispatchStatus?: number } = {}) {
  Object.defineProperty(globalThis, "window", { configurable: true, value: undefined });
  const workspace: WorkspaceInfo = { id: "ws_test", name: "Test", path: "/tmp/prompt-admission", preset: "starter", workspaceType: "local" };
  const config: ServerConfig = {
    host: "127.0.0.1", port: 0, token: "test", hostToken: "host", approval: { mode: "auto", timeoutMs: 1000 },
    corsOrigins: ["*"], workspaces: [workspace], authorizedRoots: [workspace.path], readOnly: false,
    startedAt: Date.now(), tokenSource: "cli", hostTokenSource: "cli", logFormat: "pretty", logRequests: false,
  };
  const ledger = new PromptAdmissionLedger();
  const scope = { credential: "test", workspace: workspace.id, session: "ses_test" };
  const held = gate();
  const entered = gate();
  const fence = options.held ? withEngineDirectoryFence(config, workspace, () => held.promise) : Promise.resolve();
  const requests: Request[] = [];
  let forwarded = 0;
  let aborted = 0;
  const controls = { prepareStatus: options.prepareStatus ?? 0, dispatchStatus: options.dispatchStatus ?? 0 };
  const fetchImpl: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    requests.push(request);
    const path = new URL(request.url).pathname;
    if (path.endsWith("/prompt-admission")) {
      if (controls.prepareStatus) return Response.json({ code: "prepare_denied", message: "No dispatch" }, { status: controls.prepareStatus });
      return options.legacy ? new Response(null, { status: 404 }) : ledger.prepare(scope, await request.text());
    }
    if (path.includes("/prompt-admission/")) return options.legacy ? new Response(null, { status: 404 })
      : ledger.inspect(scope, decodeURIComponent(path.split("/").at(-1) ?? ""), request.method === "DELETE");
    if (path.endsWith("/prompt_async")) {
      const body = await request.text();
      entered.release();
      const forward = async () => { forwarded++; return new Response(null, { status: 204 }); };
      const schedule = (operation: () => Promise<Response>) => withEngineDirectoryFence(config, workspace, operation);
      // Deliberately ignore browser abort, as the server POST does today.
      const ticket = request.headers.get("x-openwork-prompt-ticket");
      if (controls.dispatchStatus && ticket) {
        ledger.rejectQueued(scope, ticket, body);
        return Response.json({ code: "policy_denied", message: "Policy changed after preparation" }, { status: controls.dispatchStatus });
      }
      const result = ticket ? await ledger.dispatch(scope, ticket, body, schedule, forward) : await schedule(forward);
      if (options.loseResponse) throw new TypeError("Browser lost the accepted response");
      return result;
    }
    if (path.endsWith("/message/msg_test")) return new Response(null, { status: 404 });
    if (path.endsWith("/message") || path.endsWith("/permission") || path.endsWith("/question")) return Response.json([]);
    if (path.endsWith("/status")) return Response.json({});
    if (path.endsWith("/abort")) { aborted++; return Response.json(true); }
    if (path.endsWith("/ses_test")) return Response.json({ id: "ses_test", directory: workspace.path, time: { created: 1, updated: 1 } });
    throw new Error(`Unexpected request ${request.method} ${path}`);
  };
  Object.defineProperty(globalThis, "fetch", { configurable: true, value: fetchImpl });
  const baseUrl = `http://openwork-${++fixtureID}.test/workspace/ws_test/opencode`;
  const client = createClient(baseUrl, undefined, { mode: "openwork", token: "test" });
  const parameters = { sessionID: "ses_test", messageID: "msg_test", parts: [{ type: "text", text: "hello" }] } satisfies Parameters<typeof client.session.promptAsync>[0];
  return { client, parameters, baseUrl, controls, entered: entered.promise, requests, forwarded: () => forwarded, aborted: () => aborted,
    release: async () => { held.release(); await fence; for (let i = 0; i < 30; i++) await Promise.resolve(); } };
}

test("30-second client timeout behind the real directory fence stays unknown, then late dispatch is accepted exactly once", async () => {
  jest.useFakeTimers();
  const fixture = setup({ held: true });
  const result = fixture.client.session.promptAsync(fixture.parameters).catch((error: unknown) => error);
  await fixture.entered;
  jest.advanceTimersByTime(30_001);
  expect(await result).toBeInstanceOf(PromptAdmissionUnknownError);
  expect(fixture.forwarded()).toBe(0);
  expect(await readPromptAdmission(fixture.client, "ses_test", "msg_test")).toBe("unknown");
  await fixture.release();
  expect(await readPromptAdmission(fixture.client, "ses_test", "msg_test")).toBe("accepted");
  expect(fixture.forwarded()).toBe(1);
  expect(fixture.requests.filter((request) => request.url.endsWith("/prompt_async"))).toHaveLength(1);
});

test("existing Stop cancels the queued ticket, and the original fence closure cannot dispatch later", async () => {
  jest.useFakeTimers();
  const fixture = setup({ held: true });
  const result = fixture.client.session.promptAsync(fixture.parameters).catch((error: unknown) => error);
  await fixture.entered;
  jest.advanceTimersByTime(30_001);
  expect(await result).toBeInstanceOf(PromptAdmissionUnknownError);
  resetQueuedDrainForTests();
  expect(claimQueuedSend("ses_test", "held_item")).toBe(true);
  dispatchQueuedDrain("ses_test", { type: "send_unknown", itemId: "held_item", messageID: "msg_test", at: Date.now() });
  dispatchQueuedDrain("ses_test", { type: "stop_confirmed", admission: { itemId: "held_item", messageID: "wrong_message", state: "cancelled" } });
  expect(getQueuedDrainState("ses_test").phase.kind).toBe("admission_unknown");
  let stopEvent: QueuedDrainEvent | undefined;
  await interruptSessionTurn(fixture.baseUrl, fixture.client, "ses_test", undefined, {
    admissionUnknown: true, admissionMessageID: "msg_test",
    onStopped: (admission) => {
      stopEvent = { type: "stop_confirmed", admission: admission ? { ...admission, itemId: "held_item" } : undefined };
      dispatchQueuedDrain("ses_test", stopEvent);
    },
  });
  // No probe timer, history read or user retry releases this held queue slot.
  expect(getQueuedDrainState("ses_test").phase.kind).toBe("ready");
  expect(stopEvent).toMatchObject({ admission: { messageID: "msg_test", state: "cancelled" } });
  expect(await readPromptAdmission(fixture.client, "ses_test", "msg_test")).toBe("absent");
  await fixture.release();
  expect(fixture.forwarded()).toBe(0);
  expect(fixture.aborted()).toBeGreaterThan(0);
  expect(claimQueuedSend("ses_test", "successor")).toBe(true);
  const successor = getQueuedDrainState("ses_test");
  if (!stopEvent) throw new Error("Missing exact Stop confirmation");
  dispatchQueuedDrain("ses_test", stopEvent);
  expect(getQueuedDrainState("ses_test")).toBe(successor);
  await fixture.client.session.promptAsync({ ...fixture.parameters, messageID: "msg_successor" });
  expect(fixture.forwarded()).toBe(1);
  dispatchQueuedDrain("ses_test", { type: "send_result", itemId: "successor", outcome: "sent", at: Date.now() });
  const admitted = getQueuedDrainState("ses_test");
  dispatchQueuedDrain("ses_test", stopEvent);
  expect(getQueuedDrainState("ses_test")).toBe(admitted);
});

test("an accepted response lost to the browser is reconciled from the ledger, without another POST", async () => {
  const fixture = setup({ loseResponse: true });
  expect((await fixture.client.session.promptAsync(fixture.parameters)).data).toEqual({});
  expect(await readPromptAdmission(fixture.client, "ses_test", "msg_test")).toBe("accepted");
  await expect(fixture.client.session.promptAsync(fixture.parameters)).rejects.toBeInstanceOf(PromptAdmissionUnknownError);
  expect(fixture.forwarded()).toBe(1);
});

test("unsupported prepare falls back once; absent idle history cannot reject the legacy delayed POST", async () => {
  jest.useFakeTimers();
  const fixture = setup({ legacy: true, held: true });
  const result = fixture.client.session.promptAsync(fixture.parameters).catch((error: unknown) => error);
  await fixture.entered;
  jest.advanceTimersByTime(30_001);
  expect(await result).toBeInstanceOf(PromptAdmissionUnknownError);
  expect(await readPromptAdmission(fixture.client, "ses_test", "msg_test")).toBe("unknown");
  expect(await cancelPromptAdmission(fixture.client, "ses_test", "msg_test")).toBe("unknown");
  await fixture.release();
  expect(fixture.forwarded()).toBe(1);
});

test("conflicting preparation cannot borrow a previous payload's engine acceptance", async () => {
  const fixture = setup();
  await fixture.client.session.promptAsync(fixture.parameters);
  const recreated = createClient(fixture.baseUrl, undefined, { mode: "openwork", token: "test" });
  await expect(recreated.session.promptAsync({ ...fixture.parameters, parts: [{ type: "text", text: "different" }] })).rejects.toBeInstanceOf(PromptAdmissionUnknownError);
  expect(fixture.forwarded()).toBe(1);
});

test("direct-engine missing history remains unknown and never probes the ticket API", async () => {
  const fixture = setup();
  const direct = createClient("http://engine.test");
  expect(await readPromptAdmission(direct, "ses_test", "msg_test")).toBe("unknown");
  expect(fixture.requests.some((request) => request.url.includes("prompt-admission"))).toBe(false);
});

test("a prepare response arriving after the client deadline cannot trigger a late dispatch", async () => {
  jest.useFakeTimers();
  const fixture = setup();
  const prepare = gate();
  const entered = gate();
  const underlying = globalThis.fetch;
  const fetchImpl: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    if (new URL(request.url).pathname.endsWith("/prompt-admission")) {
      entered.release();
      await prepare.promise; // Ignore AbortSignal, like a stalled IPC transport.
    }
    return underlying(input, init);
  };
  Object.defineProperty(globalThis, "fetch", { configurable: true, value: fetchImpl });
  const result = fixture.client.session.promptAsync(fixture.parameters).catch((error: unknown) => error);
  await entered.promise;
  jest.advanceTimersByTime(30_001);
  expect(await result).toBeInstanceOf(PromptAdmissionUnknownError);
  prepare.release();
  for (let i = 0; i < 30; i++) await Promise.resolve();
  expect(fixture.forwarded()).toBe(0);
  expect(fixture.requests.some((request) => request.url.endsWith("/prompt_async"))).toBe(false);
});

test.each([400, 401, 403])("prepare %s is a definite rejection and permits an explicit retry without an automatic POST", async (status) => {
  const fixture = setup({ prepareStatus: status });
  expect((await fixture.client.session.promptAsync(fixture.parameters)).error).toEqual({ code: "prepare_denied", message: "No dispatch" });
  expect(fixture.forwarded()).toBe(0);
  expect(fixture.requests).toHaveLength(1);
  fixture.controls.prepareStatus = 0;
  expect((await fixture.client.session.promptAsync(fixture.parameters)).data).toEqual({});
  expect(fixture.forwarded()).toBe(1);
});

test("prepare authorization failures preserve throwOnError without claiming uncertain admission", async () => {
  const fixture = setup({ prepareStatus: 403 });
  await expect(fixture.client.session.promptAsync(fixture.parameters, { throwOnError: true })).rejects.toMatchObject({ code: "prepare_denied" });
  expect(fixture.forwarded()).toBe(0);
  fixture.controls.prepareStatus = 0;
  expect((await fixture.client.session.promptAsync(fixture.parameters)).data).toEqual({});
});

test("policy denial after preparation is authoritative rejection, not a permanently queued ticket", async () => {
  const fixture = setup({ dispatchStatus: 403 });
  expect((await fixture.client.session.promptAsync(fixture.parameters)).error).toMatchObject({ code: "policy_denied" });
  expect(await readPromptAdmission(fixture.client, "ses_test", "msg_test")).toBe("absent");
  expect(fixture.forwarded()).toBe(0);
  fixture.controls.dispatchStatus = 0;
  await fixture.client.session.promptAsync({ ...fixture.parameters, messageID: "msg_explicit_retry" });
  expect(fixture.forwarded()).toBe(1);
});

test("more than 4096 legacy prepares never impose a lifetime quota, while replay stays blocked across clients", async () => {
  const fixture = setup({ legacy: true });
  for (let i = 0; i < 4100; i++) {
    const client = i % 2 ? fixture.client : createClient(fixture.baseUrl, undefined, { mode: "openwork", token: "test" });
    expect((await client.session.promptAsync({ ...fixture.parameters, messageID: `msg_lifetime_${i}` })).data).toEqual({});
  }
  expect(fixture.forwarded()).toBe(4100);
  const recreated = createClient(fixture.baseUrl, undefined, { mode: "openwork", token: "test" });
  await expect(recreated.session.promptAsync({ ...fixture.parameters, messageID: "msg_lifetime_0" })).rejects.toBeInstanceOf(PromptAdmissionUnknownError);
  expect(fixture.forwarded()).toBe(4100);
}, 30_000);
