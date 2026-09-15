/** @jsxImportSource react */
import { afterAll, expect, mock, spyOn, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, useLayoutEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { createOpenworkServerClient, OpenworkServerError, type OpenworkMcpAppResource, type OpenworkServerClient } from "../src/app/lib/openwork-server";
import { mcpAppResolutionRetryDelayMs } from "../src/app/lib/mcp-app-resolution";
import { resolveDashboardMcpApp } from "../src/react-app/domains/dashboard/dashboard-mcp-app-resolution";
import { createMcpAppActions } from "../src/components/chat/mcp-app-origin";
import type { McpAppSandboxViewProps } from "../src/components/chat/mcp-app-frame";
import type { DashboardMcpAppEntry } from "../src/react-app/domains/dashboard/granted-dashboard-store";
import type { GeneratedArtifactView, GeneratedArtifactViewRevision } from "@openwork/types/workflows";
import { liveGeneratedAppCacheScope, liveGeneratedAppEntry, nextViewerDayBoundary } from "../src/react-app/domains/apps/live-generated-app-model";
import { DASHBOARD_AUTO_REFRESH_INTERVAL_MS } from "../src/react-app/domains/dashboard/dashboard-tile-cache";

let sandboxView: McpAppSandboxViewProps | undefined;

// Exercise the mounted tile and real action lifetime without starting an iframe or provider.
mock.module("@/components/chat/mcp-app-frame", () => ({
  McpAppSandboxView: (props: McpAppSandboxViewProps) => {
    sandboxView = props;
    const { app, origin, presentation, initialHeight } = props;
    const actions = useMemo(() => createMcpAppActions(origin, app), [origin, app]);
    const [message, setMessage] = useState("");
    const [startingHeight] = useState(initialHeight);
    useLayoutEffect(() => () => actions.dispose(), [actions]);
    return <div data-sandbox-view data-presentation={presentation} data-initial-height={startingHeight}>
      <button disabled={origin.readOnly} onClick={() => {
        void actions.callTool("read_detail").then(() => setMessage("Lease usable"), error => setMessage(error.message));
      }}>App action</button>
      <span data-action-result>{message}</span>
    </div>;
  },
}));

GlobalRegistrator.register({ url: "http://localhost/" });
afterAll(() => GlobalRegistrator.unregister());
const { WorkspaceProvider } = await import("../src/react-app/shell/workspace-provider");
const { McpAppTile } = await import("../src/react-app/domains/dashboard/mcp-app-tile");
let viewerScope = ["fixture-host", "fixture-member", "fixture-org"];
mock.module("../src/react-app/domains/apps/use-apps", () => ({
  useAppsClient: () => ({ client: {}, orgId: viewerScope[2], scope: viewerScope }),
}));
const { LiveGeneratedApp } = await import("../src/react-app/domains/apps/live-generated-app");
const liveRevision: GeneratedArtifactViewRevision = {
  id: "avr_fixture", artifactViewId: "arv_fixture", resourceUri: "ui://openwork/artifacts/arv_fixture/avr_fixture",
  buildStatus: "ready", sourceDigest: "source", resourceDigest: "resource", outputSchemaDigest: "output",
  csp: { connectDomains: [], resourceDomains: [], frameDomains: [], baseUriDomains: [] }, diagnostics: [],
  compilerName: "fixture", compilerVersion: "1", reactVersion: "19", compiledHtmlBytes: 10,
  retiredAt: null, createdAt: "2026-09-14T00:00:00.000Z",
};
const liveView: GeneratedArtifactView = {
  id: "arv_fixture", configObjectId: "cob_fixture", title: "Fixture", description: null, dataMode: "live",
  status: "active", activeRevisionId: liveRevision.id, revisions: [liveRevision],
  createdAt: liveRevision.createdAt, updatedAt: liveRevision.createdAt,
};

const resource: OpenworkMcpAppResource = {
  serverName: "fixture", toolName: "render", resourceUri: "ui://fixture/view.html", html: "<p>Fixture</p>",
  csp: { connectDomains: [], resourceDomains: [], frameDomains: [], baseUriDomains: [] }, prefersBorder: true,
};
const noRelease = async () => { throw new Error("No lease should be released"); };

async function compactRefreshItem(container: HTMLElement) {
  const trigger = container.querySelector<HTMLButtonElement>('button[aria-label="App options for Fixture"]');
  if (!trigger) throw new Error("Missing compact app menu trigger");
  expect(container.querySelector('button[aria-label="Refresh Fixture"]')).toBeNull();
  await act(async () => { trigger.focus(); trigger.click(); });
  expect(trigger.getAttribute("aria-expanded")).toBe("true");
  const item = document.querySelector<HTMLElement>('[role="menuitem"][aria-label="Refresh Fixture"]');
  if (!item) throw new Error("Missing Refresh menu item");
  return item;
}

async function refreshCompactTile(container: HTMLElement) {
  const item = await compactRefreshItem(container);
  await act(async () => item.click());
}

test("bounds retries to transient discovery failures", () => {
  for (const code of ["server_unavailable", "mcp_unreachable"]) {
    const cause = new OpenworkServerError(503, code, "starting");
    expect(mcpAppResolutionRetryDelayMs(cause, 0)).toBe(1_000);
    expect(mcpAppResolutionRetryDelayMs(cause, 1)).toBe(3_000);
    expect(mcpAppResolutionRetryDelayMs(cause, 2)).toBeNull();
  }
  for (const code of ["tool_denied", "tool_resource_mismatch"]) {
    expect(mcpAppResolutionRetryDelayMs(new OpenworkServerError(422, code, "denied"), 0)).toBeNull();
  }
  expect(mcpAppResolutionRetryDelayMs(new Error("unknown failure"), 0)).toBeNull();
});

test.each([false, true])("recovers or stops after three discovery attempts (exhausted: %j)", async (exhausted) => {
  let attempts = 0;
  const waits: number[] = [];
  const failure = new OpenworkServerError(503, "mcp_unreachable", "starting");
  const endpoint = {
    workspaceId: "workspace-1",
    client: { releaseMcpApp: noRelease, resolveMcpApp: async () => {
      attempts += 1;
      if (exhausted || attempts < 3) throw failure;
      return { app: resource };
    } },
  };
  const resolving = resolveDashboardMcpApp({
    endpoints: [endpoint], projectedToolName: "fixture_render", expected: resource,
    wait: async (delay) => { waits.push(delay); },
  });
  if (exhausted) await expect(resolving).rejects.toBe(failure);
  else expect(await resolving).toEqual({ endpoint, app: resource });
  expect(attempts).toBe(3);
  expect(waits).toEqual([1_000, 3_000]);
});

test("tries another workspace before waiting and never retries deterministic failures", async () => {
  let attempts = 0;
  const failure = new OpenworkServerError(422, "tool_resource_mismatch", "resource moved");
  const first = { workspaceId: "first", client: { releaseMcpApp: noRelease, resolveMcpApp: async () => { attempts += 1; throw failure; } } };
  const second = { workspaceId: "second", client: { releaseMcpApp: noRelease, resolveMcpApp: async () => ({ app: resource }) } };
  const options = {
    projectedToolName: "fixture_render", expected: resource,
    wait: async () => { throw new Error("must not retry"); },
  };
  expect(await resolveDashboardMcpApp({ ...options, endpoints: [first, second] })).toEqual({ endpoint: second, app: resource });
  await expect(resolveDashboardMcpApp({ ...options, endpoints: [first] })).rejects.toBe(failure);
  expect(attempts).toBe(2);
  let transientAttempts = 0;
  const transient = { workspaceId: "transient", client: { releaseMcpApp: noRelease, resolveMcpApp: async () => {
    if (++transientAttempts < 3) throw new OpenworkServerError(503, "mcp_unreachable", "starting");
    return { app: resource };
  } } };
  expect(await resolveDashboardMcpApp({ ...options, endpoints: [transient, first], wait: async () => {} })).toEqual({ endpoint: transient, app: resource });
  expect(attempts).toBe(3);
  expect(transientAttempts).toBe(3);
});

test.each([
  { serverName: "other-server" },
  { toolName: "other-tool" },
  { resourceUri: "ui://fixture/other.html" },
])("releases a mismatched saved identity without exposing launch arguments: %j", async (mismatch) => {
  const released: string[] = [];
  const references: unknown[] = [];
  const lookalike = { workspaceId: "lookalike", client: {
    resolveMcpApp: async (_workspace: string, _name: string, launch: unknown, context: unknown) => {
      references.push({ launch, context });
      return { app: { ...resource, ...mismatch, launchId: "lookalike-lease" } };
    },
    releaseMcpApp: async (_workspace: string, id: string) => { released.push(id); return { released: true }; },
  } };
  const matching = { workspaceId: "matching", client: { releaseMcpApp: noRelease, resolveMcpApp: async () => ({ app: resource }) } };
  const options = {
    projectedToolName: "fixture_render", expected: resource,
    wait: async () => { throw new Error("identity mismatch must not retry"); },
  };
  expect(await resolveDashboardMcpApp({ ...options, endpoints: [lookalike, matching] })).toEqual({ endpoint: matching, app: resource });
  expect(await resolveDashboardMcpApp({ ...options, endpoints: [lookalike] })).toBeNull();
  const launch = { connectionId: "emc_fixture", toolName: resource.toolName, resourceUri: resource.resourceUri, arguments: { privateInput: "saved-input" } };
  expect(await resolveDashboardMcpApp({ ...options, endpoints: [lookalike], launch })).toBeNull();
  expect(references).toEqual([
    { launch: undefined, context: { sessionId: null, readOnly: false } },
    { launch: undefined, context: { sessionId: null, readOnly: false } },
    { launch: { ...launch, arguments: {} }, context: { sessionId: null, readOnly: false } },
  ]);
  expect(released).toEqual(["lookalike-lease", "lookalike-lease", "lookalike-lease"]);
});

test.each(["resolve", "wait"])("stops discovery and releases late leases when ownership ends during %s", async (phase) => {
  let active = true;
  let attempts = 0;
  const released: string[] = [];
  const endpoint = { workspaceId: "owner", client: {
    resolveMcpApp: async () => {
      attempts += 1;
      if (phase === "wait") throw new OpenworkServerError(503, "server_unavailable", "starting");
      active = false;
      return { app: { ...resource, launchId: "late-lease" } };
    },
    releaseMcpApp: async (_workspace: string, id: string) => { released.push(id); return { released: true }; },
  } };
  expect(await resolveDashboardMcpApp({
    endpoints: [endpoint], expected: resource, projectedToolName: "fixture_render",
    isActive: () => active, wait: async () => { active = false; },
  })).toBeNull();
  expect(attempts).toBe(1);
  expect(released).toEqual(phase === "resolve" ? ["late-lease"] : []);
});

test.each(["manual", "automatic", "background-refresh", "forbidden", "repeated", "churn", "unmount", "endpoint", "scope", "persisted"])("launch approval policy without a secondary modal: %s", async (mode) => {
  const previousAct = Reflect.get(globalThis, "IS_REACT_ACT_ENVIRONMENT");
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  const confirmSpy = spyOn(window, "confirm").mockReturnValue(false);
  const calls: unknown[] = [];
  let approvedLaunches = 0;
  let autoLaunchDisabled = 0;
  let autoLaunchEnabled = 0;
  let providerActions = 0;
  let finishChallenge: (() => void) | undefined;
  const challenge = new Promise<void>(resolve => { finishChallenge = resolve; });
  const client: OpenworkServerClient = { ...createOpenworkServerClient({ baseUrl: "http://fixture.invalid" }),
    resolveMcpApp: async () => ({ app: { ...resource, launchId: "launch-fixture" } }),
    callMcpAppTool: async (workspaceId, request) => {
      calls.push({ workspaceId, request });
      if (mode === "forbidden") throw new OpenworkServerError(403, "tool_denied", "Forbidden");
      if (!request.approved) await challenge;
      if (mode === "repeated" || !request.approved) throw new OpenworkServerError(422, "tool_requires_approval", "Approval required");
      providerActions += 1;
      return { content: [] };
    },
    releaseMcpApp: async () => ({ released: true }),
  };
  const entry: DashboardMcpAppEntry = {
    kind: "mcp", id: "approval-tile", title: "Fixture", serverName: "fixture", toolName: "render",
    projectedToolName: "fixture_render", resourceUri: resource.resourceUri,
    autoLaunch: mode === "automatic", launchApproved: mode === "persisted", requiresApproval: mode === "manual", launchArguments: { query: "saved input" },
  };
  const container = document.body.appendChild(document.createElement("div"));
  const root = createRoot(container);
  let mounted = true;
  let connected = true;
  let scope = "approval-cache";
  const render = () => root.render(<WorkspaceProvider client={null} openworkServerClient={connected ? client : null} workspaceId="fixture" selectedWorkspaceRoot="/fixture">
    <McpAppTile entry={entry} cacheScopeKey={scope}
      onApprovedLaunch={() => { approvedLaunches++; }}
      onAutoLaunchDisabled={() => { autoLaunchDisabled++; }}
      onAutoLaunchEnabled={() => { autoLaunchEnabled++; }} />
  </WorkspaceProvider>);
  const button = (label: string) => {
    const found = container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
    if (!found) throw new Error(`Missing button ${label}`);
    return found;
  };
  const request = {
    launchId: "launch-fixture", sessionId: null, serverName: "fixture", name: "render",
    resourceUri: resource.resourceUri, arguments: structuredClone(entry.launchArguments),
    ...(mode === "persisted" ? { approved: true } : {}),
  };
  try {
    await act(async () => render());
    if (mode !== "automatic") {
      expect(calls).toEqual([]);
      expect(container.querySelector("header")?.textContent).toContain("Fixture");
      expect(container.querySelector('[aria-label="App options for Fixture"]')).toBeNull();
      if (mode === "manual") expect(container.textContent).toContain("This app modifies data when it runs, so it only runs when you ask.");
      await act(async () => button("Run Fixture").click());
    }
    expect(calls).toEqual([{ workspaceId: "fixture", request }]);
    expect(document.querySelector('[role="alertdialog"], [role="dialog"]')).toBeNull();
    expect(providerActions).toBe(mode === "persisted" ? 1 : 0);
    const retried = ["manual", "background-refresh", "repeated", "churn"].includes(mode);
    if (entry.launchArguments) entry.launchArguments.query = "changed after request";
    if (mode === "unmount") { await act(async () => root.unmount()); mounted = false; }
    else if (mode === "endpoint") { connected = false; await act(async () => render()); }
    else if (mode === "scope") { scope = "another-principal"; await act(async () => render()); }
    else if (mode === "churn") {
      entry.autoLaunch = true;
      await act(async () => render());
      entry.autoLaunch = false;
      await act(async () => render());
      expect(calls).toHaveLength(1);
    }
    await act(async () => { finishChallenge?.(); });
    expect(document.querySelector('[role="alertdialog"], [role="dialog"]')).toBeNull();
    expect(calls).toEqual((retried ? [false, true] : [false]).map(approved => ({
      workspaceId: "fixture", request: { ...request, ...(approved ? { approved: true } : {}) },
    })));
    expect(providerActions).toBe(["manual", "background-refresh", "churn", "persisted"].includes(mode) ? 1 : 0);
    expect(approvedLaunches).toBe(0);
    expect(autoLaunchDisabled).toBe(["manual", "automatic", "background-refresh", "repeated", "churn"].includes(mode) ? 1 : 0);
    expect(autoLaunchEnabled).toBe(0);
    if (mode === "automatic") {
      expect(button("Run Fixture").disabled).toBe(false);
      expect(container.querySelector("[data-action-result]")).toBeNull();
      entry.autoLaunch = false;
      await act(async () => render());
      expect(calls).toHaveLength(1);
      expect(autoLaunchDisabled).toBe(1);
    } else if (mode === "manual" || mode === "churn") {
      expect(container.querySelector("[data-action-result]")).not.toBeNull();
      entry.autoLaunch = true;
      await act(async () => render());
      entry.autoLaunch = false;
      await act(async () => render());
      expect(calls).toHaveLength(2);
      expect(providerActions).toBe(1);
      expect(container.querySelector("header")).toBeNull();
      await refreshCompactTile(container);
      expect(calls).toEqual([
        { workspaceId: "fixture", request },
        { workspaceId: "fixture", request: { ...request, approved: true } },
        { workspaceId: "fixture", request: { ...request, arguments: { query: "changed after request" } } },
        { workspaceId: "fixture", request: { ...request, arguments: { query: "changed after request" }, approved: true } },
      ]);
      expect(document.querySelector('[role="alertdialog"], [role="dialog"]')).toBeNull();
      expect(providerActions).toBe(2);
      expect(autoLaunchDisabled).toBe(2);
      expect(approvedLaunches).toBe(0);
      expect(autoLaunchEnabled).toBe(0);
    } else if (mode === "background-refresh") {
      entry.autoLaunch = true;
      await act(async () => render());
      expect(calls).toHaveLength(2);
      const nowSpy = spyOn(Date, "now").mockReturnValue(Date.now() + 24 * 60 * 60 * 1_000);
      try {
        await act(async () => { window.dispatchEvent(new Event("focus")); });
      } finally {
        nowSpy.mockRestore();
      }
      expect(calls).toEqual([
        { workspaceId: "fixture", request },
        { workspaceId: "fixture", request: { ...request, approved: true } },
        { workspaceId: "fixture", request: { ...request, arguments: { query: "changed after request" } } },
      ]);
      expect(providerActions).toBe(1);
      expect(autoLaunchDisabled).toBe(2);
      expect(autoLaunchEnabled).toBe(0);
      expect(button("Run Fixture").disabled).toBe(false);
      expect(container.querySelector("[data-action-result]")).toBeNull();
      expect(document.querySelector('[role="alertdialog"], [role="dialog"]')).toBeNull();
    } else if (mode === "forbidden" || mode === "repeated") {
      expect(container.textContent).toContain(mode === "forbidden" ? "Forbidden" : "Approval required");
      expect(container.querySelector("[data-action-result]")).toBeNull();
    }
    expect(confirmSpy).not.toHaveBeenCalled();
  } finally {
    if (mounted) await act(async () => root.unmount());
    confirmSpy.mockRestore();
    container.remove();
    Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", previousAct);
  }
});

test("a mounted tile retains its lease across fallback refreshes, but releases on owner removal, refresh and unmount", async () => {
  const previousAct = Reflect.get(globalThis, "IS_REACT_ACT_ENVIRONMENT");
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  const leases = new Set<string>();
  const released: string[] = [];
  const calls: string[] = [];
  let resolutions = 0;
  let finishFirstResolution: (() => void) | undefined;
  const firstResolution = new Promise<void>(resolve => { finishFirstResolution = resolve; });
  const primary: OpenworkServerClient = { ...createOpenworkServerClient({ baseUrl: "http://primary.invalid" }),
    resolveMcpApp: async (_workspace, _tool, launch) => {
      expect(launch?.arguments).toEqual({});
      return { app: null };
    } };
  const owner: OpenworkServerClient = { ...createOpenworkServerClient({ baseUrl: "http://owner.invalid" }),
    resolveMcpApp: async (_workspace, _tool, launch, context) => {
      expect(launch?.arguments).toEqual({});
      expect(context).toEqual({ sessionId: null, readOnly: false });
      const launchId = `launch-${++resolutions}`;
      leases.add(launchId);
      if (resolutions === 1) await firstResolution;
      return { app: { ...resource, launchId } };
    },
    callMcpAppTool: async (workspaceId, request) => {
      expect(workspaceId).toBe("owner-workspace");
      if (!request.launchId || !leases.has(request.launchId)) throw new Error("Lease revoked");
      if (request.name === "render") expect(request.arguments).toEqual({ query: "saved input" });
      calls.push(request.name);
      return { content: [] };
    },
    releaseMcpApp: async (workspaceId, launchId) => {
      expect(workspaceId).toBe("owner-workspace");
      released.push(launchId);
      return { released: leases.delete(launchId) };
    },
  };
  const unrelated: OpenworkServerClient = { ...createOpenworkServerClient({ baseUrl: "http://unrelated.invalid" }),
    resolveMcpApp: async () => { throw new Error("Must not relaunch through an unrelated workspace"); } };
  const entry: DashboardMcpAppEntry = { kind: "mcp", id: "tile", serverName: "fixture", toolName: "render",
    projectedToolName: "fixture_render", resourceUri: resource.resourceUri, title: "Fixture", autoLaunch: true,
    connectionId: "emc_fixture", launchArguments: { query: "saved input" } };
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const render = async (includeOwner = true, includeUnrelated = false) => {
    await act(async () => root.render(<WorkspaceProvider client={null} openworkServerClient={primary} workspaceId="primary" selectedWorkspaceRoot="/fixture">
      <McpAppTile entry={entry} cacheScopeKey="fixture-cache" fallbackEndpoints={[
        ...(includeOwner ? [{ client: owner, workspaceId: "owner-workspace" }] : []),
        ...(includeUnrelated ? [{ client: unrelated, workspaceId: "unrelated-workspace" }] : []),
      ]} />
    </WorkspaceProvider>));
  };
  const button = (selector: string) => {
    const found = container.querySelector<HTMLButtonElement>(selector);
    if (!found) throw new Error(`Missing button ${selector}`);
    return found;
  };
  try {
    await render();
    expect(resolutions).toBe(1);
    await render();
    await render(true, true);
    expect(calls).toEqual([]);
    await act(async () => { finishFirstResolution?.(); });
    const actionButton = button("button:not([aria-label])");
    await render();
    await render(true, true);
    expect(button("button:not([aria-label])")).toBe(actionButton);
    expect(released).toEqual([]);
    expect(resolutions).toBe(1);
    await act(async () => actionButton.click());
    expect(container.querySelector("[data-action-result]")?.textContent).toBe("Lease usable");
    expect(calls).toEqual(["render", "read_detail"]);

    await render(false, true);
    expect(released).toEqual(["launch-1"]);
    await render(true, true);
    expect(button("button:not([aria-label])").disabled).toBe(true);
    expect(resolutions).toBe(1);
    await act(async () => button('[aria-label="Refresh Fixture"]').click());
    expect(resolutions).toBe(2);
    expect(button("button:not([aria-label])").disabled).toBe(false);
    await refreshCompactTile(container);
    expect(resolutions).toBe(3);
    expect(released).toEqual(["launch-1", "launch-2"]);
  } finally {
    await act(async () => root.unmount());
    container.remove();
    Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", previousAct);
  }
  expect(released).toEqual(["launch-1", "launch-2", "launch-3"]);
  expect(leases.size).toBe(0);
});

test.each(["sandbox", "refresh", "teardown"])("healthy tiles retain height and restore explicit recovery after %s failure or closure without repeating launch", async mode => {
  const previousAct = Reflect.get(globalThis, "IS_REACT_ACT_ENVIRONMENT");
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  const released: string[] = [];
  let resolutions = 0;
  let launches = 0;
  let failRefresh = false;
  const client: OpenworkServerClient = { ...createOpenworkServerClient({ baseUrl: "http://fixture.invalid" }),
    resolveMcpApp: async () => ({ app: { ...resource, launchId: `compact-${++resolutions}` } }),
    callMcpAppTool: async () => {
      launches++;
      if (failRefresh) throw new OpenworkServerError(503, "server_unavailable", "Refresh temporarily unavailable");
      return { content: [] };
    },
    releaseMcpApp: async (_workspace, id) => { released.push(id); return { released: true }; },
  };
  const entry: DashboardMcpAppEntry = {
    kind: "mcp", id: `compact-${mode}`, title: "Fixture", serverName: "fixture", toolName: "render",
    projectedToolName: "fixture_render", resourceUri: resource.resourceUri, autoLaunch: true,
  };
  const container = document.body.appendChild(document.createElement("div"));
  const root = createRoot(container);
  const render = async () => {
    await act(async () => root.render(<WorkspaceProvider client={null} openworkServerClient={client} workspaceId="fixture" selectedWorkspaceRoot="/fixture">
      <McpAppTile entry={entry} cacheScopeKey={`compact-cache-${mode}`} />
    </WorkspaceProvider>));
  };
  const view = () => {
    const node = container.querySelector<HTMLElement>("[data-sandbox-view]");
    if (!node) throw new Error("Missing mocked sandbox view");
    return node;
  };
  const expectHealthy = () => {
    expect(container.querySelector("header")).toBeNull();
    expect(container.textContent).not.toContain("Fixture");
    expect(container.textContent).not.toContain("Updated just now");
    expect(container.querySelector('[aria-label="Refresh Fixture"]')).toBeNull();
    expect(container.querySelector('[aria-label="Reload Fixture"]')).toBeNull();
    expect(container.querySelector("[data-dashboard-entry]")?.getAttribute("aria-label")).toBe("Fixture");
    expect(container.querySelector('[aria-label="App options for Fixture"]')).not.toBeNull();
    expect(view().dataset.presentation).toBe("dashboard");
  };
  try {
    await render();
    expectHealthy();
    const shell = container.querySelector("[data-dashboard-entry]");
    const initialView = view();
    expect(initialView.hasAttribute("data-initial-height")).toBe(false);
    expect(sandboxView?.onHeightChange).toBeFunction();
    await act(async () => sandboxView?.onHeightChange?.(73));
    await render();
    expect(view()).toBe(initialView);
    expect(resolutions).toBe(1);
    expect(launches).toBe(1);
    await refreshCompactTile(container);
    expectHealthy();
    const refreshedView = view();
    const stableParent = refreshedView.parentElement;
    expect(refreshedView).not.toBe(initialView);
    expect(refreshedView.dataset.initialHeight).toBe("73");
    expect(resolutions).toBe(2);
    expect(launches).toBe(2);
    expect(released).toEqual(["compact-1"]);

    if (mode === "sandbox") {
      expect(sandboxView?.onError).toBeFunction();
      await act(async () => sandboxView?.onError?.());
      expect(view()).toBe(refreshedView);
      expect(view().parentElement).toBe(stableParent);
      expect(released).toEqual(["compact-1"]);
    } else if (mode === "refresh") {
      failRefresh = true;
      await refreshCompactTile(container);
      expect(container.querySelector('[data-dashboard-cache-state="failed"]')).not.toBeNull();
      expect(container.querySelector<HTMLButtonElement>("button:not([aria-label])")?.disabled).toBe(true);
    } else {
      expect(sandboxView?.onRequestTeardown).toBeFunction();
      await act(async () => sandboxView?.onRequestTeardown?.());
      expect(container.textContent).toContain("This app closed its view. Use refresh to launch it again.");
      expect(container.querySelector("[data-sandbox-view]")).toBeNull();
      expect(released).toEqual(["compact-1", "compact-2"]);
    }
    const expectedLaunches = mode === "refresh" ? 3 : 2;
    expect(container.querySelector("[data-dashboard-entry]")).toBe(shell);
    expect(container.querySelector("header")?.textContent).toContain("Fixture");
    expect(container.querySelector('[aria-label="App options for Fixture"]')).toBeNull();
    const recovery = container.querySelector<HTMLButtonElement>('header button[aria-label="Refresh Fixture"]');
    if (!recovery) throw new Error("Missing visible recovery refresh");
    expect(recovery.disabled).toBe(false);
    await render();
    await render();
    expect(resolutions).toBe(expectedLaunches);
    expect(launches).toBe(expectedLaunches);
    failRefresh = false;
    await act(async () => recovery.click());
    expectHealthy();
    expect(view().dataset.initialHeight).toBe("73");
    expect(resolutions).toBe(expectedLaunches + 1);
    expect(launches).toBe(expectedLaunches + 1);
  } finally {
    await act(async () => root.unmount());
    container.remove();
    Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", previousAct);
  }
  expect(released).toEqual(Array.from({ length: resolutions }, (_, index) => `compact-${index + 1}`));
});

test.each(["result", "transport"])("live setup failures render a native connection card and evict the last good result (%s)", async (failureMode) => {
  const previousAct = Reflect.get(globalThis, "IS_REACT_ACT_ENVIRONMENT");
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  const liveResource = { ...resource, serverName: "openwork-cloud", toolName: "run_artifact_arv_fixture" };
  let needsSetup = false;
  let calls = 0;
  const connection = {
    schemaVersion: "1", connectionId: "emc_fixture", connectionName: "Calendar", state: "needs_connection",
    actor: "member", message: "Connect your calendar", action: { type: "connect", label: "Connect", surface: "openwork_your_connections" },
  };
  const client: OpenworkServerClient = { ...createOpenworkServerClient({ baseUrl: "http://fixture.invalid" }),
    resolveMcpApp: async (_workspace, name) => {
      expect(name).toBe("openwork-cloud_run_artifact_arv_fixture");
      return { app: { ...liveResource, launchId: "live-lease" } };
    },
    callMcpAppTool: async (_workspace, request) => {
      calls++;
      expect(request.name).toBe("run_artifact_arv_fixture");
      expect(request.arguments).toEqual({ timeZone: "Asia/Tokyo" });
      if (needsSetup && failureMode === "transport") throw new OpenworkServerError(403, "connection_required", "Connect your calendar", { connectionAction: connection });
      return needsSetup ? { isError: true, content: [], structuredContent: { connectionAction: connection } } : { content: [] };
    },
    releaseMcpApp: async () => ({ released: true }),
  };
  const entry: DashboardMcpAppEntry = { kind: "mcp", id: "live-setup", title: "Fixture", serverName: liveResource.serverName,
    toolName: liveResource.toolName, projectedToolName: `openwork-cloud_${liveResource.toolName}`, resourceUri: liveResource.resourceUri,
    autoLaunch: true, launchArguments: { timeZone: "Asia/Tokyo" } };
  const container = document.body.appendChild(document.createElement("div"));
  const root = createRoot(container);
  try {
    await act(async () => root.render(<WorkspaceProvider client={null} openworkServerClient={client} workspaceId="fixture" selectedWorkspaceRoot="/fixture">
      <McpAppTile entry={entry} cacheScopeKey="live-setup-scope" />
    </WorkspaceProvider>));
    expect(container.querySelector("[data-sandbox-view]")).not.toBeNull();
    needsSetup = true;
    await refreshCompactTile(container);
    expect(calls).toBe(2);
    expect(container.querySelector("[data-sandbox-view]")).toBeNull();
    expect(container.querySelector('[data-testid="desktop-connection-card"]')?.textContent).toContain("Calendar");
    expect(container.querySelector('button[aria-label="Connect Calendar"]')).not.toBeNull();
    expect(JSON.parse(window.localStorage.getItem("live-setup-scope") ?? "{}")[entry.id]).toBeUndefined();
  } finally {
    await act(async () => root.unmount());
    container.remove();
    window.localStorage.removeItem("live-setup-scope");
    Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", previousAct);
  }
});

test.each(["result", "connection"])("switching viewers never exposes the prior viewer %s", async (initialState) => {
  const previousAct = Reflect.get(globalThis, "IS_REACT_ACT_ENVIRONMENT");
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  const pending = Promise.withResolvers<{ content: Array<Record<string, unknown>> }>();
  let calls = 0;
  const client: OpenworkServerClient = { ...createOpenworkServerClient({ baseUrl: "http://fixture.invalid" }),
    resolveMcpApp: async () => ({ app: { ...resource, serverName: "openwork-cloud", toolName: "run_artifact_arv_scope", launchId: "scoped-lease" } }),
    callMcpAppTool: async () => {
      if (++calls !== 1) return pending.promise;
      return initialState === "result" ? { content: [] } : { isError: true, content: [], structuredContent: { connectionAction: {
        schemaVersion: "1", connectionId: "emc_scope", connectionName: "Calendar", state: "needs_connection",
        actor: "member", message: "Connect your calendar", action: { type: "connect", label: "Connect", surface: "openwork_your_connections" },
      } } };
    },
    releaseMcpApp: async () => ({ released: true }),
  };
  const entry: DashboardMcpAppEntry = { kind: "mcp", id: "viewer-scope", title: "Fixture", serverName: "openwork-cloud",
    toolName: "run_artifact_arv_scope", projectedToolName: "openwork-cloud_run_artifact_arv_scope", resourceUri: resource.resourceUri, autoLaunch: true };
  const container = document.body.appendChild(document.createElement("div"));
  const root = createRoot(container);
  const render = (scope: string) => root.render(<WorkspaceProvider client={null} openworkServerClient={client} workspaceId="fixture" selectedWorkspaceRoot="/fixture">
    <McpAppTile entry={entry} cacheScopeKey={scope} />
  </WorkspaceProvider>);
  try {
    await act(async () => render("viewer-one"));
    expect(container.querySelector(initialState === "result" ? "[data-sandbox-view]" : '[data-testid="desktop-connection-card"]')).not.toBeNull();
    await act(async () => render("viewer-two"));
    expect(container.querySelector("[data-sandbox-view]")).toBeNull();
    expect(container.querySelector('[data-testid="desktop-connection-card"]')).toBeNull();
    expect(container.textContent).toContain("Loading");
    await act(async () => pending.resolve({ content: [] }));
    expect(container.querySelector("[data-sandbox-view]")).not.toBeNull();
  } finally {
    await act(async () => root.unmount());
    container.remove();
    window.localStorage.removeItem("viewer-one");
    window.localStorage.removeItem("viewer-two");
    Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", previousAct);
  }
});

test.each(["pending", "ready"])("equivalent launch input survives dashboard rerenders while %s", async (phase) => {
  const previousAct = Reflect.get(globalThis, "IS_REACT_ACT_ENVIRONMENT");
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  const pending = Promise.withResolvers<{ content: Array<Record<string, unknown>> }>();
  const released: string[] = [];
  let calls = 0;
  let resolutions = 0;
  const client: OpenworkServerClient = { ...createOpenworkServerClient({ baseUrl: "http://fixture.invalid" }),
    resolveMcpApp: async () => ({ app: { ...resource, launchId: `stable-${++resolutions}` } }),
    callMcpAppTool: async () => { calls++; return pending.promise; },
    releaseMcpApp: async (_workspace, id) => { released.push(id); return { released: true }; },
  };
  const container = document.body.appendChild(document.createElement("div"));
  const root = createRoot(container);
  const scope = `stable-input-${phase}`;
  let renderCount = 0;
  const input = () => ++renderCount % 2
    ? { timeZone: "Asia/Tokyo", filters: { limit: 3, sources: ["primary", "secondary"] } }
    : { filters: { sources: ["primary", "secondary"], limit: 3 }, timeZone: "Asia/Tokyo" };
  const render = () => root.render(<WorkspaceProvider client={null} openworkServerClient={client} workspaceId="fixture" selectedWorkspaceRoot="/fixture">
    <McpAppTile entry={{ kind: "mcp", id: "stable-input", title: "Fixture", serverName: resource.serverName,
      toolName: resource.toolName, projectedToolName: "fixture_render", resourceUri: resource.resourceUri,
      autoLaunch: true, launchArguments: input() }} cacheScopeKey={scope}
      fallbackEndpoints={[{ client, workspaceId: "fixture" }]} onAutoLaunchEnabled={() => {}} />
  </WorkspaceProvider>);
  try {
    await act(async () => render());
    if (phase === "ready") await act(async () => pending.resolve({ content: [] }));
    const initialArguments = sandboxView?.inputArguments;
    const initialOrigin = sandboxView?.origin;
    for (let i = 0; i < 10; i++) await act(async () => render());
    expect(calls).toBe(1);
    expect(resolutions).toBe(1);
    expect(released).toEqual([]);
    if (phase === "pending") await act(async () => pending.resolve({ content: [] }));
    expect(sandboxView?.origin.readOnly).toBe(false);
    expect(container.textContent).not.toContain("run required");
    if (phase === "ready") {
      expect(sandboxView?.inputArguments).toBe(initialArguments);
      expect(sandboxView?.origin).toBe(initialOrigin);
    }
    await refreshCompactTile(container);
    expect(calls).toBe(2);
    expect(resolutions).toBe(2);
    expect(released).toEqual(["stable-1"]);
  } finally {
    await act(async () => pending.resolve({ content: [] }));
    await act(async () => root.unmount());
    container.remove();
    window.localStorage.removeItem(scope);
    Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", previousAct);
  }
});

test.each(["pending", "ready"])("changed arguments with the same tile ID retire the %s invocation and cannot reuse its last good data", async (phase) => {
  const previousAct = Reflect.get(globalThis, "IS_REACT_ACT_ENVIRONMENT");
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  const first = Promise.withResolvers<{ content: Array<Record<string, unknown>> }>();
  const second = Promise.withResolvers<{ content: Array<Record<string, unknown>> }>();
  const requests: unknown[] = [];
  const released: string[] = [];
  let resolutions = 0;
  const client: OpenworkServerClient = { ...createOpenworkServerClient({ baseUrl: "http://fixture.invalid" }),
    resolveMcpApp: async () => ({ app: { ...resource, serverName: "openwork-cloud", toolName: "run_artifact_arv_fixture", resourceUri: liveRevision.resourceUri, launchId: `changed-${++resolutions}` } }),
    callMcpAppTool: async (_workspace, request) => { requests.push(request.arguments); return requests.length === 1 ? first.promise : second.promise; },
    releaseMcpApp: async (_workspace, id) => { released.push(id); return { released: true }; },
  };
  const container = document.body.appendChild(document.createElement("div"));
  const root = createRoot(container);
  const scope = `changed-input-${phase}`;
  const render = (timeZone: string) => root.render(<WorkspaceProvider client={null} openworkServerClient={client} workspaceId="fixture" selectedWorkspaceRoot="/fixture">
    <McpAppTile entry={{ ...liveGeneratedAppEntry(liveView, liveRevision, timeZone), id: "same-id" }} cacheScopeKey={scope} />
  </WorkspaceProvider>);
  try {
    await act(async () => render("UTC"));
    if (phase === "ready") await act(async () => first.resolve({ content: [{ type: "text", text: "first-input" }] }));
    await act(async () => render("Asia/Tokyo"));
    expect(requests).toEqual([{ timeZone: "UTC" }, { timeZone: "Asia/Tokyo" }]);
    expect(released).toEqual(["changed-1"]);
    expect(container.querySelector("[data-sandbox-view]")).toBeNull();
    await act(async () => first.resolve({ content: [{ type: "text", text: "first-input" }] }));
    expect(container.querySelector("[data-sandbox-view]")).toBeNull();
    await act(async () => second.resolve({ content: [{ type: "text", text: "second-input" }] }));
    expect(sandboxView?.result?.content).toEqual([{ type: "text", text: "second-input" }]);
    expect(sandboxView?.origin.readOnly).toBe(false);
  } finally {
    await act(async () => root.unmount());
    container.remove();
    window.localStorage.removeItem(scope);
    Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", previousAct);
  }
});

test.each(["requiresApproval", "launchApproved"])("same-ID argument changes never replay a manual tile (%s)", async (policy) => {
  const previousAct = Reflect.get(globalThis, "IS_REACT_ACT_ENVIRONMENT");
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  const requests: unknown[] = [];
  const client: OpenworkServerClient = { ...createOpenworkServerClient({ baseUrl: "http://fixture.invalid" }),
    resolveMcpApp: async () => ({ app: { ...resource, launchId: "manual-input" } }),
    callMcpAppTool: async (_workspace, request) => { requests.push(request.arguments); return { content: [] }; },
    releaseMcpApp: async () => ({ released: true }),
  };
  const container = document.body.appendChild(document.createElement("div"));
  const root = createRoot(container);
  const scope = `manual-input-${policy}`;
  const render = (query: string) => root.render(<WorkspaceProvider client={null} openworkServerClient={client} workspaceId="fixture" selectedWorkspaceRoot="/fixture">
    <McpAppTile entry={{ kind: "mcp", id: "same-manual-id", title: "Fixture", serverName: resource.serverName,
      toolName: resource.toolName, projectedToolName: "fixture_render", resourceUri: resource.resourceUri,
      autoLaunch: true, requiresApproval: policy === "requiresApproval", launchApproved: policy === "launchApproved", launchArguments: { query } }} cacheScopeKey={scope} />
  </WorkspaceProvider>);
  const run = () => {
    const button = container.querySelector<HTMLButtonElement>('button[aria-label="Run Fixture"]');
    if (!button) throw new Error("Missing manual Run button");
    button.click();
  };
  try {
    await act(async () => render("first"));
    expect(requests).toEqual([]);
    await act(async () => run());
    expect(requests).toEqual([{ query: "first" }]);
    await act(async () => render("second"));
    expect(container.querySelector("[data-sandbox-view]")).toBeNull();
    for (let i = 0; i < 5; i++) await act(async () => { render("second"); window.dispatchEvent(new Event("focus")); });
    expect(requests).toEqual([{ query: "first" }]);
    await act(async () => run());
    expect(requests).toEqual([{ query: "first" }, { query: "second" }]);
  } finally {
    await act(async () => root.unmount());
    container.remove();
    window.localStorage.removeItem(scope);
    Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", previousAct);
  }
});

test.each(["success", "failure"])("generated dashboard refresh is bounded across rerenders, timer and focus (%s)", async (outcome) => {
  const previousAct = Reflect.get(globalThis, "IS_REACT_ACT_ENVIRONMENT");
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  let now = Date.parse("2026-09-14T12:00:00Z");
  const clock = spyOn(Date, "now").mockImplementation(() => now);
  const interval = spyOn(window, "setInterval");
  const hiddenDescriptor = Object.getOwnPropertyDescriptor(document, "hidden");
  let hidden = false;
  Object.defineProperty(document, "hidden", { configurable: true, get: () => hidden });
  const pending = Promise.withResolvers<{ content: Array<Record<string, unknown>> }>();
  let calls = 0;
  let resolutions = 0;
  let failing = outcome === "failure";
  const client: OpenworkServerClient = { ...createOpenworkServerClient({ baseUrl: "http://fixture.invalid" }),
    resolveMcpApp: async () => ({ app: { ...resource, serverName: "openwork-cloud", toolName: "run_artifact_arv_fixture", resourceUri: liveRevision.resourceUri, launchId: `timed-${++resolutions}` } }),
    callMcpAppTool: async () => {
      if (++calls === 2) return pending.promise;
      if (calls > 2 && failing) throw new OpenworkServerError(503, "server_unavailable", "Temporary failure");
      return { content: [] };
    },
    releaseMcpApp: async () => ({ released: true }),
  };
  const container = document.body.appendChild(document.createElement("div"));
  const root = createRoot(container);
  const render = () => root.render(<WorkspaceProvider client={null} openworkServerClient={client} workspaceId="fixture" selectedWorkspaceRoot="/fixture">
    <LiveGeneratedApp view={{ ...liveView }} revision={{ ...liveRevision }} fallbackEndpoints={[{ client, workspaceId: "fixture" }]} />
  </WorkspaceProvider>);
  const focus = () => { window.dispatchEvent(new Event("focus")); document.dispatchEvent(new Event("visibilitychange")); };
  try {
    await act(async () => render());
    const initialOrigin = sandboxView?.origin;
    for (let i = 0; i < 10; i++) await act(async () => { render(); focus(); });
    expect(calls).toBe(1);
    expect(sandboxView?.origin).toBe(initialOrigin);
    const timers = interval.mock.calls.filter(([, delay]) => delay === DASHBOARD_AUTO_REFRESH_INTERVAL_MS);
    expect(timers).toHaveLength(1);
    const tick = timers[0]?.[0];
    if (typeof tick !== "function") throw new Error("Missing dashboard timer");
    now += DASHBOARD_AUTO_REFRESH_INTERVAL_MS - 1;
    await act(async () => { tick(); focus(); });
    expect(calls).toBe(1);
    now++;
    hidden = true;
    await act(async () => { tick(); focus(); });
    expect(calls).toBe(1);
    hidden = false;
    await act(async () => { tick(); focus(); });
    expect(calls).toBe(2);
    for (let i = 0; i < 5; i++) await act(async () => { render(); tick(); focus(); });
    expect(calls).toBe(2);
    await act(async () => {
      if (outcome === "success") pending.resolve({ content: [] });
      else pending.reject(new OpenworkServerError(503, "server_unavailable", "Temporary failure"));
    });
    expect(container.querySelector("[data-sandbox-view]")).not.toBeNull();
    for (let i = 0; i < 5; i++) await act(async () => focus());
    expect(calls).toBe(2);
    failing = false;
    now += DASHBOARD_AUTO_REFRESH_INTERVAL_MS;
    await act(async () => { tick(); focus(); });
    expect(calls).toBe(3);
    expect(resolutions).toBe(3);
    await refreshCompactTile(container);
    expect(calls).toBe(4);
    expect(sandboxView?.origin.readOnly).toBe(false);
  } finally {
    await act(async () => root.unmount());
    container.remove();
    window.localStorage.removeItem(liveGeneratedAppCacheScope(viewerScope));
    clock.mockRestore();
    interval.mockRestore();
    if (hiddenDescriptor) Object.defineProperty(document, "hidden", hiddenDescriptor);
    else Reflect.deleteProperty(document, "hidden");
    Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", previousAct);
  }
});

test.each(["timer", "focus"])("generated day rollover via %s and caller changes isolate late results", async (trigger) => {
  const previousAct = Reflect.get(globalThis, "IS_REACT_ACT_ENVIRONMENT");
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const boundary = nextViewerDayBoundary(zone, Date.parse("2026-09-14T12:00:00Z"));
  let now = boundary - 1_000;
  const clock = spyOn(Date, "now").mockImplementation(() => now);
  const timeout = spyOn(globalThis, "setTimeout");
  const first = Promise.withResolvers<{ content: Array<Record<string, unknown>> }>();
  const third = Promise.withResolvers<{ content: Array<Record<string, unknown>> }>();
  const initialScope = viewerScope;
  const nextScope = ["fixture-host", "another-member", "fixture-org"];
  let calls = 0;
  let resolutions = 0;
  const released: string[] = [];
  const client: OpenworkServerClient = { ...createOpenworkServerClient({ baseUrl: "http://fixture.invalid" }),
    resolveMcpApp: async () => ({ app: { ...resource, serverName: "openwork-cloud", toolName: "run_artifact_arv_fixture", resourceUri: liveRevision.resourceUri, launchId: `day-${++resolutions}` } }),
    callMcpAppTool: async () => {
      if (++calls === 1) return first.promise;
      if (calls === 3) return third.promise;
      return { content: [{ type: "text", text: "new-day" }] };
    },
    releaseMcpApp: async (_workspace, id) => { released.push(id); return { released: true }; },
  };
  const container = document.body.appendChild(document.createElement("div"));
  const root = createRoot(container);
  const render = () => root.render(<WorkspaceProvider client={null} openworkServerClient={client} workspaceId="fixture" selectedWorkspaceRoot="/fixture">
    <LiveGeneratedApp view={{ ...liveView }} revision={{ ...liveRevision }} />
  </WorkspaceProvider>);
  try {
    await act(async () => render());
    expect(calls).toBe(1);
    now = boundary;
    await act(async () => {
      if (trigger === "focus") window.dispatchEvent(new Event("focus"));
      else {
        const tick = timeout.mock.calls.find(([, delay]) => delay === 1_000)?.[0];
        if (typeof tick !== "function") throw new Error("Missing local midnight timer");
        tick();
      }
    });
    expect(calls).toBe(2);
    expect(released).toEqual(["day-1"]);
    expect(sandboxView?.result?.content).toEqual([{ type: "text", text: "new-day" }]);
    await act(async () => first.resolve({ content: [{ type: "text", text: "late-old-day" }] }));
    expect(sandboxView?.result?.content).toEqual([{ type: "text", text: "new-day" }]);
    viewerScope = nextScope;
    await act(async () => render());
    expect(calls).toBe(3);
    expect(container.querySelector("[data-sandbox-view]")).toBeNull();
    expect(window.localStorage.getItem(liveGeneratedAppCacheScope(nextScope))).toBeNull();
    await act(async () => third.resolve({ content: [{ type: "text", text: "another-viewer" }] }));
    expect(sandboxView?.result?.content).toEqual([{ type: "text", text: "another-viewer" }]);
    for (let i = 0; i < 5; i++) await act(async () => { render(); window.dispatchEvent(new Event("focus")); });
    expect(calls).toBe(3);
    expect(sandboxView?.origin.readOnly).toBe(false);
    expect(window.localStorage.getItem(liveGeneratedAppCacheScope(initialScope))).not.toContain("late-old-day");
    expect(window.localStorage.getItem(liveGeneratedAppCacheScope(nextScope))).not.toContain("new-day");
  } finally {
    await act(async () => root.unmount());
    container.remove();
    viewerScope = initialScope;
    window.localStorage.removeItem(liveGeneratedAppCacheScope(initialScope));
    window.localStorage.removeItem(liveGeneratedAppCacheScope(nextScope));
    clock.mockRestore();
    timeout.mockRestore();
    Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", previousAct);
  }
});

test("reopening a tile paints caller-scoped cached data while refreshing and retains it on a transient failure", async () => {
  const previousAct = Reflect.get(globalThis, "IS_REACT_ACT_ENVIRONMENT");
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  const pending = Promise.withResolvers<{ content: Array<Record<string, unknown>> }>();
  let calls = 0;
  const client: OpenworkServerClient = { ...createOpenworkServerClient({ baseUrl: "http://fixture.invalid" }),
    resolveMcpApp: async () => ({ app: { ...resource, launchId: "cache-lease" } }),
    callMcpAppTool: async () => ++calls === 1 ? { content: [] } : pending.promise,
    releaseMcpApp: async () => ({ released: true }),
  };
  const entry: DashboardMcpAppEntry = { kind: "mcp", id: "cache-reopen", title: "Fixture", serverName: resource.serverName,
    toolName: resource.toolName, projectedToolName: "fixture_render", resourceUri: resource.resourceUri, autoLaunch: true };
  const container = document.body.appendChild(document.createElement("div"));
  let root = createRoot(container);
  const render = () => root.render(<WorkspaceProvider client={null} openworkServerClient={client} workspaceId="fixture" selectedWorkspaceRoot="/fixture">
    <McpAppTile entry={entry} cacheScopeKey="cache-reopen-scope" />
  </WorkspaceProvider>);
  try {
    await act(async () => render());
    expect(container.querySelector("[data-sandbox-view]")).not.toBeNull();
    await act(async () => root.unmount());
    root = createRoot(container);
    await act(async () => render());
    expect(calls).toBe(2);
    expect(container.querySelector("[data-sandbox-view]")).not.toBeNull();
    expect(sandboxView?.origin.readOnly).toBe(true);
    expect((await compactRefreshItem(container)).getAttribute("aria-disabled")).toBe("true");
    await act(async () => pending.reject(new OpenworkServerError(503, "server_unavailable", "Try again later")));
    expect(container.querySelector("[data-sandbox-view]")).not.toBeNull();
    expect(container.querySelector('[data-dashboard-cache-state="failed"]')).not.toBeNull();
  } finally {
    await act(async () => root.unmount());
    container.remove();
    window.localStorage.removeItem("cache-reopen-scope");
    Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", previousAct);
  }
});
