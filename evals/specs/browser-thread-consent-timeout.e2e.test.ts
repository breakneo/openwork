import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { browserWebMcpWorld } from "../worlds/browser-webmcp.ts";

const test = spec.world(browserWebMcpWorld);

test("thread browser consent can remain pending beyond the operation timeout", async ({ world, agent, user, probe, evidence }) => {
  let settled = false;
  const pending = agent.browserTask({
    sessionId: world.session.sessionId,
    operation: "open",
    args: { url: `${world.origin}/` },
  }).then((result) => {
    settled = true;
    return result;
  });

  await user.see({ text: "Allow browser control for this thread?" });
  await user.see({ role: "button", label: "Allow for this thread" });
  const reviewStarted = Date.now();
  await probe.eventually(async () => {
    expect(settled).toBe(false);
    expect((await probe.browserFixtureState(world.origin)).pageRequests).toEqual([]);
    return Date.now() - reviewStarted;
  }, {
    within: 35_000,
    until: (elapsed) => elapsed >= 31_000,
    label: "thread consent remains pending beyond the browser operation timeout",
  });

  await user.click({ role: "button", label: "Allow for this thread" });
  const opened = await pending;
  expect(opened).toMatchObject({ ok: true, provider: "builtin", url: `${world.origin}/` });
  expect(opened.visible).toBeTypeOf("boolean");
  const requested = await probe.eventually(() => probe.browserFixtureState(world.origin), {
    within: 10_000,
    until: (state) => state.pageRequests.length === 1,
    label: "the approved browser open contacts the destination once",
  });
  expect(requested.pageRequests).toEqual([{ path: "/", signedIn: false }]);
  await user.screenshot();
  evidence.recordAssertionEvidence(
    "Thread consent is excluded from the operation freshness budget",
    "The open stayed pending for more than 31 seconds without contacting the destination, then one approval completed the original request and produced exactly one GET.",
    true,
  );
});
