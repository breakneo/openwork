import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import {
  connectionActionMcpApp,
  connectionActionPrompt,
  connectionActionReply,
  connectionActionReplySkip,
  connectionActionSkipPrompt,
  connectionStatusPrompt,
  connectionStatusSkipPrompt,
  isRecord,
  ordinaryDiscoveryPrompt,
  ordinaryDiscoveryReply,
} from "../worlds/library.ts";

const test = spec.world(connectionActionMcpApp, { timeout: 600_000 });

function record(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new Error("Expected an object");
  return value;
}

function rows(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) throw new Error("Expected a list");
  return value.map(record);
}

function toolPayload(part: Record<string, unknown>) {
  const state = record(part.state);
  expect(state.status).toBe("completed");
  const metadata = isRecord(state.metadata) ? state.metadata : {};
  const result = metadata.openworkMcpResult ?? metadata.openworkMcpApp;
  if (isRecord(result)) {
    expect(result.isError).not.toBe(true);
    if (isRecord(result.structuredContent)) return result.structuredContent;
  }
  if (typeof state.output !== "string") throw new Error("The completed tool has no output");
  return record(JSON.parse(state.output));
}

function turnTools(messages: Record<string, unknown>[], prompt: string) {
  const start = messages.findLastIndex(message => record(message.info).role === "user"
    && rows(message.parts).some(part => part.type === "text" && part.text === prompt));
  expect(start, "The exact user task must exist in the engine transcript").toBeGreaterThanOrEqual(0);
  return messages.slice(start + 1).flatMap(message => rows(message.parts)).filter(part => part.type === "tool");
}

