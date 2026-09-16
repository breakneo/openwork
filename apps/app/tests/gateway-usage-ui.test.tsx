import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import type { Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClientProvider, focusManager } from "@tanstack/react-query";
import { getReactQueryClient } from "../src/react-app/infra/query-client";
import { writeDenSettings } from "../src/app/lib/den";
import { gatewayUsageQueryPrefix, gatewayUsageNoticeState, parseGatewayUsageError, type GatewayUsageErrorEvidence } from "../src/react-app/domains/cloud/gateway-usage-state";
import { gatewayUsageLimitResponse } from "@openwork/types/den/gateway-usage-limits";
import { approvedUsageStatus, usageStatus } from "./gateway-usage-fixture";
import { readGatewayUsageScope } from "../src/app/lib/gateway-usage-scope";
import { disposeGatewayUsageRefresh, refreshGatewayUsageAfterCompletion } from "../src/react-app/domains/cloud/gateway-usage-refresh";

GlobalRegistrator.register();
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const { createRoot } = await import("react-dom/client");
let organizationId = "org_test";
let signedIn = true;
mock.module("../src/react-app/domains/cloud/den-auth-provider", () => ({
  useDenAuth: () => ({ isSignedIn: signedIn, verifiedIdentity: signedIn ? { organizationId, principalId: "user_test" } : null }),
}));
const { GatewayUsageSummary, GatewayUsageNotice, GatewayUsageTrigger, GatewayResetForm } = await import("../src/react-app/domains/cloud/gateway-usage-panel");
const { useGatewayUsage, useGatewayUsageErrorHandled } = await import("../src/react-app/domains/cloud/use-gateway-usage");
const { __applySessionSyncEventForTest, __createWorkspaceSessionSyncForTest } = await import("../src/react-app/domains/session/sync/session-sync");
const originalFetch = globalThis.fetch;
let root: Root | undefined;
let container: HTMLDivElement;
let current: ReturnType<typeof useGatewayUsage> | undefined;
let enabled = true;
let refreshKey = "session-a:idle";
let status = usageStatus();
let readFailure = false;
let pendingRead: Promise<Response> | undefined;
let reads = 0;
let writes = 0;
let submitted: unknown;
let evidence: GatewayUsageErrorEvidence | null = null;
let hasError = false;
let paneCount = 1;
let modelId = "model-a";
let providerScope: number | null | undefined;
let settled = false;
let ownPanelActive = false;

function latest() {
  if (!current) throw new Error("Missing hook");
  return current;
}
function Probe() {
  current = useGatewayUsage(enabled, false, JSON.stringify([refreshKey, modelId]), settled, providerScope);
  const handled = useGatewayUsageErrorHandled({ scopeKey: current.scopeKey, sessionOwner: "session-a", errorKey: "turn", gatewaySelected: current.active, status: current.data, evidence });
  const notice = gatewayUsageNoticeState({ gatewaySelected: current.active, status: current.data });
  return <div>{current.data?.organizationId ?? "no data"}:{current.query.isError ? "error" : current.data?.state ?? "loading"}
    {notice && current.data ? <GatewayUsageNotice state={notice} status={current.data} stale={current.query.isError} /> : null}
    {hasError && !handled ? <p>Provider error</p> : null}
  </div>;
}
function OwnPanelProbe() { useGatewayUsage(true); return null; }
function renderProbe() {
  root?.render(<QueryClientProvider client={getReactQueryClient()}>{ownPanelActive ? <OwnPanelProbe /> : null}{Array.from({ length: paneCount }, (_, index) => <Probe key={index} />)}</QueryClientProvider>);
}
async function flush() { await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); }); }
function changeSettings(org = "org_test", token = "member-token") {
  writeDenSettings({ baseUrl: "https://den.test", activeOrgId: org, authToken: token }, { persistBootstrap: false });
}

