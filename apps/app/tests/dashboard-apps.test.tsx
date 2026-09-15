import { afterAll, afterEach, beforeEach, expect, mock, test, setSystemTime, spyOn } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, useLocation } from "react-router";
import { notifyManager, QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import type { GeneratedArtifactViewRevision, SavedAppDetail } from "@openwork/types/workflows";

import type { DashboardTileActions } from "../src/react-app/domains/dashboard/dashboard-tile-shell";

GlobalRegistrator.register({ url: "http://localhost/" });
const previousAct = Reflect.get(globalThis, "IS_REACT_ACT_ENVIRONMENT");
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
notifyManager.setScheduler(queueMicrotask);

const scope = ["fixture", "member", "org"];
const writes = mock(async () => { throw new Error("Updating must not save, activate, delete or recreate an app"); });
let detail: SavedAppDetail;
const client = {
  listSavedApps: mock(async () => ({ items: [detail] })),
  getSavedApp: mock(async () => detail),
  saveApp: writes,
  deleteApp: writes,
  setAppOnDashboard: writes,
};
mock.module("../src/react-app/domains/apps/use-apps", () => ({
  useAppsClient: () => ({ client, orgId: "org", scope }),
  useSavedApps: () => ({
    client, orgId: "org", scope, available: true,
    query: useQuery({ queryKey: ["saved-apps", ...scope], queryFn: async () => ({ enabled: true, sharingEnabled: false, items: [detail] }) }),
  }),
}));
mock.module("../src/react-app/domains/apps/generated-app-preview", () => ({
  GeneratedAppPreview: ({ presentation }: { presentation?: string }) => <div data-preview data-presentation={presentation} style={{ height: 720 }}>Working preview</div>,
}));

const { DashboardTileShell } = await import("../src/react-app/domains/dashboard/dashboard-tile-shell");
const refresh = mock(() => {});
mock.module("../src/react-app/domains/dashboard/mcp-app-tile", () => ({
  McpAppTile: ({ entry, cacheScopeKey, renderActions }: { entry: { title: string; toolName: string; launchArguments?: Record<string, unknown> }; cacheScopeKey: string; renderActions?: DashboardTileActions }) =>
    <DashboardTileShell title={entry.title} compact renderActions={renderActions} onRefresh={refresh} badge={<span>Updated just now</span>}>
      <div data-live-tool={entry.toolName} data-live-scope={cacheScopeKey} style={{ height: 720 }}>{JSON.stringify(entry.launchArguments)}</div>
    </DashboardTileShell>,
}));

mock.module("../src/react-app/domains/dashboard/dashboard-connection-card", () => ({
  DashboardConnectionCard: ({ onConnected }: { onConnected: () => void }) => <button data-connection onClick={onConnected}>Reconnect preview</button>,
}));

const { useViewerDay } = await import("../src/react-app/domains/apps/live-generated-app");
const { nextViewerDayBoundary, liveGeneratedAppEntry, liveGeneratedAppCacheScope } = await import("../src/react-app/domains/apps/live-generated-app-model");
const { readDashboardTileCache, writeDashboardTileCache } = await import("../src/react-app/domains/dashboard/dashboard-tile-cache");
const { DashboardApps } = await import("../src/react-app/domains/dashboard/dashboard-apps");
const { AppArtifact } = await import("../src/react-app/domains/apps/app-artifact");

function unavailable(): SavedAppDetail {
  return {
    view: {
      id: "arv_exact_app", configObjectId: "cob_exact_workflow", title: "Weekly report", description: null,
      status: "active", activeRevisionId: "revision_saved", revisions: [],
      createdAt: "2026-09-14T00:00:00.000Z", updatedAt: "2026-09-14T00:00:00.000Z",
    },
    workflowTitle: "Weekly report workflow", canManage: true, onDashboard: true,
    revision: null, html: null, payload: null,
    previewNotice: "Les résultats ont changé.",
  };
}

let container: HTMLDivElement;
let root: Root;
let cache: QueryClient;
let launch = mock(async (_prompt: string) => {});

beforeEach(() => {
  detail = unavailable();
  writes.mockClear();
  refresh.mockClear();
  client.getSavedApp.mockClear();
  launch = mock(async (_prompt: string) => {});
  cache = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity, gcTime: Infinity }, mutations: { retry: false } } });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  cache.clear();
  expect(writes).not.toHaveBeenCalled();
});

