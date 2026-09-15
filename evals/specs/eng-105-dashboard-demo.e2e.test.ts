import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { expect } from "vitest";
import { denFetch, evalIn, fill, signInInBrowser, waitFor, type DenSession } from "@openwork/behaviors";
import { browserScript, clickTarget, connect, debuggerUrlFor, evaluate, listTargets, navigate, type Surface } from "@openwork/cdp";
import { chrome } from "@openwork/hosts";
import { eventually, screenshot, test } from "@openwork/testkit";
import { bootAcmeDemoEng105 } from "../../worlds/acme-demo-eng105.ts";

// Den Web authors references; the two real desktops execute the referenced Apps.
// No Workflow snapshot, shared calendar credential, API-authored dashboard, or
// synthetic app HTML may stand in for this journey. Prerequisite failures fail
// this test (zero skip branches), and screenshots are supplementary to assertions.
const runName = new Date().toISOString().replaceAll(":", "-");
const reportDirectory = fileURLToPath(new URL(`../../reports/demo/eng105-proof/${runName}/`, import.meta.url));
const captures: { name: string; at: string; actor: string; status: string }[] = [];
const boardName = "Acme Day";

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function object(value: unknown): Record<string, unknown> {
  if (!isObject(value)) throw new Error("Expected an API object");
  return value;
}
function text(value: unknown, key: string): string {
  const result = object(value)[key];
  if (typeof result !== "string" || !result) throw new Error(`Expected ${key}`);
  return result;
}
function array(value: unknown, key: string): Record<string, unknown>[] {
  const result = object(value)[key];
  if (!Array.isArray(result)) throw new Error(`Expected ${key} array`);
  return result.map(object);
}
async function api(session: DenSession, orgId: string, path: string) {
  const result = await denFetch(session, path, { headers: {
    authorization: `Bearer ${session.token}`, "x-openwork-org-id": orgId,
  } });
  // Never include raw response bodies/headers: they can contain credentials.
  expect(result.response.status, `GET ${path}`).toBe(200);
  return result.body;
}
async function frame(surface: Surface, title: string): Promise<Surface & AsyncDisposable> {
  return eventually(async () => {
    // The released host nests srcdoc inside its sandbox proxy rather than
    // always creating a separate srcdoc target. Inspect the actual frame tree.
    const targets = (await listTargets(surface.handle.cdpUrl))
      .filter(target => target.type === "iframe" && (target.url === "about:srcdoc" || target.url.includes("/mcp-apps/sandbox.html")));
    for (const target of targets) {
      const raw = await connect(debuggerUrlFor(surface.handle.cdpUrl, target));
      let matched = false;
      try {
        const tree = object(await raw.send("Page.getFrameTree"));
        const frames: string[] = [];
        const visit = (value: unknown) => {
          const node = object(value);
          const current = object(node.frame);
          if (current.url === "about:srcdoc") frames.push(text(current, "id"));
          if (Array.isArray(node.childFrames)) node.childFrames.forEach(visit);
        };
        visit(tree.frameTree);
        for (const frameId of frames) {
          const context = object(await raw.send("Page.createIsolatedWorld", { frameId, worldName: "eng105-visible-app" }));
          const contextId = context.executionContextId;
          if (typeof contextId !== "number") throw new Error("Missing App execution context");
          const client = { ...raw, send: (method: string, params: Record<string, unknown> = {}, options?: { timeoutMs?: number }) => raw.send(method,
            method === "Runtime.evaluate" ? { ...params, contextId }
              : method === "Runtime.callFunctionOn" ? { ...params, executionContextId: contextId } : params, options) };
          matched = await evaluate(client, browserScript(title => document.title === title, [title]));
          if (matched) return { handle: surface.handle, client, [Symbol.asyncDispose]: async () => raw.close() };
        }
      } finally { if (!matched) raw.close(); }
    }
    throw new Error(`Real MCP App iframe not mounted: ${title}`);
  }, { within: 90_000, intervalMs: 1_000, label: `rendered ${title} iframe` });
}
async function checkpoint(surface: Surface, name: string) {
  const artifact = await screenshot(surface);
  await writeFile(`${reportDirectory}${name}.png`, artifact.png);
  captures.push({ name: `${name}.png`, at: artifact.at,
    actor: name.includes("jordan") ? "Jordan" : "Alex", status: "supplementary observation; see test-run verdict" });
  await writeFile(`${reportDirectory}captures.json`, JSON.stringify(captures, null, 2));
  const exportRoot = process.env.ENG105_EXPORT_DIR;
  if (exportRoot) {
    const directory = `${exportRoot}/${runName}`;
    await mkdir(directory, { recursive: true });
    await writeFile(`${directory}/${name}.png`, artifact.png);
    await writeFile(`${directory}/captures.json`, JSON.stringify(captures, null, 2));
  }
}
async function see(surface: Surface, value: string) {
  await waitFor(surface, browserScript(value => document.body.innerText.includes(value), [value]),
    { timeoutMs: 90_000, label: `visible ${value}` });
}
async function refresh(surface: Surface, title: string) {
  const calls = () => evalIn(surface, () => performance.getEntriesByType("resource")
    .filter(entry => new URL(entry.name).pathname.endsWith("/mcp-apps/call")).length);
  const before = await calls();
  // v0.18.46 uses a visible header Refresh button (the options menu is unreleased).
  await clickTarget(surface, { role: "button", label: `Refresh ${title}` });
  await eventually(calls, { within: 90_000, until: count => count > before, label: `${title} Refresh made a completed host tool request` });
}