test("one standard connection App covers discovery and exact status results without legacy native UI", async ({ world, user, probe, evidence }) => {
  const connector = world.den.mocks.connector;
  const mount = `/workspace/${encodeURIComponent(world.workspace.workspaceId)}/opencode`;
  const sessionPath = `${mount}/session/${encodeURIComponent(world.session.sessionId)}`;
  const messages = async () => {
    const response = await probe.desktopApi(`${sessionPath}/message`);
    expect(response.status).toBe(200);
    return rows(response.body);
  };
  const pending = async () => {
    const response = await probe.desktopApi(`${mount}/question`);
    expect(response.status).toBe(200);
    return rows(response.body).filter(request => request.sessionID === world.session.sessionId);
  };
  let requestId = 0;
  async function gateway(method: string, params: Record<string, unknown> = {}) {
    const response = await fetch(`${world.den.ref.apiUrl}/mcp/agent`, {
      method: "POST",
      headers: { authorization: `Bearer ${world.appHostSession.token}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++requestId, method, params }),
      signal: AbortSignal.timeout(60_000),
    });
    expect(response.status).toBe(200);
    const raw = await response.text();
    const line = raw.split("\n").find(value => value.startsWith("data:"));
    return record(JSON.parse(line ? line.slice(5) : raw));
  }

  const tools = rows(record((await gateway("tools/list")).result).tools);
  expect(tools).toEqual(expect.arrayContaining([expect.objectContaining({ name: "execute_capability" })]));
  const connectionUri = "ui://openwork/connection-action/v2/view.html";
  const connectionTools = tools.filter(tool => {
    const metadata = isRecord(tool._meta) ? tool._meta : {};
    const ui = isRecord(metadata.ui) ? metadata.ui : {};
    return ui.resourceUri === connectionUri;
  });
  expect(connectionTools.map(tool => tool.name).sort()).toEqual(["connection_action", "connection_action_intent"]);
  const resources = rows(record((await gateway("resources/list")).result).resources);
  expect(resources).toEqual(expect.arrayContaining([expect.objectContaining({ uri: connectionUri })]));
  expect(resources).not.toEqual(expect.arrayContaining([expect.objectContaining({ uri: "ui://openwork/connection-action/v1/view.html" })]));

  await user.type("composer", ordinaryDiscoveryPrompt, { verify: true });
  await user.press("Enter");
  await user.see({ text: ordinaryDiscoveryReply }, { timeoutMs: 120_000 });
  for (const testId of ["connection-decision-panel", "desktop-connection-card", "connector-catalog"]) await user.notSee({ testId });
  expect(await pending()).toEqual([]);
  const ordinaryTools = turnTools(await messages(), ordinaryDiscoveryPrompt);
  expect(ordinaryTools).toHaveLength(1);
  const ordinaryPayload = toolPayload(ordinaryTools[0]);
  expect(ordinaryPayload.connectionAction).toBeUndefined();
  expect(ordinaryPayload.connectorCatalog).toBeUndefined();

  const cases = [
    { prompt: connectionActionPrompt, reply: connectionActionReply, tools: ["search_capabilities"] },
    { prompt: connectionActionSkipPrompt, reply: connectionActionReplySkip, tools: ["search_capabilities"] },
    { prompt: connectionStatusPrompt, reply: connectionActionReply, tools: ["search_capabilities", "execute_capability"] },
    { prompt: connectionStatusSkipPrompt, reply: connectionActionReplySkip, tools: ["search_capabilities", "execute_capability"] },
  ];
  for (const entry of cases) {
    await user.see("composer", { editable: true });
    await user.type("composer", entry.prompt, { replace: true, verify: true });
    await user.press("Enter");
    await user.see({ text: entry.reply }, { timeoutMs: 120_000 });
    expect(await pending()).toEqual([]);
    const frames = await probe.eventually(
      () => probe.dom(`[data-mcp-app-resource="${connectionUri}"]`),
      { within: 30_000, label: "the connection App mounts in the transcript", until: result => result.elements.length >= 1 },
    );
    expect(frames.elements.at(-1)?.rect.width).toBeGreaterThan(0);
    expect(frames.elements.at(-1)?.rect.height).toBeGreaterThan(0);
    await user.notSee({ testId: "desktop-connection-card" });
    await user.notSee({ testId: "connection-decision-panel" });

    const transcriptTools = turnTools(await messages(), entry.prompt);
    const modelCalls = (await connector.agentRequests({ promptMarker: entry.prompt })).filter(call => call.kind === "tool");
    expect(transcriptTools).toHaveLength(entry.tools.length);
    expect(modelCalls).toHaveLength(entry.tools.length);
    for (const [index, name] of entry.tools.entries()) {
      expect(transcriptTools[index]?.tool).toMatch(new RegExp(`${name}$`));
      expect(modelCalls[index]?.toolName).toMatch(new RegExp(`${name}$`));
    }
    const firstPayload = toolPayload(transcriptTools[0]);
    const statusMatch = rows(firstPayload.matches).find(match => match.kind === "connection_status"
      && isRecord(match.connectionStatus) && match.connectionStatus.connectionId === world.connection.id);
    if (!statusMatch || typeof statusMatch.name !== "string") throw new Error("Discovery did not return an exact status capability");
    const expectedConnection = { connectionId: world.connection.id, connectionName: "Notion", state: "needs_connection", actor: "member", action: { type: "connect", surface: "openwork_your_connections" } };
    if (entry.tools.length === 2) {
      expect(firstPayload.connectionAction).toBeUndefined();
      expect(statusMatch.connectionStatus).toMatchObject(expectedConnection);
      expect(toolPayload(transcriptTools[1])).toMatchObject(expectedConnection);
    } else {
      expect(firstPayload.connectionAction).toMatchObject(expectedConnection);
    }
    expect((await connector.requests()).filter(request => request.path === "/authorize" || request.path === "/token")).toEqual([]);
    expect(await connector.toolCalls()).toEqual([]);
    await user.screenshot();
  }

  evidence.recordAssertionEvidence(
    "One standards-based connection App replaces legacy connection UI",
    "Ordinary discovery stayed informational. Explicit search and exact status execution each rendered the same v2 App resource, never opened a native question, provider OAuth, legacy card, or provider tool call.",
    true,
  );
});