afterAll(async () => {
  notifyManager.setScheduler((callback) => setTimeout(callback, 0));
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", previousAct);
  await GlobalRegistrator.unregister();
});

function Location() { return <output data-location>{useLocation().pathname}</output>; }

async function render(surface: string, withLauncher = true) {
  cache.setQueryData(["saved-apps", ...scope], { enabled: true, sharingEnabled: false, items: [detail] });
  cache.setQueryData(["app-preview", ...scope, detail.view.id, undefined, undefined], detail);
  await act(async () => root.render(<QueryClientProvider client={cache}><MemoryRouter>
    <Location />
    {surface === "dashboard" ? <DashboardApps onCreateApp={launch} /> : <AppArtifact appId={detail.view.id} onAsk={withLauncher ? launch : undefined} />}
  </MemoryRouter></QueryClientProvider>));
}

function findButton(text: string) {
  return Array.from(container.querySelectorAll("button")).find((button) => button.textContent === text);
}

function button(text: string) {
  const found = findButton(text);
  if (!found) throw new Error(`Missing button: ${text}`);
  return found;
}

async function openMenu() {
  const trigger = container.querySelector<HTMLButtonElement>(`[aria-label="App options for ${detail.view.title}"]`);
  if (!trigger) throw new Error("Missing app menu");
  await act(async () => trigger.click());
}

function updateMenuItem() {
  return Array.from(document.querySelectorAll<HTMLElement>('[role="menuitem"]')).find((item) => item.textContent === "Update app");
}

function expectRepairPrompt(prompt: string | undefined) {
  expect(prompt).toContain(`artifactViewId: ${detail.view.id}`);
  expect(prompt).toContain(`configObjectId: ${detail.view.configObjectId}`);
  expect(prompt).toContain("Read its existing source with read_artifact_view before editing");
  expect(prompt).toContain("Adapt the app to the latest workflow output");
  expect(prompt).toContain("Preserve the existing artifactViewId and configObjectId");
  expect(prompt).toContain("save_artifact_view");
  expect(prompt).toContain("do not recreate the app or workflow");
  expect(prompt).toContain("Show a draft preview");
  expect(prompt).toContain("explicitly choose Save");
  expect(prompt).toContain("Do not autoactivate");
}

test.each(["dashboard", "artifact"])("%s update button and menu draft the same identity-bound repair request", async (surface) => {
  await render(surface);
  expect(container.textContent).toContain(detail.previewNotice);
  expect(launch).not.toHaveBeenCalled();
  await act(async () => button("Update app").click());
  expect(launch).toHaveBeenCalledTimes(1);
  expectRepairPrompt(launch.mock.calls[0]?.[0]);
  await openMenu();
  const item = updateMenuItem();
  if (!item) throw new Error("Missing Update app menu item");
  await act(async () => item.click());
  expect(launch).toHaveBeenCalledTimes(2);
  expect(launch.mock.calls[1]?.[0]).toBe(launch.mock.calls[0]?.[0]);
});

test.each(["dashboard", "artifact"])("%s disables update while opening and supports retry after a launcher error", async (surface) => {
  const opening = Promise.withResolvers<void>();
  launch.mockImplementationOnce(() => opening.promise);
  await render(surface);
  await act(async () => button("Update app").click());
  expect(button("Opening conversation…").disabled).toBe(true);
  expect(container.querySelector<HTMLButtonElement>('[aria-label^="App options"]')?.disabled).toBe(true);
  await act(async () => button("Opening conversation…").click());
  expect(launch).toHaveBeenCalledTimes(1);
  await act(async () => opening.reject(new Error("Workspace disconnected")));
  expect(container.querySelector('[role="alert"]')?.textContent).toBe("Workspace disconnected");
  expect(button("Update app").disabled).toBe(false);
  await act(async () => button("Update app").click());
  expect(launch).toHaveBeenCalledTimes(2);
  expect(container.querySelector('[role="alert"]')).toBeNull();
});

