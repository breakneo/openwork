import { expect, test } from "bun:test";
import { createGatewayUsageSettlementRefresh, gatewayUsageSettlementDelays } from "../src/react-app/domains/cloud/gateway-usage-refresh";

function harness() {
  let reads = 0;
  let unresolved = true;
  let current = true;
  const timers: { callback: () => void; delay: number; cancelled: boolean }[] = [];
  const runner = createGatewayUsageSettlementRefresh({
    refresh: async () => { reads++; },
    hasUnresolved: () => unresolved,
    isCurrent: () => current,
    schedule: (callback, delay) => {
      const timer = { callback, delay, cancelled: false };
      timers.push(timer);
      return () => { timer.cancelled = true; };
    },
  });
  return {
    runner, timers, reads: () => reads,
    resolved: () => { unresolved = false; },
    changedScope: () => { current = false; runner.dispose(); },
    async advance() {
      const timer = timers.find((item) => !item.cancelled);
      if (!timer) throw new Error("No pending timer");
      timer.cancelled = true;
      timer.callback();
      await Promise.resolve();
    },
  };
}

test("permanent historical unknown costs stop at the finite backoff cap and stable keys cannot restart it", async () => {
  const h = harness();
  h.runner.complete("turn-a");
  await Promise.resolve();
  expect(h.reads()).toBe(1);
  for (const delay of gatewayUsageSettlementDelays) {
    expect(h.timers.find((timer) => !timer.cancelled)?.delay).toBe(delay);
    h.runner.complete("turn-a");
    await h.advance();
  }
  expect(h.reads()).toBe(5);
  expect(h.timers.filter((timer) => !timer.cancelled)).toHaveLength(0);
  h.runner.complete("turn-a");
  await Promise.resolve();
  expect(h.reads()).toBe(5);
  h.runner.dispose();
});

test("coalesces concurrent pane completion signals and stops once accounting resolves", async () => {
  const h = harness();
  h.runner.complete("pane-a");
  h.runner.complete("pane-b");
  await Promise.resolve();
  expect(h.reads()).toBe(1);
  await h.advance();
  expect(h.reads()).toBe(2);
  h.resolved();
  await h.advance();
  expect(h.reads()).toBe(3);
  expect(h.timers.filter((timer) => !timer.cancelled)).toHaveLength(0);
  h.runner.complete("pane-b");
  await Promise.resolve();
  expect(h.reads()).toBe(3);
  h.runner.dispose();
});

test("a distinct completion refreshes immediately during backoff and gets a fresh finite budget", async () => {
  const h = harness();
  h.runner.complete("turn-a");
  await Promise.resolve();
  await h.advance();
  h.runner.complete("turn-b");
  await Promise.resolve();
  expect(h.reads()).toBe(3);
  for (const delay of gatewayUsageSettlementDelays) {
    expect(h.timers.find((timer) => !timer.cancelled)?.delay).toBe(delay);
    h.runner.complete("turn-b");
    await h.advance();
  }
  expect(h.reads()).toBe(7);
  expect(h.timers.filter((timer) => !timer.cancelled)).toHaveLength(0);
  h.runner.dispose();
});

test("scope change cancels queued callbacks and does not refresh a replacement account", async () => {
  const h = harness();
  h.runner.complete("old-turn");
  await Promise.resolve();
  h.changedScope();
  expect(h.timers.filter((timer) => !timer.cancelled)).toHaveLength(0);
  h.timers[0].callback();
  h.runner.complete("new-turn");
  await Promise.resolve();
  expect(h.reads()).toBe(1);
});
