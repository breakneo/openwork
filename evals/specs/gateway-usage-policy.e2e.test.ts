import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { gatewayUsageLimitPolicySchema, gatewayUsageResetPageSchema, gatewayUsageStatusSchema } from "@openwork/types/den/gateway-usage-limits";
import { gatewayUsagePolicy, usageRecord, usageRecords } from "../worlds/gateway-usage-policy.ts";

const test = spec.world(gatewayUsagePolicy, {
  timeout: 600_000,
  resources: { surfaces: ["web", "desktop"], services: ["den", "mock"], nativeReason: "Verify Electron's signed-in Den IPC transport reads member usage and submits the reset from the native account panel." },
  needs: { commands: ["pnpm", "bun"], optIn: ["OPENWORK_EVAL_E2E_TESTS"] },
});

const policyName = "Journey monthly allowance";
const reason = "Finish the synthetic integration review";
const ownPath = "/v1/gateway/usage-limits/me";
const requestsPath = "/v1/gateway/usage-limit-reset-requests";
const policiesPath = "/v1/gateway/usage-limit-policies";

test("GATEWAY-USAGE-01 admin policy blocks member Gateway calls until a reviewed 25% extension", async ({ world, user, agent, probe, seed, step, evidence }) => {
  const admin = user.on(world.admin);
  const member = user.on(world.desktop);
  const memberAgent = agent.on(world.desktop);
  const memberProbe = probe.on(world.desktop);
  const own = async (identity = world.member, query = "") => {
    const result = await probe.api(identity, `${ownPath}${query}`);
    expect(result.response.status).toBe(200);
    return gatewayUsageStatusSchema.parse(result.body);
  };
  const policies = async () => {
    const result = await probe.api(world.den.admin, policiesPath);
    expect(result.response.status).toBe(200);
    return usageRecords(usageRecord(result.body).policies).map((row) => gatewayUsageLimitPolicySchema.parse(row));
  };
  const requests = async (identity = world.den.admin, suffix = "") => {
    const result = await probe.api(identity, `${requestsPath}${suffix}`);
    expect(result.response.status).toBe(200);
    const page = gatewayUsageResetPageSchema.parse(result.body);
    expect(page).toMatchObject({ view: suffix.includes("view=history") ? "history" : "pending", limit: 50, hasMore: false, nextCursor: null });
    expect(page.pendingCount).toBe(page.view === "pending" ? page.requests.length : 0);
    return page.requests;
  };
  expect(await own()).toMatchObject({ organizationId: world.orgId, memberId: world.memberId, state: "unlimited", buckets: [] });
  expect(await own(world.control)).toMatchObject({ memberId: world.controlId, state: "unlimited", buckets: [] });

  const policy = await step("admin creates and assigns the monthly hard policy in rendered Den", async () => {
    await admin.see({ role: "button", label: "Create policy" }, { timeoutMs: 90_000 });
    await admin.click({ role: "button", label: "Create policy" });
    await admin.see({ role: "combobox", label: "Timeframe 1" }, { value: "1 month" });
    await admin.type({ role: "textbox", label: "Policy name" }, policyName);
    await admin.type({ role: "textbox", label: "USD allowance 1" }, "1.000000");
    await admin.click({ role: "button", label: "Save policy" });
    await admin.see({ role: "button", label: `Assignments for ${policyName}` });
    const saved = (await policies()).find((entry) => entry.name === policyName);
    expect(saved).toMatchObject({ hardLimit: true, allowRequestReset: true, limits: [{ timeframe: "month", costLimitMicroUsd: 1_000_000 }], assignments: [] });
    if (!saved) throw new Error("Policy not persisted by the editor");
    await admin.click({ role: "button", label: `Assignments for ${policyName}` });
    await admin.type({ label: "Find person to assign" }, world.member.email);
    await admin.click({ role: "button", label: `Usage Member (${world.member.email})` });
    await admin.click({ role: "button", label: "Assign policy" });
    await probe.eventually(async () => (await policies()).find((entry) => entry.id === saved.id)?.assignments, {
      within: 15_000, intervalMs: 200, label: "Den assignment persisted",
      until: (assignments) => assignments?.length === 1 && assignments[0]?.memberId === world.memberId,
    });
    expect((await policies()).find((entry) => entry.id === saved.id)?.assignments).toEqual([{ id: expect.any(String), memberId: world.memberId, teamId: null }]);
    return saved;
  });
  const initial = await own();
  expect(initial).toMatchObject({ state: "within_limit", coverage: { complete: true, unpricedRequests: 0 }, buckets: [{ policyId: policy.id, timeframe: "month", usedMicroUsd: 0, baseAllowanceMicroUsd: 1_000_000, extensionMicroUsd: 0, allowanceMicroUsd: 1_000_000 }] });
  expect(initial.buckets).toHaveLength(1);
  const initialBucket = initial.buckets[0];
  if (!initialBucket) throw new Error("Assigned bucket missing");
  expect(new Date(initialBucket.resetAt).getUTCHours()).toBe(5);

  const sessionId = await step("member selects the actual managed Gateway model in a real Desktop session", async () => {
    const id = await memberAgent.createSession("Gateway usage composer verification");
    await memberAgent.run("session.model_picker.open");
    await member.type({ placeholder: "Search providers and models..." }, world.modelId);
    await member.see({ role: "button", label: new RegExp(world.modelId) }, { timeoutMs: 90_000 });
    await member.click({ role: "button", label: new RegExp(world.modelId) });
    await member.notSee({ placeholder: "Search providers and models..." });
    expect(await memberProbe.composer()).toMatchObject({ selectedModelLabel: world.modelName, modelUnavailable: false, composerEditable: true });
    await member.notSee({ testId: "gateway-usage-notice" });
    return id;
  });

  await step("own status is identity scoped and members cannot administer policies or another person's usage", async () => {
    expect(await own(world.control, `?memberId=${world.memberId}`)).toMatchObject({ memberId: world.controlId, state: "unlimited", buckets: [] });
    for (const path of [policiesPath, requestsPath, `/v1/gateway/usage-limits/members/${world.controlId}`]) {
      expect((await probe.api(world.member, path)).response.status).toBe(403);
    }
    expect((await seed.api(world.member, policiesPath, { method: "POST", body: JSON.stringify({ name: "Unauthorized policy", limits: [{ timeframe: "month", costUsd: "100" }] }) })).response.status).toBe(403);
    expect(await policies()).toHaveLength(1);
    await member.see({ role: "button", label: "Usage limits" }, { timeoutMs: 90_000 });
    await member.click({ role: "button", label: "Usage limits" });
    await member.see({ role: "heading", label: "Monthly" });
    await member.see({ text: "$0.00 used / $1.00 total" });
    await member.notSee({ role: "button", label: "Request Reset — Monthly" });
  });
  evidence.recordAssertionEvidence("Rendered Den assignment reaches only the intended member's real Desktop", "Monthly $1 hard/reset-enabled policy persisted through Den UI. Own-status identity injection did not change the control member; management requests returned 403; Desktop rendered zero used of $1.", true);

  const exhausted = await step("known settled upstream cost exhausts the bucket and a second real Gateway admission is blocked", async () => {
    expect(world.upstreamCount()).toBe(0);
    expect((await world.generate()).status).toBe(200);
    expect(world.upstreamCount()).toBe(1);
    expect(world.upstreamModel()).toBe("openai/gpt-4o-mini");
    expect(world.upstreamUsesOnlyOrgKey()).toBe(true);
    const status = await probe.eventually(own, { within: 15_000, intervalMs: 200, label: "real Gateway settles reported $1", until: (value) => value.state === "blocked" });
    expect(status.buckets).toEqual([{ ...initialBucket, usedMicroUsd: 1_000_000, remainingMicroUsd: 0, canRequestReset: true }]);
    expect(status.coverage).toMatchObject({ complete: true, unpricedRequests: 0 });
    const blocked = await world.generate();
    expect(blocked).toMatchObject({ status: 429, errorCode: "openwork_gateway_usage_limit_exceeded", usageState: "blocked", body: { error: { source: "openwork_gateway", code: "openwork_gateway_usage_limit_exceeded", details: { exhaustedBuckets: [{ bucketId: initialBucket.id, usedMicroUsd: 1_000_000, allowanceMicroUsd: 1_000_000 }] } } } });
    expect(world.upstreamCount()).toBe(1);
    expect((await own()).buckets).toEqual(status.buckets);
    expect(await own(world.control)).toMatchObject({ state: "unlimited", buckets: [] });
    await member.click({ role: "button", label: "Refresh usage" });
    await member.see({ text: "$1.00 used / $1.00 total" });
    await member.see({ role: "button", label: "Request Reset — Monthly" });
    await member.screenshot();
    return status;
  });
  evidence.recordAssertionEvidence("Gateway, not Desktop, blocks after known consumption", "First request settled 1000000 micro-USD; second returned trusted policy HTTP 429 without a second upstream call or charge. Desktop rendered exhaustion; the unassigned control stayed unlimited.", true);

  await step("real composer submission reaches the Gateway through the native engine and shows truthful own-status exhaustion", async () => {
    await member.press("Escape");
    const rejectedBefore = await probe.eventually(() => world.rejectedCalls(), {
      within: 15_000, intervalMs: 200, label: "direct Gateway rejection finalized",
      until: (rows) => rows.length === 1,
    });
    const prompt = "Summarize the remaining work for this synthetic review.";
    expect(prompt).not.toContain(world.providerId);
    expect(prompt).not.toContain(world.modelId);
    await member.type("composer", prompt);
    expect(await memberProbe.composer()).toMatchObject({ selectedModelLabel: world.modelName, draftText: prompt, composerEditable: true });
    await memberAgent.run("composer.send");
    const rejectedAfter = await probe.eventually(() => world.rejectedCalls(), {
      within: 120_000, intervalMs: 500, label: "native engine request rejected by the real Gateway",
      until: (rows) => rows.length > rejectedBefore.length,
    });
    for (const row of rejectedAfter) expect(row).toMatchObject({ status: 429, error_code: "openwork_gateway_usage_limit_exceeded", org_membership_id: world.memberId, requested_model: world.modelId });
    const native = await probe.eventually(() => world.nativeMessages(sessionId), {
      within: 120_000, intervalMs: 500, label: "native engine records the submitted prompt and terminal assistant error",
      until: (value) => {
        if (!value.ok || !value.data.some((message) => message.parts.some((part) => part.text === prompt))) return false;
        const body = Array.isArray(value.body) ? value.body : usageRecord(value.body).data;
        return usageRecords(body).some((entry) => {
          const info = usageRecord(entry.info ?? entry);
          return (info.role === "assistant" || info.type === "assistant") && Boolean(info.error);
        });
      },
    });
    expect(native.ok).toBe(true);
    expect(world.upstreamCount()).toBe(1);
    expect((await own()).buckets).toEqual(exhausted.buckets);
    await member.see({ testId: "gateway-usage-notice" }, { text: /Out of usage/ });
    expect((await memberProbe.dom('[data-testid="gateway-usage-notice"]')).elements).toHaveLength(1);
    expect(await memberProbe.composer()).toMatchObject({ composerEditable: true, modelUnavailable: false });
    await member.screenshot();
    evidence.recordAssertionEvidence("Native composer reaches the real Gateway and own status corroborates the custom notice", JSON.stringify({ engine: world.engine, rejectedBefore: rejectedBefore.length, rejectedAfter: rejectedAfter.length, upstreamRequests: world.upstreamCount(), nativePromptRecorded: true, nativeAssistantErrorRecorded: true, usedMicroUsd: exhausted.buckets[0]?.usedMicroUsd }), true);
    await member.click({ role: "button", label: "Usage limits", nth: 0 });
    await member.see({ role: "button", label: "Request Reset — Monthly" });
  });

  const pending = await step("member submits a required reason from Desktop and cannot review the request", async () => {
    const blank = await seed.api(world.member, requestsPath, { method: "POST", body: JSON.stringify({ bucketId: initialBucket.id, reason: "   " }) });
    expect(blank.response.status).toBe(400);
    expect(await requests()).toEqual([]);
    await member.click({ role: "button", label: "Request Reset — Monthly" });
    await member.see({ role: "textbox", label: "Reason (required)" });
    await member.type({ role: "textbox", label: "Reason (required)" }, reason);
    await member.click({ role: "button", label: "Submit reset request" });
    await member.see({ text: "Reset request pending" });
    await member.notSee({ role: "button", label: "Request Reset — Monthly" });
    const rows = await requests();
    expect(rows).toHaveLength(1);
    const request = rows[0];
    if (!request) throw new Error("Desktop reset submission missing");
    expect(request).toMatchObject({ bucketId: initialBucket.id, memberId: world.memberId, reason, status: "pending", reviewedBy: null, reviewedAt: null });
    expect(await requests(world.member, "/me")).toEqual(rows);
    expect(await requests(world.control, "/me")).toEqual([]);
    expect((await seed.api(world.member, `${requestsPath}/${request.id}/approve`, { method: "POST" })).response.status).toBe(403);
    expect((await own()).buckets).toEqual(exhausted.buckets.map((bucket) => ({ ...bucket, resetRequestStatus: "pending", canRequestReset: false })));
    return request;
  });

  await step("admin reviews the actual reason in Den and approves exactly 25% without forgiving consumption", async () => {
    await admin.click({ role: "button", label: "Refresh requests" });
    await admin.see({ text: reason });
    await admin.see({ text: "Approve adds $0.25 → $1.25 total" });
    await admin.click({ role: "button", label: "Approve 25% for Usage Member, 1 month" });
    await admin.see({ text: "Request approved. Check the queue and history for the latest state." });
    const approved = await probe.eventually(own, { within: 15_000, intervalMs: 200, label: "approval restores real allowance", until: (value) => value.state === "within_limit" });
    expect(approved.buckets).toEqual([{ ...initialBucket, usedMicroUsd: 1_000_000, extensionMicroUsd: 250_000, allowanceMicroUsd: 1_250_000, remainingMicroUsd: 250_000, canRequestReset: false, resetRequestStatus: "approved" }]);
    expect(await requests()).toEqual([]);
    const history = await requests(world.den.admin, "?view=history");
    expect(history).toHaveLength(1);
    expect(await requests(world.member, "/me?view=history")).toEqual(history);
    expect(await requests(world.control, "/me?view=history")).toEqual([]);
    expect(history[0]).toMatchObject({ id: pending.id, status: "approved", reviewedBy: world.adminId, reviewedAt: expect.any(String), bucketId: initialBucket.id, usedMicroUsd: 1_000_000, allowanceMicroUsd: 1_250_000, resetAt: initialBucket.resetAt });
    await admin.see({ text: "Pending queue: 0. 0 queued requests loaded." });
    await admin.notSee({ role: "button", label: "Approve 25% for Usage Member, 1 month" });
    await admin.click({ role: "button", label: "Show request history" });
    await admin.see({ role: "button", label: "Refresh history" });
    await admin.see({ text: "1 history entries loaded." });
    await admin.notSee({ role: "button", label: "Load more history" });
    await admin.see({ text: "Reviewer: Usage Admin" });
    await admin.screenshot();
    await member.click({ role: "button", label: "Refresh usage" });
    await member.see({ text: "$1.00 used / $1.25 total" });
    await member.see({ text: "Reset request: approved" });
    await member.notSee({ text: "Reset request pending" });
    await member.notSee({ role: "button", label: "Request Reset — Monthly" });
    await member.press("Escape");
    await member.notSee({ testId: "gateway-usage-notice" }, { timeoutMs: 60_000 });
    expect(await memberProbe.composer()).toMatchObject({ selectedModelLabel: world.modelName, composerEditable: true, modelUnavailable: false });
    await member.screenshot();
    expect(await own(world.control)).toMatchObject({ state: "unlimited", buckets: [] });
    expect((await world.generate()).status).toBe(200);
    expect(world.upstreamCount()).toBe(2);
    expect(world.upstreamUsesOnlyOrgKey()).toBe(true);
  });
  evidence.recordAssertionEvidence("Desktop request and Den approval restore Gateway admission", "Required member reason persisted and rendered in Den. Member approval was forbidden. Admin granted exactly 250000 micro-USD with reviewer/time and unchanged consumption, bucket, reset. Desktop refreshed to $1/$1.25 and the custom notice cleared in the same managed-model session after a native engine rejection; the next real Gateway call reached upstream.", true);
});