beforeEach(() => {
  organizationId = "org_test";
  signedIn = true;
  enabled = true;
  refreshKey = "session-a:idle";
  evidence = null;
  hasError = false;
  paneCount = 1;
  modelId = "model-a";
  providerScope = undefined;
  settled = false;
  ownPanelActive = false;
  reads = 0;
  writes = 0;
  readFailure = false;
  pendingRead = undefined;
  current = undefined;
  status = usageStatus();
  changeSettings();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  Object.defineProperty(globalThis, "fetch", { configurable: true, value: async (_url: string, init?: RequestInit) => {
    if (init?.method === "POST") {
      writes++;
      submitted = typeof init.body === "string" ? JSON.parse(init.body) : null;
      status = { ...status, buckets: status.buckets.map((bucket) => ({ ...bucket, canRequestReset: false, resetRequestStatus: "pending" })) };
      return Response.json({ id: "request_test", memberId: "member_test", memberName: "Test", memberEmail: "test@example.test", bucketId: "bucket_test", timeframe: "day", policyName: "Standard", reason: "Finish task", status: "pending", createdAt: status.serverTime, reviewedAt: null, reviewedBy: null, baseAllowanceMicroUsd: 1_000_000, allowanceMicroUsd: 1_000_000, usedMicroUsd: 1_300_000, resetAt: "2026-09-16T05:00:00.000Z" });
    }
    reads++;
    if (pendingRead) return pendingRead;
    return readFailure ? Response.json({ error: "unavailable" }, { status: 503 }) : Response.json(status);
  } });
});
afterEach(async () => {
  disposeGatewayUsageRefresh();
  await act(async () => root?.unmount());
  root = undefined;
  container.remove();
  getReactQueryClient().clear();
  globalThis.fetch = originalFetch;
  focusManager.setFocused(undefined);
});

test("summary presents day/week/month micro-USD, base/extension, hard/soft, pending and incomplete estimates", () => {
  const first = status.buckets[0];
  const html = renderToStaticMarkup(<GatewayUsageSummary status={{ ...status, coverage: { complete: false, unpricedRequests: 2 }, buckets: [first, { ...first, id: "week", timeframe: "week", hardLimit: false, canRequestReset: false, resetRequestStatus: "pending" }, { ...approvedUsageStatus().buckets[0], id: "month", timeframe: "month" }] }} onRequest={() => {}} />);
  for (const text of ["Daily", "Weekly", "Monthly", "1.30", "1.00", "1.25", "Base", "Extension", "0.00", "0.25", "Hard limit", "Soft limit", "Incomplete accounting", "Reset request pending", "approved", "05:00 UTC", "GMT"]) expect(html).toContain(text);
  expect(html).toContain("Request Reset — Daily");
  expect(html).not.toContain("Request Reset — Weekly");
  expect(html).not.toContain("Request Reset — Monthly");
  expect(renderToStaticMarkup(<GatewayUsageSummary status={usageStatus({ state: "unlimited", buckets: [] })} onRequest={() => {}} />)).toContain("No usage limit policy assigned");
});

test("hard/soft notices remain informational and keep accessible usage controls", () => {
  const hard = renderToStaticMarkup(<GatewayUsageNotice state="blocked" status={status} stale={true} />);
  expect(hard).toContain("Out of usage");
  expect(hard).toContain("keep editing");
  expect(hard).toContain("Could not refresh usage");
  expect(hard).toContain('aria-label="Usage limits"');
  expect(hard).not.toContain("disabled=");
  const soft = renderToStaticMarkup(<GatewayUsageNotice state="over_limit" status={{ ...status, state: "over_limit" }} stale={false} />);
  expect(soft).toContain("Requests are still allowed");
  expect(soft).not.toContain("Out of usage");
});

test("reason form rejects blank and submits trimmed input", async () => {
  const reasons: string[] = [];
  await act(async () => root?.render(<GatewayResetForm bucket={status.buckets[0]} pending={false} error={false} onSubmit={(reason) => reasons.push(reason)} />));
  const button = container.querySelector("button");
  const textarea = container.querySelector("textarea");
  const form = container.querySelector("form");
  if (!button || !textarea || !form) throw new Error("Missing form controls");
  expect(button.disabled).toBe(true);
  expect(textarea.required).toBe(true);
  expect(container.querySelector("label")?.htmlFor).toBe(textarea.id);
  await act(async () => { form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); });
  expect(reasons).toHaveLength(0);
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")?.set;
  await act(async () => { setter?.call(textarea, " Finish task "); textarea.dispatchEvent(new Event("input", { bubbles: true })); });
  await act(async () => { form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); });
  expect(reasons).toEqual(["Finish task"]);
});