interface CalendarView { name: string; identity: string; generation: number; meetings: string[] }
async function calendarView(surface: Surface): Promise<CalendarView> {
  return eventually(async () => {
    // These selectors inspect visible UI supplied by the real provider, not an
    // injected test report or an API-only payload.
    const result = await evalIn(surface, () => ({
      name: document.querySelector('[data-testid="calendar-name"]')?.textContent?.trim() ?? "",
      identity: document.querySelector('[data-testid="calendar-identity"]')?.textContent?.trim() ?? "",
      generation: Number(document.querySelector('[data-testid="calendar-generation"]')?.textContent?.match(/\d+/)?.[0]),
      meetings: [...document.querySelectorAll('[data-testid="calendar-meeting-title"]')].map(node => node.textContent?.trim() ?? ""),
    }));
    if (!result.name || !result.identity || !Number.isFinite(result.generation) || !result.meetings.length) {
      throw new Error("Calendar must visibly render its name, fingerprint, generation, and meetings");
    }
    return result;
  }, { within: 60_000, intervalMs: 1_000, label: "visible authenticated calendar" });
}

// Explicitly opt in when running. Missing opt-in is an error, not a green skip.
test("ENG-105 Den Web shares real MCP Apps; separate member calendars refresh independently and clock edits survive relaunch", { timeout: 1_800_000 }, async ({ place, evidence }) => {
  expect(process.env.OPENWORK_EVAL_E2E_TESTS, "Set OPENWORK_EVAL_E2E_TESTS=1").toBe("1");
  await mkdir(reportDirectory, { recursive: true });
  await using stack = new AsyncDisposableStack();
  const world = await bootAcmeDemoEng105(stack, place);
  const { den, alex, jordan, jordanSession, orgId } = world;
  expect(alex.handle.cdpUrl).not.toBe(jordan.handle.cdpUrl);
  expect(den.admin.email).not.toBe(jordanSession.email);
  const registrations = world.registrations.filter(receipt => receipt.phase === "registration");
  evidence.recordAssertionEvidence("Three real hosted org connections registered", JSON.stringify(registrations),
    registrations.length === 3 && registrations.every(receipt => receipt.ok && receipt.connectionId));
  expect(registrations).toHaveLength(3);
  expect(registrations.every(receipt => receipt.ok && receipt.connectionId)).toBe(true);
  await writeFile(`${reportDirectory}world-sanitized.json`, JSON.stringify({
    lane: place.kind, denWeb: den.ref.webUrl, denApi: den.ref.apiUrl,
    alexCdp: alex.handle.cdpUrl, jordanCdp: jordan.handle.cdpUrl,
    alexEmail: den.admin.email, jordanEmail: jordanSession.email, orgId, registrations,
  }, null, 2));

  const registration = (key: string) => {
    const value = registrations.find(receipt => receipt.key === key);
    if (!value?.connectionId) throw new Error(`Missing successful ${key} registration`);
    return { id: value.connectionId, url: value.url };
  };
  const home = registration("acme-home-demo");
  const clocks = registration("world-clocks-demo");
  const calendar = registration("personal-calendar-demo");
  const alexBrowser = stack.use(await chrome({ name: "eng105-alex-den-web", host: place.host(), startUrl: den.ref.webUrl, headless: true }));
  const jordanBrowser = stack.use(await chrome({ name: "eng105-jordan-den-web", host: place.host(), startUrl: den.ref.webUrl, headless: true }));
  expect(alexBrowser.handle.cdpUrl).not.toBe(jordanBrowser.handle.cdpUrl);

  try {
  const signIn = async (browser: Surface, session: DenSession) => {
    await navigate(browser.client, den.ref.webUrl);
    await signInInBrowser(browser, den.ref.webUrl, session);
    await waitFor(browser, () => location.pathname.startsWith("/dashboard"), { timeoutMs: 60_000, label: "signed in to owned Den" });
  };
  const yourCalendar = async (browser: Surface, session: DenSession, prefix: string) => {
    const before = array(await api(session, orgId, "/v1/mcp-connections?scope=usable"), "connections")
      .find(connection => connection.id === calendar.id);
    expect(before).toBeDefined();
    expect(before?.credentialMode).toBe("per_member");
    expect(before?.authType).toBe("oauth");
    expect(before?.connectedForMe, "No member credentials are pre-seeded").not.toBe(true);
    await navigate(browser.client, new URL(`/dashboard/your-connections?connectionId=${calendar.id}`, den.ref.webUrl).href);
    await see(browser, "Connect your account");
    await checkpoint(browser, `${prefix}-your-connections-before`);
    await clickTarget(browser, { testId: `connect-my-mcp-account-${calendar.id}` });
    // The real OAuth popup follows the AS's auto-approve redirect. We neither
    // manufacture a code/callback nor copy Alex's authorization to Jordan.
    await eventually(async () => array(await api(session, orgId, "/v1/mcp-connections?scope=usable"), "connections")
      .find(connection => connection.id === calendar.id), {
      within: 120_000, intervalMs: 2_000, label: `${prefix} OAuth completed`,
      until: connection => connection?.connectedForMe === true && connection.needsReconnect !== true,
    });
    await see(browser, "Connected as you");
    await checkpoint(browser, `${prefix}-your-connections-connected`);
  };
  await signIn(alexBrowser, den.admin);
  await navigate(alexBrowser.client, new URL("/dashboard/mcp-connections", den.ref.webUrl).href);
  await see(alexBrowser, "Acme Home");
  await see(alexBrowser, "World Clocks");
  await see(alexBrowser, "Personal Calendar");
  await checkpoint(alexBrowser, "00-alex-organization-connections");
  await yourCalendar(alexBrowser, den.admin, "01-alex");

  const catalog = async (id: string) => array(await api(den.admin, orgId, `/v1/mcp-connections/${id}/mcp-apps`), "apps");
  const homeApps = await catalog(home.id);
  const clockApps = await catalog(clocks.id);
  const calendarApps = await catalog(calendar.id);
  const homeApp = homeApps.find(app => app.toolName === "acme_home");
  const clockApp = clockApps.find(app => app.toolName === "show_world_clocks");
  expect(homeApp).toBeDefined();
  expect(clockApp).toBeDefined();
  expect(calendarApps).toHaveLength(1);
  const calendarApp = calendarApps[0];
  if (!homeApp || !clockApp || !calendarApp) throw new Error("Missing real MCP App catalog entries");
  expect(homeApp.resourceUri).toBe("ui://acme-home/home.html");
  expect(clockApp.resourceUri).toBe("ui://world-clocks/mcp-app.html");
  expect(text(calendarApp, "resourceUri")).toMatch(/^ui:\/\//);

  await navigate(alexBrowser.client, new URL("/dashboard/dashboards", den.ref.webUrl).href);
  await clickTarget(alexBrowser, { role: "button", label: "New dashboard" });
  await fill(alexBrowser, 'input[placeholder="Support overview"]', boardName);
  await clickTarget(alexBrowser, { role: "button", label: "Create dashboard" });
  await see(alexBrowser, "Who sees this dashboard");
  const dashboardId = await evalIn(alexBrowser, () => location.pathname.split("/").at(-1));
  if (typeof dashboardId !== "string" || !dashboardId.startsWith("dsb_")) throw new Error("Dashboard detail route missing");
  const readBoard = () => api(den.admin, orgId, `/v1/dashboards/${dashboardId}`);
  for (const [index, entry] of [
    { connection: home, name: "Acme Home", app: homeApp },
    { connection: clocks, name: "World Clocks", app: clockApp },
    { connection: calendar, name: "Personal Calendar", app: calendarApp },
  ].entries()) {
    await clickTarget(alexBrowser, { role: "button", label: "Add app" });
    await clickTarget(alexBrowser, { role: "button", label: "MCP" });
    await clickTarget(alexBrowser, { role: "option", label: entry.name });
    await see(alexBrowser, text(entry.app, "title"));
    // Default {} is intentional: no explicit city list or identity overrides.
    expect(entry.app.requiresInput, "Demo launch requires no identity/city input").not.toBe(true);
    await clickTarget(alexBrowser, { role: "button", label: "Add" });
    await eventually(async () => array(object(await readBoard()).item, "elements").length,
      { within: 30_000, until: count => count === index + 1, label: "UI Add persisted" });
    await clickTarget(alexBrowser, { role: "button", label: "Done" });
    await clickTarget(alexBrowser, { role: "switch", label: `Run ${text(entry.app, "title")} automatically, even if it modifies data` });
    await eventually(async () => array(object(await readBoard()).item, "elements")[index]?.organizationAutoLaunch,
      { within: 30_000, until: value => value === true, label: "UI organization auto-run persisted" });
    await checkpoint(alexBrowser, `0${index + 2}-den-add-${entry.name.toLowerCase().replaceAll(" ", "-")}`);
  }
  const elements = array(object(await readBoard()).item, "elements");
  expect(elements).toHaveLength(3);
  for (const element of elements) {
    expect(element.launchArguments, "Released UI omits empty defaults; host launches with {}").toBeUndefined();
    expect(element.organizationAutoLaunch).toBe(true);
    expect(element.connectionId).toBeDefined();
    expect(text(element, "resourceUri")).toMatch(/^ui:\/\//);
  }

  const org = object(await api(den.admin, orgId, "/v1/org"));
  const members = array(org, "members");
  const membership = (email: string) => {
    const found = members.find(member => object(member.user).email === email);
    if (!found) throw new Error("Missing named organization membership");
    return text(found, "id");
  };
  for (const session of [den.admin, jordanSession]) {
    await clickTarget(alexBrowser, { role: "button", label: "Add person" });
    await fill(alexBrowser, 'input[placeholder="Search people..."]', session.email);
    await clickTarget(alexBrowser, { role: "button", label: new RegExp(session.email.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")) });
    await clickTarget(alexBrowser, { role: "button", label: "Grant" });
    await eventually(async () => array(await api(den.admin, orgId, `/v1/dashboards/${dashboardId}/access`), "items")
      .some(grant => grant.orgMembershipId === membership(session.email) && grant.removedAt === null),
    { within: 30_000, until: Boolean, label: "named viewer grant persisted" });
  }
  const grants = array(await api(den.admin, orgId, `/v1/dashboards/${dashboardId}/access`), "items").filter(grant => grant.removedAt === null);
  expect(grants.map(grant => grant.orgMembershipId).sort()).toEqual([membership(den.admin.email), membership(jordanSession.email)].sort());
  expect(grants.every(grant => grant.role === "viewer" && grant.teamId == null)).toBe(true);
  await checkpoint(alexBrowser, "05-den-named-sharing");
  const jordanGranted = array(await api(jordanSession, orgId, "/v1/me/dashboards"), "items").find(item => item.id === dashboardId);
  expect(jordanGranted).toBeDefined();
  expect(jordanGranted?.elements).toEqual(elements);
  evidence.recordAssertionEvidence("Real Den Web Add, auto-run and named-person grants persist references, not calendar data", JSON.stringify({ dashboardId, elements, grants }), true);

  await signIn(jordanBrowser, jordanSession);
  await yourCalendar(jordanBrowser, jordanSession, "06-jordan");
  for (const [surface, label] of [[alex, "alex"], [jordan, "jordan"]] satisfies [Surface, string][]) {
    await evalIn(surface, () => performance.setResourceTimingBufferSize(5000));
    await clickTarget(surface, { role: "button", label: "Dashboard" });
    await waitFor(surface, browserScript(id => Boolean(document.querySelector(`[data-granted-dashboard="${id}"]`)), [dashboardId]),
      { timeoutMs: 90_000, label: `${label} sees granted dashboard` });
    await see(surface, boardName);
    await using homeFrame = await frame(surface, "Acme Home");
    await see(homeFrame, "Today at a Glance");
    await see(homeFrame, "Needs Your Attention");
    await see(homeFrame, "My Goals");
    expect(await evalIn(homeFrame, () => ({
      brand: document.querySelector(".brand")?.textContent?.trim(),
      greeting: document.querySelector("h1")?.textContent?.trim(),
      widgets: document.querySelectorAll(".widget").length,
    }))).toEqual({ brand: "Acme Home", greeting: expect.stringMatching(/^Good (morning|afternoon|evening)!$/), widgets: 3 });
    await checkpoint(surface, `07-${label}-shared-dashboard`);
  }

  // Provider document titles and visible test IDs are part of the demo contract.
  await using alexCalendar = await frame(alex, "Personal Calendar");
  await using jordanCalendar = await frame(jordan, "Personal Calendar");
  const a = await calendarView(alexCalendar);
  const j = await calendarView(jordanCalendar);
  expect(a.name).not.toBe(j.name);
  expect(a.identity).not.toBe(j.identity);
  expect(a.meetings).not.toEqual(j.meetings);
  await checkpoint(alex, "08-alex-personal-calendar");
  await checkpoint(jordan, "09-jordan-different-personal-calendar");
  const refreshed: CalendarView[] = [];
  for (const [surface, before, member] of [[alex, a, "alex"], [jordan, j, "jordan"]] satisfies [Surface, CalendarView, string][]) {
    await refresh(surface, text(calendarApp, "title"));
    await using calendarFrame = await frame(surface, "Personal Calendar");
    const after = await eventually(() => calendarView(calendarFrame), {
      within: 90_000, until: view => view.generation > before.generation, label: `${member} Refresh executes a fresh tool generation`,
    });
    expect(after.name).toBe(before.name);
    expect(after.identity).toBe(before.identity);
    expect(after.meetings).toEqual(before.meetings);
    refreshed.push(after);
    await checkpoint(surface, `10-${member}-calendar-refreshed`);
  }
  expect(refreshed[0].identity).not.toBe(refreshed[1].identity);
  expect(array(object(await readBoard()).item, "elements")).toEqual(elements);
  evidence.recordAssertionEvidence("Separate OAuth members render different names and meetings; Refresh keeps each identity and increases generation with unchanged {}", JSON.stringify({ alex: a, jordan: j, refreshed }), true);

  await using clockFrame = await frame(alex, "World Clocks");
  await clickTarget(clockFrame, { role: "button", label: "Edit" });
  await clickTarget(clockFrame, { role: "combobox", label: "Add a city" });
  await fill(clockFrame, '[role="combobox"]', "Tokyo");
  await clickTarget(clockFrame, { role: "option", label: /Tokyo/ });
  await see(clockFrame, "Tokyo");
  await waitFor(clockFrame, () => /Saved \(shared with everyone\)|Saved to your account/.test(document.body.innerText),
    { timeoutMs: 30_000, label: "save_preferences completed, not merely Done" });
  await checkpoint(alex, "11-world-clocks-edit-saved");
  await clickTarget(clockFrame, { role: "button", label: "Done" });
  await refresh(alex, text(clockApp, "title"));
  await using freshClocks = await frame(alex, "World Clocks");
  await see(freshClocks, "Tokyo");
  await checkpoint(alex, "12-world-clocks-fresh-tool-persisted");
  expect(array(object(await readBoard()).item, "elements")).toEqual(elements);
  evidence.recordAssertionEvidence("World Clocks city edit persists through host Refresh using {}, not cold-start durability", "Tokyo remains visible after save_preferences acknowledgement and fresh show_world_clocks launch; dashboard launch arguments remain unchanged.", true);
  await writeFile(`${reportDirectory}observations.json`, JSON.stringify({ dashboardId, alex: a, jordan: j, refreshed, clockCity: "Tokyo", lane: place.kind }, null, 2));
  } catch (error) {
    for (const [surface, name] of [[alex, "failed-alex-desktop"], [jordan, "failed-jordan-desktop"], [alexBrowser, "failed-alex-den-web"], [jordanBrowser, "failed-jordan-den-web"]] satisfies [Surface, string][]) {
      // Never photograph the authentication form or OAuth authorization URL.
      const safe = await evalIn(surface, () => !document.querySelector('input[type="password"]')
        && !/[?&](code|token|state)=/.test(location.search)
        && (location.hash.includes("/dashboard") || location.pathname.startsWith("/dashboard"))).catch(() => false);
      if (safe) await checkpoint(surface, name).catch(() => undefined);
    }
    throw error;
  }
});