test.each(["dashboard", "artifact"])("%s viewers see the warning but no editing controls", async (surface) => {
  detail.canManage = false;
  await render(surface);
  expect(container.textContent).toContain(detail.previewNotice);
  expect(findButton("Update app")).toBeUndefined();
  if (surface === "dashboard") await openMenu();
  expect(updateMenuItem()).toBeUndefined();
  expect(Array.from(document.querySelectorAll('[role="menuitem"]')).some((item) => item.textContent === "Ask for changes")).toBe(false);
  expect(launch).not.toHaveBeenCalled();
});

test.each(["dashboard", "artifact"])("%s does not offer repair without a preview notice", async (surface) => {
  detail.previewNotice = null;
  await render(surface);
  expect(findButton("Update app")).toBeUndefined();
  await openMenu();
  expect(updateMenuItem()).toBeUndefined();
  expect(launch).not.toHaveBeenCalled();
});

test.each(["dashboard", "artifact"])("%s leaves a working preview unchanged even when a notice is present", async (surface) => {
  workingDetail();
  await render(surface);
  expect(container.querySelector("[data-preview]")?.textContent).toBe("Working preview");
  expect(findButton("Update app")).toBeUndefined();
  await openMenu();
  expect(updateMenuItem()).toBeUndefined();
  expect(launch).not.toHaveBeenCalled();
});

test("artifact without a conversation launcher leaves the warning read-only", async () => {
  await render("artifact", false);
  expect(container.textContent).toContain(detail.previewNotice);
  expect(findButton("Update app")).toBeUndefined();
  await openMenu();
  expect(updateMenuItem()).toBeUndefined();
  expect(launch).not.toHaveBeenCalled();
});

test.each(["dashboard", "artifact"])("%s launches live saved apps through the MCP tile without a stored payload", async (surface) => {
  detail.view = { ...detail.view, dataMode: "live", revisions: [{
    id: "revision_saved", artifactViewId: detail.view.id, resourceUri: "ui://openwork/artifacts/fixture",
    buildStatus: "ready", sourceDigest: "source", resourceDigest: "resource", outputSchemaDigest: "schema",
    csp: { connectDomains: [], resourceDomains: [], frameDomains: [], baseUriDomains: [] }, diagnostics: [],
    compilerName: "fixture", compilerVersion: "1", reactVersion: "19", compiledHtmlBytes: 13, retiredAt: null,
    createdAt: detail.view.createdAt,
  }] };
  detail.revision = detail.view.revisions[0];
  await render(surface);
  expect(container.querySelector("[data-live-tool]")?.getAttribute("data-live-tool")).toBe(`run_artifact_${detail.view.id}`);
  expect(container.querySelector("[data-live-tool]")?.textContent).toContain(Intl.DateTimeFormat().resolvedOptions().timeZone);
  expect(container.querySelector("[data-preview]")).toBeNull();
  expect(client.getSavedApp).not.toHaveBeenCalled();
});

test("draft connection errors replace payloads and reconnect refetches the exact revision with viewer zone", async () => {
  workingDetail();
  detail = { ...detail, html: "stale preview", runError: { connectionCard: {
    schemaVersion: "1", connectionId: "emc_fixture", connectionName: "Calendar", state: "needs_connection",
    actor: "member", message: "Connect your calendar", action: { type: "connect", label: "Connect", surface: "openwork_your_connections" },
  } } };
  await act(async () => root.render(<QueryClientProvider client={cache}><MemoryRouter>
    <AppArtifact appId={detail.view.id} revisionId="avr_draft" />
  </MemoryRouter></QueryClientProvider>));
  expect(container.querySelector("[data-connection]")).not.toBeNull();
  expect(container.querySelector("[data-preview]")).toBeNull();
  const expected = ["org", detail.view.id, { revisionId: "avr_draft", receiptId: undefined, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone }];
  expect(client.getSavedApp.mock.calls[0]).toEqual(expected);
  await act(async () => button("Reconnect preview").click());
  expect(client.getSavedApp.mock.calls[1]).toEqual(expected);
  client.getSavedApp.mockImplementationOnce(async () => { throw new Error("Preview unavailable"); });
  await act(async () => button("Reconnect preview").click());
  expect(container.textContent).toContain("Preview unavailable");
  expect(container.querySelector("[data-preview]")).toBeNull();
  expect(container.querySelector("[data-connection]")).toBeNull();
});

