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

// Exercise the mounted tile and real action lifetime without starting an iframe or provider.
mock.module("@/components/chat/mcp-app-frame", () => ({
  McpAppSandboxView: ({ app, origin }: McpAppSandboxViewProps) => {
    const actions = useMemo(() => createMcpAppActions(origin, app), [origin, app]);
    const [message, setMessage] = useState("");
    useLayoutEffect(() => () => actions.dispose(), [actions]);
    return <div>
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

const resource: OpenworkMcpAppResource = {
  serverName: "fixture", toolName: "render", resourceUri: "ui://fixture/view.html", html: "<p>Fixture</p>",
  csp: { connectDomains: [], resourceDomains: [], frameDomains: [], baseUriDomains: [] }, prefersBorder: true,
};
const noRelease = async () => { throw new Error("No lease should be released"); };

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

test.each(["manual", "automatic", "forbidden", "repeated", "cancel", "unmount", "endpoint", "scope", "persisted"])("launch approval policy without native confirmation: %s", async (mode) => {
  const previousAct = Reflect.get(globalThis, "IS_REACT_ACT_ENVIRONMENT");
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  const confirmSpy = spyOn(window, "confirm").mockReturnValue(false);
  const calls: unknown[] = [];
  let approvedLaunches = 0;
  let autoLaunchDisabled = 0;
  let autoLaunchEnabled = 0;
  const client: OpenworkServerClient = { ...createOpenworkServerClient({ baseUrl: "http://fixture.invalid" }),
    resolveMcpApp: async () => ({ app: { ...resource, launchId: "launch-fixture" } }),
    callMcpAppTool: async (workspaceId, request) => {
      calls.push({ workspaceId, request });
      if (mode === "forbidden") throw new OpenworkServerError(403, "tool_denied", "Forbidden");
      if (mode === "repeated" || !request.approved) throw new OpenworkServerError(422, "tool_requires_approval", "Approval required");
      return { content: [] };
    },
    releaseMcpApp: async () => ({ released: true }),
  };
  const entry: DashboardMcpAppEntry = {
    kind: "mcp", id: "approval-tile", title: "Fixture", serverName: "fixture", toolName: "render",
    projectedToolName: "fixture_render", resourceUri: resource.resourceUri,
    autoLaunch: mode === "automatic", launchApproved: mode === "persisted", launchArguments: { query: "saved input" },
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
  const decision = (label: string) => {
    const found = Array.from(document.querySelectorAll<HTMLButtonElement>('[role="alertdialog"] button')).find(button => button.textContent === label);
    if (!found) throw new Error(`Missing decision ${label}`);
    return found;
  };
  try {
    await act(async () => render());
    if (mode !== "automatic") {
      expect(calls).toEqual([]);
      await act(async () => button("Run Fixture").click());
    }
    expect(calls).toEqual([{ workspaceId: "fixture", request }]);
    const retried = mode === "manual" || mode === "repeated";
    if (!["automatic", "forbidden", "persisted"].includes(mode)) {
      expect(document.querySelector('[role="alertdialog"]')?.textContent).toContain("Allow App action?");
      expect(document.querySelector('[role="alertdialog"] pre')?.textContent).toContain("saved input");
      if (entry.launchArguments) entry.launchArguments.query = "changed after request";
      if (mode === "unmount") { await act(async () => root.unmount()); mounted = false; }
      else if (mode === "endpoint") { connected = false; await act(async () => render()); }
      else if (mode === "scope") { scope = "another-principal"; await act(async () => render()); }
      else await act(async () => decision(retried ? "Allow once" : "Cancel").click());
    } else expect(document.querySelector('[role="alertdialog"]')).toBeNull();
    expect(document.querySelector('[role="alertdialog"]')).toBeNull();
    expect(calls).toEqual((retried ? [false, true] : [false]).map(approved => ({
      workspaceId: "fixture", request: { ...request, ...(approved ? { approved: true } : {}) },
    })));
    expect(approvedLaunches).toBe(0);
    expect(autoLaunchDisabled).toBe(["manual", "automatic", "repeated", "cancel"].includes(mode) ? 1 : 0);
    expect(autoLaunchEnabled).toBe(0);
    if (mode === "automatic") {
      expect(button("Run Fixture").disabled).toBe(false);
      expect(container.querySelector("[data-action-result]")).toBeNull();
      entry.autoLaunch = false;
      await act(async () => render());
      expect(calls).toHaveLength(1);
      expect(autoLaunchDisabled).toBe(1);
    } else if (mode === "manual") {
      expect(container.querySelector("[data-action-result]")).not.toBeNull();
      await act(async () => render());
      expect(calls).toHaveLength(2);
      await act(async () => button("Refresh Fixture").click());
      expect(calls).toEqual([
        { workspaceId: "fixture", request },
        { workspaceId: "fixture", request: { ...request, approved: true } },
        { workspaceId: "fixture", request: { ...request, arguments: { query: "changed after request" } } },
      ]);
      await act(async () => decision("Cancel").click());
      expect(calls).toHaveLength(3);
      expect(approvedLaunches).toBe(0);
      expect(autoLaunchEnabled).toBe(0);
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
    await act(async () => button('[aria-label="Refresh Fixture"]').click());
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