test("panel fetches on click and exposes a titled loading/error state", async () => {
  let resolveRead: ((value: Response) => void) | undefined;
  pendingRead = new Promise((resolve) => { resolveRead = resolve; });
  await act(async () => root?.render(<QueryClientProvider client={getReactQueryClient()}><GatewayUsageTrigger /></QueryClientProvider>));
  expect(reads).toBe(0);
  const button = container.querySelector("button");
  if (!button) throw new Error("Missing usage button");
  await act(async () => button.click());
  await flush();
  expect(reads).toBeGreaterThan(0);
  expect(document.body.textContent).toContain("Loading usage limits");
  expect(document.querySelector('[data-slot="popover-title"]')?.textContent).toBe("Usage limits");
  await act(async () => resolveRead?.(Response.json({ error: "unavailable" }, { status: 503 })));
  await flush();
  expect(document.body.textContent).toContain("does not mean unlimited access");
});

test("eligible bucket opens a titled reset dialog and pending status removes its action", async () => {
  await act(async () => root?.render(<QueryClientProvider client={getReactQueryClient()}><GatewayUsageTrigger /></QueryClientProvider>));
  const trigger = container.querySelector("button");
  if (!trigger) throw new Error("Missing usage trigger");
  await act(async () => trigger.click());
  await flush();
  const request = Array.from(document.querySelectorAll("button")).find((button) => button.textContent?.includes("Request Reset — Daily"));
  if (!request) throw new Error("Missing eligible reset action");
  await act(async () => request.click());
  await flush();
  expect(document.querySelector('[data-slot="dialog-title"]')?.textContent).toBe("Request Reset");
  expect(document.querySelector("textarea")?.required).toBe(true);
  status = { ...status, buckets: status.buckets.map((bucket) => ({ ...bucket, canRequestReset: false, resetRequestStatus: "pending" })) };
  await act(async () => { await getReactQueryClient().invalidateQueries({ queryKey: gatewayUsageQueryPrefix }); });
  await flush();
  expect(document.body.textContent).toContain("Reset request pending");
  expect(document.body.textContent).not.toContain("Request Reset — Daily");
});

test("reset mutation refetches own truth and prevents a pending duplicate", async () => {
  await act(async () => renderProbe());
  await flush();
  const before = reads;
  await act(async () => { await latest().reset.mutateAsync({ bucketId: "bucket_test", reason: " Finish task " }); });
  await flush();
  expect(submitted).toEqual({ bucketId: "bucket_test", reason: "Finish task" });
  expect(writes).toBe(1);
  expect(reads).toBeGreaterThan(before);
  expect(latest().data?.buckets[0]).toMatchObject({
    resetRequestStatus: "pending", canRequestReset: false,
    baseAllowanceMicroUsd: 1_000_000, extensionMicroUsd: 0, allowanceMicroUsd: 1_000_000,
    usedMicroUsd: 1_300_000, remainingMicroUsd: -300_000,
  });
  await act(async () => {
    await expect(latest().reset.mutateAsync({ bucketId: "bucket_test", reason: "Duplicate" })).rejects.toThrow("eligibility");
  });
  await flush();
  expect(writes).toBe(1);
});

