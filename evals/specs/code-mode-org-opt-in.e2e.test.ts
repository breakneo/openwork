import { expect } from "vitest";
import { spec } from "@openwork/testkit";

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Expected object");
  return value;
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

const test = spec.world(async (seed) => {
  const den = await seed.den({ web: true, org: { name: "Code Mode journey", members: {
    teammate: { name: "Teammate" }, outsider: { name: "Other member" },
  } } });
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
  const tokens = await Promise.all([den.admin, den.members.teammate, den.members.outsider].map(async (session) => {
    const response = await seed.api(session, "/v1/mcp/token", { method: "POST",
      headers: { "x-openwork-org-id": organizationId }, body: JSON.stringify({ scopes: ["mcp:read", "mcp:write"] }) });
    expect(response.response.status, response.text).toBe(200);
    return text(record(response.body).token);
  }));
  let requestId = 0;
  const rpc = async (method: string, params: Record<string, unknown> = {}, caller = 0) => {
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
  const script = async (code: string, caller = 0) => {
    const result = await rpc("tools/call", { name: "execute_capability_script", arguments: { code } }, caller);
    expect(result.isError, JSON.stringify(result)).not.toBe(true);
    return record(result.structuredContent).value;
  };
  const web = await seed.web({ den, signedInAs: "admin", startPath: "/dashboard/org-settings", headless: true,
    viewport: { width: 1280, height: 960 } });
  return { den, web, rpc, script, pluginId, teamId };
}, { timeout: 600_000 });

test("an owner opts into Code Mode and shares a saved Workflow only with the selected team", async ({ world, user, probe, seed, evidence }) => {
  // MCP advertisement only; actual engine projection has a separate pinned
  // integration witness in apps/server/src/code-mode-boundary.integration.test.ts.
  const advertisedModelTools = async () => items((await world.rpc("tools/list")).tools).filter((tool) => {
    if (!tool._meta) return true;
    const ui = record(tool._meta).ui;
    const visibility = ui ? record(ui).visibility : undefined;
    return !Array.isArray(visibility) || visibility.includes("model");
  }).map((tool) => tool.name);
  expect(await advertisedModelTools()).toContain("search_capabilities");
  await user.see({ role: "switch", label: "Enable Code Mode" });
  await user.screenshot();
  await user.click({ role: "switch", label: "Enable Code Mode" });
  await user.click({ role: "button", label: "Save settings" });
  await user.see({ text: "Workspace settings updated." });
  await user.reload();
  await user.see({ role: "switch", label: "Enable Code Mode" });
  expect(await probe.eval(world.web, () => document.querySelector('[aria-label="Enable Code Mode"]')?.getAttribute("aria-checked"))).toBe("true");
  await user.screenshot();
  const names = await advertisedModelTools();
  expect(names).toContain("execute_capability_script");
  expect(names).toContain("capability_helper");
  expect(names).not.toContain("search_capabilities");
  expect(names).not.toContain("execute_capability");
  const blocked = await seed.api(world.den.members.teammate, "/v1/org", { method: "PATCH", body: JSON.stringify({ codeModeEnabled: false }) });
  expect(blocked.response.status).toBe(403);
  const discover = async (query: string, caller = 0) => record(await world.script(`return await tools.$codemode.search({query:${JSON.stringify(query)}})`, caller));
  const save = items((await discover("save Workflow")).items).find((match) => match.path === "tools.den.saveWorkflow");
  expect(save).toBeDefined();
  const code = "return { count: input.count }";
  const schema = { title: "Exact tested contract", type: "object", required: ["count"], additionalProperties: false,
    properties: { count: { type: "integer", minimum: 1 } } };
  const tested = await world.rpc("tools/call", { name: "execute_capability_script", arguments: {
    code, input: { count: 7 }, inputSchema: schema, outputSchema: schema,
  } });
  expect(tested.isError).not.toBe(true);
  const receiptId = text(record(record(tested.structuredContent).metadata).receiptId);
  const keep = { name: "Team report", receiptId, pluginId: world.pluginId };
  const foreignKeep = await seed.api(world.den.members.teammate, "/v1/workflows", { method: "POST",
    body: JSON.stringify({ name: "Foreign attempt", receiptId }) });
  expect(foreignKeep.response.status).toBe(400);
  const saved = record(await world.script(`return await ${expression(save)}({body:${JSON.stringify(keep)}})`));
  const detail = await seed.api(world.den.admin, `/v1/workflow-authoring-history?receiptId=${receiptId}`);
  expect(detail.response.status).toBe(200);
  expect(record(items(record(detail.body).items)[0]?.procedure).contract).toEqual({ input: { count: 7 }, inputSchema: schema, outputSchema: schema });
  const failed = await world.rpc("tools/call", { name: "execute_capability_script", arguments: { code: "throw new Error('Synthetic failure')" } });
  expect(failed.isError).toBe(true);
  const failure = record(JSON.parse(text(items(failed.content)[0]?.text)));
  expect(failure.status).toBe("failed");
  const failedId = text(failure.receiptId);
  const failedHistory = await seed.api(world.den.admin, `/v1/workflow-authoring-history?receiptId=${failedId}`);
  expect(items(record(failedHistory.body).items)).toHaveLength(1);
  const denied = await seed.api(world.den.admin, "/v1/workflows", { method: "POST",
    body: JSON.stringify({ name: "Failed attempt", receiptId: failedId }) });
  expect(denied.response.status).toBe(400);
  expect(record(denied.body).error).toBe("workflow_authoring_run_not_successful");
  const capability = `plugin:${world.pluginId}:${text(saved.configObjectId)}`;
  const findWorkflow = async (caller: number) => items((await discover("Team report", caller)).items).find((match) => text(match.path).includes(capability));
  expect(await findWorkflow(1)).toBeUndefined();
  expect(await findWorkflow(2)).toBeUndefined();
  const access = items((await discover("postPluginsAccess")).items).find((match) => match.path === "tools.den.postPluginsAccess");
  expect(access).toBeDefined();
  await world.script(`return await ${expression(access)}({path:{pluginId:${JSON.stringify(world.pluginId)}},body:{teamId:${JSON.stringify(world.teamId)},role:"viewer",orgWide:false}})`);
  const shared = await findWorkflow(1);
  expect(shared).toBeDefined();
  expect(await findWorkflow(2)).toBeUndefined();
  expect(await world.script(`return await ${expression(shared)}({count:7})`, 1)).toMatchObject({ value: { count: 7 } });
  const privateHistory = await seed.api(world.den.members.teammate, `/v1/workflow-authoring-history?receiptId=${receiptId}`);
  expect(items(record(privateHistory.body).items)).toEqual([]);
  const guessed = await world.rpc("tools/call", { name: "execute_capability_script", arguments: { code: `return await ${expression(shared)}({count:7})` } }, 2);
  expect(guessed.isError).toBe(true);
  evidence.recordAssertionEvidence("Code Mode opt-in, private procedure retention and existing team sharing", "Identifier-only keep recovers exact contracts; failed attempts are inspectable but cannot be promoted; sharing permits saved execution without exposing private authoring history. The setting persists and another member cannot discover or invoke the Workflow.", true);
});
