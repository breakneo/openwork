import { describe, expect, test } from "bun:test";
import { PromptAdmissionLedger, type PromptAdmissionScope } from "./prompt-admission.js";

const scope: PromptAdmissionScope = { credential: "credential-a", workspace: "workspace-a", session: "session-a" };
const body = JSON.stringify({ messageID: "msg_one", parts: [{ type: "text", text: "hello" }] });
const immediate = (operation: () => Promise<Response>) => operation();
async function ticket(ledger: PromptAdmissionLedger, payload = body) {
  const value: unknown = await ledger.prepare(scope, payload).json();
  if (!value || typeof value !== "object" || !("ticket" in value) || typeof value.ticket !== "string") throw new Error("Expected ticket");
  return value.ticket;
}
function gate() {
  let release = () => {};
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}

describe("ticketed prompt admission", () => {
  test("queued cancellation invalidates the already scheduled original operation", async () => {
    const ledger = new PromptAdmissionLedger();
    const id = await ticket(ledger);
    const held = gate();
    let forwards = 0;
    const forward = async () => { forwards++; return new Response(null, { status: 204 }); };
    const scheduled = ledger.dispatch(scope, id, body, async (operation) => { await held.promise; return operation(); }, forward);
    expect(await ledger.inspect(scope, "msg_one").json()).toMatchObject({ state: "queued" });
    expect((await ledger.dispatch(scope, id, body, immediate, forward)).status).toBe(409);
    expect(await ledger.inspect(scope, "msg_one", true).json()).toMatchObject({ state: "cancelled" });
    expect(await (await scheduled).json()).toMatchObject({ state: "cancelled" });
    held.release();
    await Promise.resolve();
    expect((await ledger.dispatch(scope, id, body, immediate, forward)).status).toBe(409);
    expect(forwards).toBe(0);
  });

  test("forwarding cannot be cancelled or duplicated; accepted status survives response loss", async () => {
    const ledger = new PromptAdmissionLedger();
    const id = await ticket(ledger);
    const held = gate();
    let forwards = 0;
    const forward = async () => { forwards++; await held.promise; return new Response(null, { status: 204 }); };
    const original = ledger.dispatch(scope, id, body, immediate, forward);
    expect(await ledger.inspect(scope, "msg_one", true).json()).toMatchObject({ state: "forwarding" });
    expect((await ledger.dispatch(scope, id, body, immediate, forward)).status).toBe(409);
    held.release();
    await original; // The browser never receives this response.
    expect(await ledger.inspect(scope, "msg_one").json()).toMatchObject({ state: "accepted" });
    expect((await ledger.dispatch(scope, id, body, immediate, forward)).status).toBe(204);
    expect(forwards).toBe(1);
  });

  test("credential, workspace, session, ticket, and exact payload are isolated", async () => {
    const ledger = new PromptAdmissionLedger();
    const id = await ticket(ledger);
    let forwards = 0;
    const forward = async () => { forwards++; return new Response(null, { status: 204 }); };
    for (const foreign of [{ ...scope, credential: "other" }, { ...scope, workspace: "other" }, { ...scope, session: "other" }]) {
      expect(await ledger.inspect(foreign, "msg_one", true).json()).toMatchObject({ state: "unknown" });
      expect(await (await ledger.dispatch(foreign, id, body, immediate, forward)).json()).toMatchObject({ state: "unknown" });
    }
    const changed = JSON.stringify({ messageID: "msg_one", parts: [] });
    expect(ledger.prepare(scope, changed).status).toBe(409);
    expect((await ledger.dispatch(scope, id, changed, immediate, forward)).status).toBe(409);
    expect((await ledger.dispatch(scope, "invalid", body, immediate, forward)).status).toBe(409);
    expect(await ticket(ledger)).toBe(id);
    expect(forwards).toBe(0);
  });

  test("expiry, capacity and restart never turn missing knowledge into a new dispatch", async () => {
    let now = 0;
    const ledger = new PromptAdmissionLedger(1, 100, () => now);
    const id = await ticket(ledger);
    const held = gate();
    let forwards = 0;
    const forward = async () => { forwards++; return new Response(null, { status: 204 }); };
    const original = ledger.dispatch(scope, id, body, async (operation) => { await held.promise; return operation(); }, forward);
    now = 101;
    expect(await ledger.inspect(scope, "msg_one").json()).toMatchObject({ state: "unknown" });
    expect(ledger.prepare(scope, body).status).toBe(410);
    expect(ledger.prepare(scope, JSON.stringify({ messageID: "msg_two" })).status).toBe(200);
    expect(await (await ledger.dispatch(scope, id, body, immediate, forward)).json()).toMatchObject({ state: "unknown" });
    held.release();
    expect(await (await original).json()).toMatchObject({ state: "unknown" });
    const restarted = new PromptAdmissionLedger();
    expect(await restarted.inspect(scope, "msg_one").json()).toMatchObject({ state: "unknown" });
    expect(await (await restarted.dispatch(scope, id, body, immediate, forward)).json()).toMatchObject({ state: "unknown" });
    expect(forwards).toBe(0);
  });

  test("only engine success is accepted; transport and server failures stay unknown", async () => {
    for (const status of [204, 400, 408, 500]) {
      const ledger = new PromptAdmissionLedger();
      await ledger.dispatch(scope, await ticket(ledger), body, immediate, async () => new Response(null, { status }));
      expect(await ledger.inspect(scope, "msg_one").json()).toMatchObject({ state: status === 204 ? "accepted" : status === 400 ? "rejected" : "unknown" });
    }
    const ledger = new PromptAdmissionLedger();
    await expect(ledger.dispatch(scope, await ticket(ledger), body, immediate, async () => { throw new Error("lost upstream response"); })).rejects.toThrow();
    expect(await ledger.inspect(scope, "msg_one").json()).toMatchObject({ state: "unknown" });
  });

  test("server shutdown retires queued callbacks even if their directory fence later releases", async () => {
    const ledger = new PromptAdmissionLedger();
    const held = gate();
    let forwards = 0;
    const original = ledger.dispatch(scope, await ticket(ledger), body, async (operation) => { await held.promise; return operation(); },
      async () => { forwards++; return new Response(null, { status: 204 }); });
    ledger.close();
    await original;
    held.release();
    await Promise.resolve();
    expect(forwards).toBe(0);
    expect(ledger.prepare(scope, body).status).toBe(503);
    expect(await ledger.inspect(scope, "msg_one").json()).toMatchObject({ state: "unknown" });
  });

  test("finalized slots are reusable without making retired tickets dispatchable", async () => {
    const ledger = new PromptAdmissionLedger(2);
    const first = await ticket(ledger);
    let forwarded = 0;
    const forward = async () => { forwarded++; return new Response(null, { status: 204 }); };
    await ledger.dispatch(scope, first, body, immediate, forward);
    for (let i = 0; i < 20; i++) {
      const payload = JSON.stringify({ messageID: `msg_${i}` });
      await ledger.dispatch(scope, await ticket(ledger, payload), payload, immediate, forward);
    }
    expect(forwarded).toBe(21);
    expect(await ledger.inspect(scope, "msg_one").json()).toMatchObject({ state: "unknown" });
    expect(await (await ledger.dispatch(scope, first, body, immediate, forward)).json()).toMatchObject({ state: "unknown" });
    // Explicit new preparation is outside a retired ticket's dedupe guarantee.
    // OpenWork's once-only identity guard must never do this for a prior send.
    expect(await ticket(ledger)).not.toBe(first);
    expect((await ledger.dispatch(scope, first, body, immediate, forward)).status).toBe(409);
    expect(forwarded).toBe(21);
  });

  test("uncertain entries are retained until expiry without permanently exhausting capacity", async () => {
    let now = 0;
    const ledger = new PromptAdmissionLedger(1, 100, () => now);
    const first = await ticket(ledger);
    await ledger.dispatch(scope, first, body, immediate, async () => new Response(null, { status: 503 }));
    expect(ledger.prepare(scope, JSON.stringify({ messageID: "msg_new" })).status).toBe(503);
    now = 101;
    expect(ledger.prepare(scope, JSON.stringify({ messageID: "msg_new" })).status).toBe(200);
    let forwarded = false;
    expect((await ledger.dispatch(scope, first, body, immediate, async () => { forwarded = true; return new Response(); })).status).toBe(409);
    expect(forwarded).toBe(false);
  });

  test("a predispatch policy rejection invalidates the exact queued ticket and releases its waiter", async () => {
    const ledger = new PromptAdmissionLedger();
    const id = await ticket(ledger);
    const held = gate();
    let forwarded = false;
    const original = ledger.dispatch(scope, id, body, async (operation) => { await held.promise; return operation(); },
      async () => { forwarded = true; return new Response(null, { status: 204 }); });
    ledger.rejectQueued({ ...scope, credential: "other" }, id, body);
    expect(await ledger.inspect(scope, "msg_one").json()).toMatchObject({ state: "queued" });
    ledger.rejectQueued(scope, id, body);
    expect(await (await original).json()).toMatchObject({ state: "rejected" });
    held.release();
    await Promise.resolve();
    expect(forwarded).toBe(false);
    expect(await ledger.inspect(scope, "msg_one").json()).toMatchObject({ state: "rejected" });
  });
});