test("approved extension remains exhausted but cannot request another reset", async () => {
  const eligible = usageStatus().buckets[0];
  expect(eligible.extensionMicroUsd).toBe(0);
  expect(eligible.allowanceMicroUsd).toBe(eligible.baseAllowanceMicroUsd);
  expect(eligible.remainingMicroUsd).toBe(eligible.allowanceMicroUsd - eligible.usedMicroUsd);
  expect(eligible.canRequestReset).toBe(true);
  expect(eligible.resetRequestStatus).toBeNull();
  status = approvedUsageStatus();
  const approved = status.buckets[0];
  expect(approved).toMatchObject({
    baseAllowanceMicroUsd: 1_000_000, extensionMicroUsd: 250_000, allowanceMicroUsd: 1_250_000,
    usedMicroUsd: 1_300_000, remainingMicroUsd: -50_000,
    canRequestReset: false, resetRequestStatus: "approved",
  });
  expect(approved.remainingMicroUsd).toBe(approved.allowanceMicroUsd - approved.usedMicroUsd);
  const html = renderToStaticMarkup(<GatewayUsageSummary status={status} onRequest={() => {}} />);
  expect(html).toContain("approved");
  expect(html).toContain("1.25");
  expect(html).toContain("0.25");
  expect(html).not.toContain("Request Reset — Daily");
  await act(async () => renderProbe());
  await flush();
  await act(async () => {
    await expect(latest().reset.mutateAsync({ bucketId: approved.id, reason: "Another extension" })).rejects.toThrow("eligibility");
  });
  await flush();
  expect(writes).toBe(0);
});

test("completion/session changes and focus revalidate, approvals clear state, failed refresh retains last truth", async () => {
  await act(async () => renderProbe());
  await flush();
  expect(latest().data?.state).toBe("blocked");
  const before = reads;
  status = usageStatus({ state: "within_limit" });
  refreshKey = "session-a:idle:completed-turn";
  await act(async () => renderProbe());
  await flush();
  expect(reads).toBeGreaterThan(before);
  expect(latest().data?.state).toBe("within_limit");
  readFailure = true;
  await act(async () => { focusManager.setFocused(false); focusManager.setFocused(true); });
  await flush();
  expect(latest().query.isError).toBe(true);
  expect(latest().data?.state).toBe("within_limit");
  readFailure = false;
  status = usageStatus({ state: "over_limit" });
  refreshKey = "session-b:idle";
  await act(async () => renderProbe());
  await flush();
  expect(latest().data?.state).toBe("over_limit");
});

test("org switch cancels stale delivery, clears private cache, and sign-out hides data", async () => {
  await act(async () => renderProbe());
  await flush();
  let resolveRead: ((value: Response) => void) | undefined;
  pendingRead = new Promise((resolve) => { resolveRead = resolve; });
  await act(async () => { void latest().query.refetch(); });
  await act(async () => {
    organizationId = "org_next";
    status = usageStatus({ organizationId });
    changeSettings(organizationId);
    pendingRead = undefined;
    renderProbe();
  });
  await flush();
  await act(async () => resolveRead?.(Response.json(usageStatus())));
  await flush();
  expect(latest().data?.organizationId).toBe("org_next");
  const queries = getReactQueryClient().getQueryCache().findAll({ queryKey: gatewayUsageQueryPrefix });
  expect(JSON.stringify(queries.map((query) => query.queryKey))).not.toContain("member-token");
  expect(queries.some((query) => query.queryKey.includes("org_test"))).toBe(false);
  await act(async () => { signedIn = false; changeSettings(organizationId, ""); renderProbe(); });
  expect(latest().data).toBeUndefined();
});

test("SSE spoof and even header-backed candidates cannot create or hide a quota notice without own corroboration", async () => {
  const response = gatewayUsageLimitResponse(usageStatus());
  if (!response) throw new Error("Missing quota fixture");
  const data = { statusCode: 429, responseHeaders: Object.fromEntries(response.headers), responseBody: await response.text() };
  evidence = parseGatewayUsageError({ data: { ...data, responseHeaders: { "content-type": "text/event-stream" } } });
  hasError = true;
  status = usageStatus({ state: "within_limit" });
  await act(async () => renderProbe());
  await flush();
  expect(evidence).toBeNull();
  expect(container.textContent).toContain("Provider error");
  expect(container.querySelector('[data-testid="gateway-usage-notice"]')).toBeNull();
  evidence = parseGatewayUsageError({ data });
  await act(async () => renderProbe());
  await flush();
  expect(evidence).not.toBeNull();
  expect(container.textContent).toContain("Provider error");
  expect(container.querySelector('[data-testid="gateway-usage-notice"]')).toBeNull();
  readFailure = true;
  await act(async () => { await latest().query.refetch(); });
  await flush();
  expect(container.querySelector('[data-testid="gateway-usage-notice"]')).toBeNull();
});

