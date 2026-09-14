import { afterAll, afterEach, beforeEach, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { notifyManager, QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import type { SavedAppDetail } from "@openwork/types/workflows";

GlobalRegistrator.register({ url: "http://localhost/" });
const previousAct = Reflect.get(globalThis, "IS_REACT_ACT_ENVIRONMENT");
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
notifyManager.setScheduler(queueMicrotask);

const scope = ["fixture", "member", "org"];
const writes = mock(async () => { throw new Error("Updating must not save, activate, delete or recreate an app"); });
let detail: SavedAppDetail;
const client = {
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
  GeneratedAppPreview: () => <div data-preview>Working preview</div>,
}));

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

async function render(surface: string, withLauncher = true) {
  cache.setQueryData(["saved-apps", ...scope], { enabled: true, sharingEnabled: false, items: [detail] });
  cache.setQueryData(["app-preview", ...scope, detail.view.id, undefined, undefined], detail);
  await act(async () => root.render(<QueryClientProvider client={cache}><MemoryRouter>
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
