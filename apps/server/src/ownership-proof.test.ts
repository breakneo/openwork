import { describe, expect, test } from "bun:test";

import { sendWithOwnershipProof } from "./server.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

// Cross an event-loop turn so Bun reports any unobserved rejection naturally.
const nextTurn = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe("sendWithOwnershipProof", () => {
  test("observes an early send rejection while proof is pending, then propagates the original error", async () => {
    const proof = deferred<void>();
    const failure = new DOMException("Read cancelled", "AbortError");
    let settled = false;
    const outcome = sendWithOwnershipProof(proof.promise, () => Promise.reject(failure)).then(
      () => { throw new Error("Expected send rejection"); },
      (error: unknown) => { settled = true; return error; },
    );
    await nextTurn();
    expect(settled).toBe(false);
    proof.resolve();
    expect(await outcome).toBe(failure);
  });

  test("rejects on proof failure immediately and cancels a later response body", async () => {
    const proof = deferred<void>();
    const sending = deferred<Response>();
    const cancelled = deferred<void>();
    const failure = new Error("Ownership denied");
    const outcome = sendWithOwnershipProof(proof.promise, () => sending.promise).catch((error: unknown) => error);
    proof.reject(failure);
    expect(await outcome).toBe(failure);
    sending.resolve(new Response(new ReadableStream({
      cancel() {
        cancelled.resolve();
        return Promise.reject(new Error("Cleanup failed"));
      },
    })));
    await cancelled.promise;
    await nextTurn();
  });

  test("preserves proof failure when the send also rejects", async () => {
    const proof = deferred<void>();
    const failure = new Error("Ownership denied");
    const outcome = sendWithOwnershipProof(proof.promise, () => Promise.reject(new Error("Send failed")))
      .catch((error: unknown) => error);
    await nextTurn();
    proof.reject(failure);
    expect(await outcome).toBe(failure);
  });

  for (const first of ["send", "proof"]) {
    test(`returns the unchanged response only after both succeed (${first} first)`, async () => {
      const proof = deferred<void>();
      const sending = deferred<Response>();
      const response = new Response("history");
      let settled = false;
      let sends = 0;
      const outcome = sendWithOwnershipProof(proof.promise, () => {
        sends += 1;
        return sending.promise;
      }).then((result) => { settled = true; return result; });
      expect(sends).toBe(1);
      if (first === "send") sending.resolve(response);
      else proof.resolve();
      await nextTurn();
      expect(settled).toBe(false);
      if (first === "send") proof.resolve();
      else sending.resolve(response);
      expect(await outcome).toBe(response);
      expect(await response.text()).toBe("history");
    });
  }
});
