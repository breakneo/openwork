import assert from "node:assert/strict";
import { test } from "node:test";
import { compileVerification, runVerification } from "../packages/testkit/src/verification.ts";
import { offlineRoutingEvaluator, routingCheckIds, routingDictionary, routingIntent, unsupportedRoutingIntent } from "./gateway-routing-verification.ts";

test("offline fixture covers the complete claim and abstains on unsupported intent", async () => {
  const result = await compileVerification({ intent: routingIntent, dictionary: routingDictionary, evaluate: offlineRoutingEvaluator });
  assert.equal(result.status, "ready");
  if (result.status !== "ready") throw new Error("Expected complete selection");
  assert.deepEqual(result.plan.checkIds, routingCheckIds);
  const unsupported = await compileVerification({ intent: unsupportedRoutingIntent, dictionary: routingDictionary, evaluate: offlineRoutingEvaluator });
  assert.equal(unsupported.status, "incomplete");
});

test("serialized plan replays twice without model calls; wrong persisted revision fails", async () => {
  let calls = 0;
  const compiled = await compileVerification({ intent: routingIntent, dictionary: routingDictionary, evaluate: request => {
    calls++;
    return offlineRoutingEvaluator(request);
  } });
  if (compiled.status !== "ready") throw new Error("Expected complete selection");
  const plan = JSON.parse(JSON.stringify(compiled.plan));
  let revision = 2;
  const input: Parameters<typeof runVerification>[0] = {
    plan, dictionary: routingDictionary,
    observations: { "saved-router": { version: "1", read: async () => [{ revision, name: "Daily work revised", minConfidence: 0.75,
      routes: [{ description: "Code review and debugging" }, { description: "Clear business writing" }] }] } },
    // Unit-only channel witnesses: no browser actions or network transport.
    channels: {
      user: { see: async () => {}, notSee: async () => {} },
      probe: { text: async () => "", eventually: async (fn, options) => {
        const value = await fn();
        assert.equal(options.until?.(value), true, "persisted value mismatch");
        return value;
      } },
      step: async (_name, fn) => fn(),
    },
  };
  for (let replay = 0; replay < 2; replay++) {
    const result = await runVerification(input);
    assert.equal(result.status, "passed");
    assert.equal(result.modelCalls, 0);
  }
  revision = 1;
  await assert.rejects(() => runVerification(input), /persisted value mismatch/);
  assert.equal(calls, 1);
});