test("viewer day rechecks on focus after sleeping across midnight", async () => {
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const boundary = nextViewerDayBoundary(zone, Date.parse("2026-09-14T12:00:00Z"));
  const readDays: number[] = [];
  function Probe() { const viewer = useViewerDay(); readDays.push(viewer.now); return null; }
  try {
    setSystemTime(boundary - 1000);
    await act(async () => root.render(<Probe />));
    expect(readDays.at(-1)).toBe(boundary - 1000);
    setSystemTime(boundary + 1000);
    await act(async () => { window.dispatchEvent(new Event("focus")); });
    expect(readDays.at(-1)).toBe(boundary + 1000);
  } finally {
    await act(async () => root.render(null));
    setSystemTime();
  }
});

test("viewer day schedules midnight and advances without a focus event", async () => {
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const boundary = nextViewerDayBoundary(zone, Date.parse("2026-09-14T12:00:00Z"));
  let midnight: (() => void) | undefined;
  const original = globalThis.setTimeout;
  const timers = spyOn(globalThis, "setTimeout").mockImplementation((handler, delay, ...args) => {
    if (delay === 1000 && typeof handler === "function") midnight = () => handler(...args);
    return original(handler, delay, ...args);
  });
  const readDays: number[] = [];
  function Probe() { const viewer = useViewerDay(); readDays.push(viewer.now); return null; }
  try {
    setSystemTime(boundary - 1000);
    await act(async () => root.render(<Probe />));
    expect(midnight).toBeDefined();
    setSystemTime(boundary);
    await act(async () => { midnight?.(); });
    expect(readDays.at(-1)).toBe(boundary);
  } finally {
    await act(async () => root.render(null));
    timers.mockRestore();
    setSystemTime();
  }
});

test("yesterday's successful live payload cannot be loaded after midnight", () => {
  const revision: GeneratedArtifactViewRevision = { id: "avr_fixture", artifactViewId: detail.view.id, resourceUri: "ui://fixture/revision",
    buildStatus: "ready", sourceDigest: "source", resourceDigest: "resource", outputSchemaDigest: "output",
    csp: { connectDomains: [], resourceDomains: [], frameDomains: [], baseUriDomains: [] }, diagnostics: [],
    compilerName: "fixture", compilerVersion: "1", reactVersion: "19", compiledHtmlBytes: 10,
    retiredAt: null, createdAt: "2026-09-14T00:00:00Z" };
  const midnight = Date.parse("2026-09-15T00:00:00Z");
  const yesterday = liveGeneratedAppEntry(detail.view, revision, "UTC", midnight - 1);
  const today = liveGeneratedAppEntry(detail.view, revision, "UTC", midnight);
  const cacheScope = liveGeneratedAppCacheScope(scope);
  writeDashboardTileCache(cacheScope, yesterday.id, {
    cachedAt: midnight - 1, workspaceId: "workspace", app: { serverName: "openwork-cloud", toolName: yesterday.toolName,
      resourceUri: revision.resourceUri, html: "Yesterday", prefersBorder: false, csp: revision.csp },
    result: { content: [{ type: "text", text: "Yesterday's private results" }] },
  });
  expect(readDashboardTileCache(cacheScope, yesterday.id, midnight)).not.toBeNull();
  expect(readDashboardTileCache(cacheScope, today.id, midnight)).toBeNull();
  window.localStorage.removeItem(cacheScope);
});