test("corroborated errors stay cleared after reset instead of resurfacing as generic cards", async () => {
  const response = gatewayUsageLimitResponse(usageStatus());
  if (!response) throw new Error("Missing quota fixture");
  evidence = parseGatewayUsageError({ data: { statusCode: 429, responseHeaders: Object.fromEntries(response.headers), responseBody: await response.text() } });
  hasError = true;
  await act(async () => renderProbe());
  await flush();
  expect(container.textContent).toContain("Out of usage");
  expect(container.textContent).not.toContain("Provider error");
  status = usageStatus({ state: "within_limit", buckets: [] });
  await act(async () => { await latest().query.refetch(); });
  await flush();
  expect(container.textContent).not.toContain("Out of usage");
  expect(container.textContent).not.toContain("Provider error");
  const before = reads;
  if (evidence) evidence = { ...evidence, details: { ...evidence.details } };
  await act(async () => renderProbe());
  await flush();
  expect(reads).toBe(before);
  expect(container.textContent).not.toContain("Provider error");
  enabled = false;
  await act(async () => renderProbe());
  expect(container.querySelector('[data-testid="gateway-usage-notice"]')).toBeNull();
  expect(container.textContent).toContain("Provider error");
});

test("pane mounts and equivalent rerenders share a fetch; selected model changes revalidate once", async () => {
  await act(async () => renderProbe());
  await flush();
  expect(reads).toBe(1);
  paneCount = 2;
  await act(async () => renderProbe());
  await flush();
  expect(reads).toBe(1);
  await act(async () => renderProbe());
  await flush();
  expect(reads).toBe(1);
  modelId = "model-b";
  await act(async () => renderProbe());
  await flush();
  expect(reads).toBe(2);
  await act(async () => renderProbe());
  await flush();
  expect(reads).toBe(2);
});

test("cached org B quota never labels an org A provider while sync is pending or failed", async () => {
  providerScope = readGatewayUsageScope().generation;
  ownPanelActive = true;
  await act(async () => renderProbe());
  await flush();
  expect(container.textContent).toContain("Out of usage");
  await act(async () => {
    organizationId = "org_b";
    status = usageStatus({ organizationId });
    changeSettings(organizationId, "token_b");
    renderProbe();
  });
  await flush();
  expect(latest().data?.organizationId).toBe("org_b");
  expect(latest().active).toBe(false);
  expect(container.querySelector('[data-testid="gateway-usage-notice"]')).toBeNull();
  providerScope = null;
  await act(async () => renderProbe());
  expect(container.querySelector('[data-testid="gateway-usage-notice"]')).toBeNull();
  providerScope = readGatewayUsageScope().generation;
  modelId = "verified-b-model";
  await act(async () => renderProbe());
  await flush();
  expect(latest().active).toBe(true);
  expect(container.textContent).toContain("Out of usage");
});

test("incomplete soft accounting settling after two seconds is discovered by bounded follow-up", async () => {
  status = usageStatus({ state: "within_limit", coverage: { complete: false, unpricedRequests: 1 } });
  status.buckets[0].hardLimit = false;
  await act(async () => renderProbe());
  await flush();
  await act(async () => { settled = true; refreshKey = "session-a:completed"; renderProbe(); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 2200)); });
  await flush();
  expect(container.querySelector('[data-testid="gateway-usage-notice"]')).toBeNull();
  status = { ...status, state: "over_limit", coverage: { complete: true, unpricedRequests: 0 } };
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 5100)); });
  await flush();
  expect(container.textContent).toContain("Requests are still allowed");
}, 15_000);

test("background successful terminal events refresh the foreground own status without a background pane", async () => {
  status = usageStatus({ state: "within_limit" });
  await act(async () => renderProbe());
  await flush();
  const input = { workspaceId: "background_workspace", baseUrl: "http://127.0.0.1:1234", openworkToken: "test-token" };
  const cleanup = __createWorkspaceSessionSyncForTest(input);
  try {
    __applySessionSyncEventForTest(input, { type: "session.execution.started", properties: { sessionID: "background_session", model: { providerID: "ipr_test" } } });
    const before = reads;
    status = usageStatus({ state: "over_limit" });
    await act(async () => { __applySessionSyncEventForTest(input, { type: "session.execution.succeeded", properties: { sessionID: "background_session" } }); });
    await flush();
    expect(reads).toBeGreaterThan(before);
    expect(container.textContent).toContain("Requests are still allowed");
    const settledReads = reads;
    await act(async () => { __applySessionSyncEventForTest(input, { type: "session.execution.succeeded", properties: { sessionID: "background_session" } }); });
    await flush();
    expect(reads).toBe(settledReads);
  } finally { cleanup(); }
});

