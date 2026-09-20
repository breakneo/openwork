import { expect } from "vitest";
import { spec } from "@openwork/testkit";

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Expected object");
  return Object.fromEntries(Object.entries(value));
}
function text(value: unknown): string {
  if (typeof value !== "string") throw new Error("Expected string");
  return value;
}
function items(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) throw new Error("Expected list");
  return value.map(record);
}
function expression(match: Record<string, unknown> | undefined): string {
  return text(match?.signature).split("(input:")[0];
}
type Persona = "owner" | "teammate" | "outsider";

const test = spec.world(async (seed) => {
  // This is the deployment-enabled backend foundation, not OpenWork chat:
  // worlds/code-mode-preview.md documents the still-blocked engine projection.
  // The deployment-default-off boundary remains covered by API unit tests.
  const den = await seed.den({ web: true, env: { OPENWORK_EVAL_MYSQL8: "1", DEN_CODE_MODE_OPT_IN_ENABLED: "true" }, org: {
    name: "Code Mode journey", admin: { name: "Workspace owner" }, members: {
      teammate: { name: "Report teammate" }, outsider: { name: "Outside-team member" },
    },
  } });
  const org = record((await seed.api(den.admin, "/v1/org")).body);
  const organizationId = text(record(org.organization).id);
  const member = items(org.members).find((entry) => record(entry.user).email === den.members.teammate.email);
  const team = await seed.api(den.admin, "/v1/teams", { method: "POST",
    body: JSON.stringify({ name: "Report team", memberIds: [text(member?.id)] }) });
  expect(team.response.status, team.text).toBe(201);
  const teamId = text(record(record(team.body).team).id);
  const plugin = await seed.api(den.admin, "/v1/plugins", { method: "POST",
    body: JSON.stringify({ name: "Selected reports", orgWide: false }) });
  expect(plugin.response.status, plugin.text).toBe(201);
  const pluginId = text(record(record(plugin.body).item).id);
  const tokenFor = async (session: typeof den.admin) => {
    const response = await seed.api(session, "/v1/mcp/token", { method: "POST",
      headers: { "x-openwork-org-id": organizationId }, body: JSON.stringify({ scopes: ["mcp:read", "mcp:write"] }) });
    expect(response.response.status, response.text).toBe(200);
    return text(record(response.body).token);
  };
  const tokens = {
    owner: await tokenFor(den.admin),
    teammate: await tokenFor(den.members.teammate),
    outsider: await tokenFor(den.members.outsider),
  };
  let requestId = 0;
  // A real external MCP client transport. Calls happen in the story beat, not
  // during arrangement; evidence includes only requests/results, never tokens.
  const rpc = async (method: string, params: Record<string, unknown> = {}, caller: Persona = "owner") => {
    const response = await fetch(`${den.ref.apiUrl}/mcp/agent`, { method: "POST",
      headers: { authorization: `Bearer ${tokens[caller]}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++requestId, method, params }), signal: AbortSignal.timeout(60_000) });
    expect(response.status).toBe(200);
    const raw = await response.text();
    const data = raw.split("\n").find((line) => line.startsWith("data:"));
    const message = record(JSON.parse(data ? data.slice(5) : raw));
    expect(message.error).toBeUndefined();
    return record(message.result);
  };
  const script = async (code: string, caller: Persona = "owner") => {
    const result = await rpc("tools/call", { name: "execute_capability_script", arguments: { code } }, caller);
    expect(result.isError, JSON.stringify(result)).not.toBe(true);
    return record(result.structuredContent).value;
  };
  const viewport = { width: 1280, height: 960 };
  const web = await seed.web({ den, signedInAs: "admin", startPath: "/dashboard/org-settings", headless: true, viewport });
  const teammateWeb = await seed.web({ den, signedInAs: "teammate", startPath: "/dashboard/library", headless: true, viewport });
  const outsiderWeb = await seed.web({ den, signedInAs: "outsider", startPath: "/dashboard/library", headless: true, viewport });
  return { den, web, teammateWeb, outsiderWeb, rpc, script, pluginId, teamId };
}, { timeout: 600_000, resources: { surfaces: ["web"], services: ["den"] } });

test("an owner enables Code Mode, a teammate reuses the shared Workflow, and an outside-team member cannot", async ({ world, user, probe, seed, step, evidence }) => {
  const teammate = user.on(world.teammateWeb);
  const outsider = user.on(world.outsiderWeb);
  // MCP advertisement only: app-only routers must not be advertised to a model.
  // This does not claim that the pinned OpenWork engines honor that projection.
  const advertisedModelTools = async () => items((await world.rpc("tools/list", {}, "teammate")).tools).filter((tool) => {
    if (!tool._meta) return true;
    const ui = record(tool._meta).ui;
    const visibility = ui ? record(ui).visibility : undefined;
    return !Array.isArray(visibility) || visibility.includes("model");
  }).map((tool) => tool.name);
  const discover = async (query: string, caller: Persona = "owner") => record(await world.script(`return await tools.$codemode.search({query:${JSON.stringify(query)}})`, caller));
  const code = "return { count: input.count }";
  const schema = { title: "Exact tested contract", type: "object", required: ["count"], additionalProperties: false,
    properties: { count: { type: "integer", minimum: 1 } } };
  const scriptRequest = { name: "execute_capability_script", arguments: { code, input: { count: 7 }, inputSchema: schema, outputSchema: schema } };

  await step("before: the owner sees Code Mode off and the teammate's MCP client still uses standard tools", async () => {
    await user.see({ role: "switch", label: "Enable Code Mode" });
    expect((await probe.dom('[aria-label="Enable Code Mode"][aria-checked="false"]')).elements).toHaveLength(1);
    const names = await advertisedModelTools();
    expect(names).toContain("search_capabilities");
    expect(names).toContain("execute_capability");
    // Standard mode already offers optional scripts on this branch. The opt-in
    // changes discovery/routing, not script availability; do not invent absence.
    expect(names).toContain("execute_capability_script");
    expect(names).not.toContain("capability_helper");
    await user.click({ text: "Connection behavior" });
    await user.see({ text: /keeps private App tools out of the model/ });
    evidence.recordAssertionEvidence("Teammate's client before org opt-in", `tools/list (model-visible names): ${JSON.stringify(names)}`, true);
    await user.screenshot();
  });

  await step("the owner enables one switch and saves; reload preserves it, while a teammate cannot change the org setting", async () => {
    await user.click({ role: "switch", label: "Enable Code Mode" });
    await user.click({ role: "button", label: "Save settings" });
    await user.see({ text: "Workspace settings updated." });
    await user.reload();
    await user.see({ role: "switch", label: "Enable Code Mode" });
    expect((await probe.dom('[aria-label="Enable Code Mode"][aria-checked="true"]')).elements).toHaveLength(1);
    const blocked = await seed.api(world.den.members.teammate, "/v1/org", { method: "PATCH", body: JSON.stringify({ codeModeEnabled: false }) });
    expect(blocked.response.status).toBe(403);
    evidence.recordAssertionEvidence("The teammate cannot change this organization setting", `Teammate PATCH /v1/org {codeModeEnabled:false} -> ${blocked.response.status}`, true);
    await user.screenshot();
  });

  const receiptId = await step("after: the teammate runs a script and gets count 7 — MCP request/response evidence, not a chat UI", async () => {
    await teammate.see({ role: "heading", label: "My Library" });
    const names = await advertisedModelTools();
    expect(names).toContain("execute_capability_script");
    expect(names).toContain("capability_helper");
    expect(names).not.toContain("search_capabilities");
    expect(names).not.toContain("execute_capability");
    const teammateResult = await world.rpc("tools/call", scriptRequest, "teammate");
    expect(teammateResult.isError).not.toBe(true);
    expect(record(teammateResult.structuredContent).value).toEqual({ count: 7 });
    evidence.recordAssertionEvidence("Teammate executes through the script-first catalog", JSON.stringify({
      modelVisibleTools: names, request: scriptRequest, response: teammateResult.structuredContent,
    }, null, 2), true);
    // The owner authors the shared version. Receipt ownership remains private;
    // the teammate's successful run above is not reused as the owner's receipt.
    const tested = await world.rpc("tools/call", scriptRequest);
    expect(tested.isError).not.toBe(true);
    expect(record(tested.structuredContent).value).toEqual({ count: 7 });
    evidence.recordAssertionEvidence("Owner's tested version to keep", JSON.stringify({ request: scriptRequest, response: tested.structuredContent }, null, 2), true);
    return text(record(record(tested.structuredContent).metadata).receiptId);
  });

  const saved = await step("the owner keeps the successful result as Team report; the tested contract survives and it starts private", async () => {
    const save = items((await discover("save Workflow")).items).find((match) => match.path === "tools.den.saveWorkflow");
    expect(save).toBeDefined();
    const keep = { name: "Team report", receiptId, pluginId: world.pluginId };
    const foreignKeep = await seed.api(world.den.members.teammate, "/v1/workflows", { method: "POST",
      body: JSON.stringify({ name: "Foreign attempt", receiptId }) });
    expect(foreignKeep.response.status).toBe(400);
    const saved = record(await world.script(`return await ${expression(save)}({body:${JSON.stringify(keep)}})`));
    const detail = await probe.api(world.den.admin, `/v1/workflow-authoring-history?receiptId=${receiptId}`);
    expect(detail.response.status).toBe(200);
    expect(record(items(record(detail.body).items)[0]?.procedure).contract).toEqual({ input: { count: 7 }, inputSchema: schema, outputSchema: schema });
    const capability = `plugin:${world.pluginId}:${text(saved.configObjectId)}`;
    const findWorkflow = async (caller: Persona) => items((await discover("Team report", caller)).items).find((match) => text(match.path).includes(capability));
    expect(await findWorkflow("teammate")).toBeUndefined();
    expect(await findWorkflow("outsider")).toBeUndefined();
    await user.navigate(`${world.den.ref.webUrl}/dashboard/library/workflows/${text(saved.configObjectId)}`);
    await user.see({ testId: "workflow-overview" }, { text: /Run workflow/, timeoutMs: 60_000 });
    await user.see({ role: "heading", label: /^Team report/ });
    evidence.recordAssertionEvidence("Keep preserves the exact successful procedure without making it org-wide", JSON.stringify({
      request: keep, saved, contract: record(items(record(detail.body).items)[0]?.procedure).contract,
      foreignReceiptSaveStatus: foreignKeep.response.status, teammateDiscovery: null, outsiderDiscovery: null,
    }, null, 2), true);
    await user.screenshot();
    return { configObjectId: text(saved.configObjectId), save, keep, findWorkflow };
  });

  await step("the owner cannot promote failed or invalid-input attempts — request/response evidence; Team report remains the usable version", async () => {
    await user.see({ role: "heading", label: /^Team report/ });
    const failed = await world.rpc("tools/call", { name: "execute_capability_script", arguments: { code: "throw new Error('Synthetic failure')" } });
    expect(failed.isError).toBe(true);
    const failure = record(JSON.parse(text(items(failed.content)[0]?.text)));
    expect(failure.status).toBe("failed");
    const failedId = text(failure.receiptId);
    const failedHistory = await probe.api(world.den.admin, `/v1/workflow-authoring-history?receiptId=${failedId}`);
    expect(items(record(failedHistory.body).items)).toHaveLength(1);
    const denied = await seed.api(world.den.admin, "/v1/workflows", { method: "POST",
      body: JSON.stringify({ name: "Failed attempt", receiptId: failedId }) });
    expect(denied.response.status).toBe(400);
    expect(record(denied.body).error).toBe("workflow_authoring_run_not_successful");
    const foreignFailedHistory = await probe.api(world.den.members.teammate, `/v1/workflow-authoring-history?receiptId=${failedId}`);
    expect(items(record(foreignFailedHistory.body).items)).toEqual([]);
    const rejectedInput = await world.rpc("tools/call", { name: "execute_capability_script", arguments: {
      code: `return await ${expression(saved.save)}({body:${JSON.stringify(saved.keep)}})`,
      input: { count: "invalid" }, inputSchema: schema,
    } });
    expect(rejectedInput.isError).toBe(true);
    const rejected = record(JSON.parse(text(items(rejectedInput.content)[0]?.text)));
    expect(rejected.error).toBe("invalid_arguments");
    expect(record(rejected.retention).canSaveByReceipt).toBe(false);
    const rejectedId = text(rejected.receiptId);
    const rejectedHistory = await probe.api(world.den.admin, `/v1/workflow-authoring-history?receiptId=${rejectedId}`);
    const rejectedVersion = items(record(rejectedHistory.body).items)[0];
    expect(record(record(rejectedVersion).execution).status).toBe("failed");
    expect(record(record(rejectedVersion).procedure).contract).toEqual({ input: { count: "invalid" }, inputSchema: schema });
    const rejectedKeep = await seed.api(world.den.admin, "/v1/workflows", { method: "POST",
      body: JSON.stringify({ name: "Invalid contract attempt", receiptId: rejectedId }) });
    expect(record(rejectedKeep.body).error).toBe("workflow_authoring_run_not_successful");
    evidence.recordAssertionEvidence("Failed attempts are inspectable only by their author, not saveable", JSON.stringify({
      failedRequest: "throw new Error('Synthetic failure')", failure, saveFailure: denied.body,
      failedHistoryCount: items(record(failedHistory.body).items).length, foreignFailedHistory: foreignFailedHistory.body,
      rejectedInput: { count: "invalid" }, rejected, rejectedVersion, saveRejected: rejectedKeep.body,
    }, null, 2), true);
  });

  const shared = await step("the owner shares with Report team; the teammate sees the Plugin in My Library and opens the Workflow's Library link", async () => {
    const access = items((await discover("postPluginsAccess")).items).find((match) => match.path === "tools.den.postPluginsAccess");
    expect(access).toBeDefined();
    await world.script(`return await ${expression(access)}({path:{pluginId:${JSON.stringify(world.pluginId)}},body:{teamId:${JSON.stringify(world.teamId)},role:"viewer",orgWide:false}})`);
    const shared = await saved.findWorkflow("teammate");
    expect(shared).toBeDefined();
    await teammate.reload();
    await teammate.see({ role: "heading", label: "My Library" });
    await teammate.click({ role: "button", label: "Plugins" });
    await teammate.see({ role: "link", label: /Selected reports/ });
    await teammate.see({ text: "Report team" });
    await teammate.hover({ role: "link", label: /Selected reports/ });
    await teammate.screenshot();
    // This branch groups Workflows under their Plugin in My Library, but the
    // viewer Plugin detail does not expose its Workflow rows. Use the shipped
    // Workflow Library permalink; do not imply a working tile-to-detail path.
    await teammate.navigate(`${world.den.ref.webUrl}/dashboard/library/workflows/${saved.configObjectId}`);
    await teammate.see({ testId: "workflow-overview" }, { text: /Run workflow/, timeoutMs: 60_000 });
    await teammate.see({ role: "heading", label: /^Team report/ });
    await teammate.screenshot();
    return shared;
  });

  await step("the teammate reuses Team report through MCP and views its saved result in Den, without the owner's private history", async () => {
    const result = await world.script(`return await ${expression(shared)}({count:7})`, "teammate");
    expect(result).toMatchObject({ value: { count: 7 } });
    const privateHistory = await probe.api(world.den.members.teammate, `/v1/workflow-authoring-history?receiptId=${receiptId}`);
    expect(items(record(privateHistory.body).items)).toEqual([]);
    await teammate.reload();
    // A viewer can execute through MCP, but this branch's Den run form does not
    // grant canRun to a Plugin viewer. Show the real result, not an invented act.
    await teammate.see({ text: "You do not have permission to run this workflow." });
    await teammate.see({ testId: "den-workflow-artifact-result" }, { text: /Count\s*7/, timeoutMs: 60_000 });
    await teammate.see({ role: "heading", label: /^Team report/ });
    evidence.recordAssertionEvidence("Sharing grants saved execution, not private authoring history", JSON.stringify({
      request: `return await ${expression(shared)}({count:7})`, response: result, authoringHistory: privateHistory.body,
    }, null, 2), true);
    await teammate.screenshot();
  });

  await step("boundary: the outside-team member's Library omits the report and even a guessed execution is denied", async () => {
    await outsider.reload();
    await outsider.see({ role: "heading", label: "My Library" });
    await outsider.click({ role: "button", label: "Plugins" });
    await outsider.see({ role: "heading", label: "No plugins yet" });
    await outsider.notSee({ role: "link", label: /Selected reports/ });
    await outsider.notSee({ text: "Team report" });
    expect(await saved.findWorkflow("outsider")).toBeUndefined();
    const guessed = await world.rpc("tools/call", { name: "execute_capability_script", arguments: { code: `return await ${expression(shared)}({count:7})` } }, "outsider");
    expect(guessed.isError).toBe(true);
    evidence.recordAssertionEvidence("Knowing the shared Workflow's callable path does not grant access", JSON.stringify({
      request: { code: `return await ${expression(shared)}({count:7})` }, response: guessed,
    }, null, 2), true);
    await outsider.screenshot();
  });
});