test.each(["live", "snapshot"])("%s saved tiles have no duplicate card or height cap and keep one accessible actions menu", async (mode) => {
  workingDetail();
  if (mode === "live") detail.view = { ...detail.view, dataMode: "live", revisions: detail.revision ? [detail.revision] : [] };
  await render("dashboard");
  const tile = container.querySelector<HTMLElement>("[data-personal-dashboard-app]");
  expect(tile).not.toBeNull();
  expect(tile?.closest("[data-dashboard-masonry]")).not.toBeNull();
  expect(tile?.querySelector("header")).toBeNull();
  expect(tile?.textContent).not.toContain("Open app");
  expect(tile?.className).not.toMatch(/border|overflow-hidden/);
  const preview = tile?.querySelector<HTMLElement>(mode === "live" ? "[data-live-tool]" : "[data-preview]");
  expect(preview?.style.height).toBe("720px");
  for (let parent = preview?.parentElement; parent && parent !== tile?.parentElement; parent = parent.parentElement) {
    expect(parent.className).not.toMatch(/max-h-|overflow-auto|overflow-y-auto/);
  }
  if (mode === "snapshot") expect(preview?.dataset.presentation).toBe("dashboard");
  const triggers = tile?.querySelectorAll<HTMLButtonElement>('[aria-label^="App options"]');
  expect(triggers?.length).toBe(1);
  expect(triggers?.[0]?.disabled).toBe(false);
  expect(triggers?.[0]?.tabIndex).toBe(0);
  expect(triggers?.[0]?.parentElement?.className).toContain("focus-within:opacity-100");
  await openMenu();
  expect(document.querySelector(`[aria-label="Remove ${detail.view.title} from dashboard"]`)).not.toBeNull();
  expect(document.querySelector(`[aria-label="Delete ${detail.view.title}"]`)).not.toBeNull();
  const open = document.querySelector<HTMLElement>(`[role="menuitem"][aria-label="Open ${detail.view.title}"]`);
  expect(open).not.toBeNull();
  await act(async () => open?.click());
  expect(container.querySelector("[data-location]")?.textContent).toBe(`/dashboard/apps/${detail.view.id}`);
  if (mode === "live") {
    await openMenu();
    expect(document.body.textContent).toContain("Updated just now");
    const item = document.querySelector<HTMLElement>(`[role="menuitem"][aria-label="Refresh ${detail.view.title}"]`);
    expect(item).not.toBeNull();
    await act(async () => item?.click());
    expect(refresh).toHaveBeenCalledTimes(1);
  }
});

test("saved app options open by keyboard and deletion still requires confirmation", async () => {
  workingDetail();
  await render("dashboard");
  const trigger = container.querySelector<HTMLButtonElement>('[aria-label^="App options"]');
  if (!trigger) throw new Error("Missing app options");
  await act(async () => {
    trigger.focus();
    trigger.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
  });
  expect(trigger.getAttribute("aria-expanded")).toBe("true");
  const deletion = document.querySelector<HTMLElement>(`[role="menuitem"][aria-label="Delete ${detail.view.title}"]`);
  expect(deletion).not.toBeNull();
  await act(async () => deletion?.click());
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain(`Delete “${detail.view.title}”?`);
  expect(writes).not.toHaveBeenCalled();
  const cancel = Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find((item) => item.textContent === "Cancel");
  await act(async () => cancel?.click());
  expect(document.querySelector('[role="dialog"]')).toBeNull();
});

function workingDetail() {
  detail.html = "<p>Report</p>";
  detail.revision = {
    id: "revision_saved", artifactViewId: detail.view.id, resourceUri: "ui://openwork/artifacts/fixture",
    buildStatus: "ready", sourceDigest: "source", resourceDigest: "resource", outputSchemaDigest: "schema",
    csp: { connectDomains: [], resourceDomains: [], frameDomains: [], baseUriDomains: [] }, diagnostics: [],
    compilerName: "fixture", compilerVersion: "1", reactVersion: "19", compiledHtmlBytes: 13, retiredAt: null,
    createdAt: detail.view.createdAt,
  };
  detail.payload = {
    schemaVersion: "1", data: { count: 1 }, artifact: {
      title: detail.view.title, description: null, pluginId: "plugin", configObjectId: detail.view.configObjectId,
      configObjectVersionId: "version", receiptId: "receipt", automationRunId: null, source: "manual",
      generatedAt: detail.view.updatedAt, resultDigest: "result", rendererVersion: "codemode-markdown-v1",
      freshness: { state: "fresh", ageMs: 0 },
    },
  };
}