test("known local-provider completions do not start Gateway settlement refreshes", async () => {
  status = usageStatus({ state: "within_limit" });
  await act(async () => renderProbe());
  await flush();
  const input = { workspaceId: "local_background", baseUrl: "http://127.0.0.1:1234", openworkToken: "test-token" };
  const cleanup = __createWorkspaceSessionSyncForTest(input);
  try {
    __applySessionSyncEventForTest(input, { type: "session.execution.started", properties: { sessionID: "local_session", model: { providerID: "ollama" } } });
    const before = reads;
    await act(async () => { __applySessionSyncEventForTest(input, { type: "session.execution.succeeded", properties: { sessionID: "local_session" } }); });
    await flush();
    expect(reads).toBe(before);
  } finally { cleanup(); }
});

test("a run started in org A cannot refresh org B on a late background completion", async () => {
  status = usageStatus({ state: "within_limit" });
  await act(async () => renderProbe());
  await flush();
  const input = { workspaceId: "old_org_background", baseUrl: "http://127.0.0.1:1234", openworkToken: "test-token" };
  const cleanup = __createWorkspaceSessionSyncForTest(input);
  try {
    __applySessionSyncEventForTest(input, { type: "session.execution.started", properties: { sessionID: "old_org_session", model: { providerID: "ipr_org_a" } } });
    await act(async () => {
      organizationId = "org_b";
      status = usageStatus({ organizationId, state: "within_limit" });
      changeSettings(organizationId);
      renderProbe();
    });
    await flush();
    const before = reads;
    await act(async () => { __applySessionSyncEventForTest(input, { type: "session.execution.succeeded", properties: { sessionID: "old_org_session" } }); });
    await flush();
    expect(reads).toBe(before);
  } finally { cleanup(); }
});

test("org changes cancel pending settlement timers", async () => {
  status = usageStatus({ state: "within_limit", coverage: { complete: false, unpricedRequests: 1 } });
  await act(async () => renderProbe());
  await flush();
  await act(async () => { refreshGatewayUsageAfterCompletion(readGatewayUsageScope().generation, "completed-a"); });
  await flush();
  await act(async () => {
    organizationId = "org_b";
    status = usageStatus({ organizationId, state: "within_limit" });
    changeSettings(organizationId);
    renderProbe();
  });
  await flush();
  const before = reads;
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 2200)); });
  await flush();
  expect(reads).toBe(before);
  expect(latest().data?.organizationId).toBe("org_b");
});

test("reset timer revalidates and clears blocked state without user interaction", async () => {
  const now = Date.now();
  status = usageStatus({ serverTime: new Date(now).toISOString() });
  status.buckets[0].resetAt = new Date(now + 100).toISOString();
  await act(async () => renderProbe());
  await flush();
  expect(latest().data?.state).toBe("blocked");
  const before = reads;
  status = usageStatus({ state: "within_limit", serverTime: new Date(now + 1000).toISOString(), buckets: [] });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 1100)); });
  await flush();
  expect(reads).toBeGreaterThan(before);
  expect(latest().data?.state).toBe("within_limit");
});

test("unrelated model scope performs no usage fetch and unmount removes observers", async () => {
  enabled = false;
  await act(async () => renderProbe());
  await flush();
  expect(reads).toBe(0);
  enabled = true;
  await act(async () => renderProbe());
  await flush();
  expect(reads).toBeGreaterThan(0);
  await act(async () => root?.unmount());
  root = undefined;
  await flush();
  expect(getReactQueryClient().getQueryCache().findAll({ queryKey: gatewayUsageQueryPrefix })).toHaveLength(0);
});
