import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { connectionActionMcpApp, connectionActionPrompt, connectionActionReply, connectionActionReplySkip, connectionActionSkipPrompt, connectionStatusPrompt, connectionStatusSkipPrompt, isRecord, ordinaryDiscoveryPrompt, ordinaryDiscoveryReply } from "../worlds/library.ts";

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

test("ordinary discovery stays quiet without a native question or authorization", async ({ world, user, probe, evidence }) => {
  const mount = `/workspace/${encodeURIComponent(world.workspace.workspaceId)}/opencode`;
  await user.type("composer", ordinaryDiscoveryPrompt, { verify: true });
  await user.press("Enter");
  await user.see({ text: ordinaryDiscoveryReply }, { timeoutMs: 120_000 });
  for (const testId of ["connection-decision-panel", "desktop-connection-card", "connector-catalog"]) await user.notSee({ testId });
  await user.notSee({ role: "button", label: "Authenticate" });
  const pending = await probe.desktopApi(`${mount}/question`);
  expect(pending.status).toBe(200);
  expect(rows(pending.body).filter(request => request.sessionID === world.session.sessionId)).toEqual([]);
  const response = await probe.desktopApi(`${mount}/session/${encodeURIComponent(world.session.sessionId)}/message`);
  expect(response.status).toBe(200);
  const tools = turnTools(rows(response.body), ordinaryDiscoveryPrompt);
  expect(tools).toHaveLength(1);
  const discovery = toolPayload(tools[0]);
  expect(discovery.connectionAction).toBeUndefined();
  expect(discovery.connectorCatalog).toBeUndefined();
  expect(rows(discovery.matches)).toEqual(expect.arrayContaining([expect.objectContaining({
    kind: "connection_status", connectionStatus: expect.objectContaining({ connectionId: world.connection.id, state: "needs_connection" }),
  })]));
  const calls = (await world.den.mocks.connector.agentRequests({ promptMarker: ordinaryDiscoveryPrompt })).filter(call => call.kind === "tool");
  expect(calls).toHaveLength(1);
  expect(calls[0]?.toolName).toMatch(/search_capabilities$/);
  expect((await world.den.mocks.connector.requests()).filter(request => request.path === "/authorize" || request.path === "/token")).toEqual([]);
  await user.screenshot();
  evidence.recordAssertionEvidence("Discovery remains informational", "The actual search result has a status match but no action, native question, card, or OAuth request", true);
});

for (const entry of [
  { name: "connection search", prompt: connectionActionPrompt, skipPrompt: connectionActionSkipPrompt, tools: ["search_capabilities"] },
  { name: "connection status execution", prompt: connectionStatusPrompt, skipPrompt: connectionStatusSkipPrompt, tools: ["search_capabilities", "execute_capability"] },
]) {
  for (const choice of ["Authenticate", "Skip"]) {
    test(`desktop pauses ${entry.name} for native ${choice} and continues the same turn`, async ({ world, user, probe, evidence }) => {
      const connector = world.den.mocks.connector;
      const prompt = choice === "Skip" ? entry.skipPrompt : entry.prompt;
      const reply = choice === "Skip" ? connectionActionReplySkip : connectionActionReply;
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
      const modelRequests = () => connector.agentRequests({ promptMarker: prompt });
      const modelTools = async () => (await modelRequests()).filter(call => call.kind === "tool");
      const oauthRequests = async () => (await connector.requests()).filter(request => request.path === "/authorize" || request.path === "/token");
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
      const legacyUri = "ui://openwork/connection-action/v1/view.html";
      const resources = rows(record((await gateway("resources/list")).result).resources);
      expect(resources).toEqual(expect.arrayContaining([expect.objectContaining({ uri: connectionUri })]));
      expect(resources).not.toEqual(expect.arrayContaining([expect.objectContaining({ uri: legacyUri })]));
      const retiredResource = await gateway("resources/read", { uri: legacyUri });
      expect(retiredResource.error).toBeDefined();
      expect(retiredResource.result).toBeUndefined();

      for (const id of [world.connection.id, world.organizationId, world.workspace.workspaceId, world.session.sessionId]) expect(prompt).not.toContain(id);
      await user.type("composer", prompt, { verify: true });
      await user.press("Enter");
      await user.see({ text: reply }, { timeoutMs: 120_000 });
      expect(await pending()).toEqual([]);
      const appFrames = await probe.eventually(
        () => probe.dom('[data-mcp-app-resource="ui://openwork/connection-action/v2/view.html"]'),
        { within: 30_000, label: "the connection App mounts in the transcript", until: result => result.elements.length === 1 },
      );
      expect(appFrames.elements).toHaveLength(1);
      expect(appFrames.elements[0]?.rect.width).toBeGreaterThan(0);
      expect(appFrames.elements[0]?.rect.height).toBeGreaterThan(0);
      await user.notSee({ testId: "desktop-connection-card" });
      await user.notSee({ testId: "connection-decision-panel" });

      const finishedMessages = await messages();
      const users = finishedMessages.filter(message => record(message.info).role === "user");
      expect(users).toHaveLength(1);
      const finishedTools = turnTools(finishedMessages, prompt);
      const calls = await modelTools();
      expect(calls).toHaveLength(entry.tools.length);
      expect(finishedTools).toHaveLength(entry.tools.length);
      for (const [index, tool] of entry.tools.entries()) {
        expect(calls[index]?.toolName).toMatch(new RegExp(`${tool}$`));
        expect(finishedTools[index]?.tool).toMatch(new RegExp(`${tool}$`));
      }
      const expectedConnection = { connectionId: world.connection.id, connectionName: "Notion", state: "needs_connection", actor: "member", action: { type: "connect", surface: "openwork_your_connections" } };
      const firstPayload = toolPayload(finishedTools[0]);
      const statusMatch = rows(firstPayload.matches).find(match => match.kind === "connection_status"
        && isRecord(match.connectionStatus) && match.connectionStatus.connectionId === world.connection.id);
      if (!statusMatch || typeof statusMatch.name !== "string") throw new Error("Discovery did not return an exact status capability");
      if (entry.tools.length === 2) {
        expect(firstPayload.connectionAction).toBeUndefined();
        expect(statusMatch.connectionStatus).toMatchObject(expectedConnection);
        expect(calls[1]?.arguments).toEqual({ name: statusMatch.name });
        expect(record(finishedTools[1].state).input).toEqual({ name: statusMatch.name });
        expect(toolPayload(finishedTools[1])).toMatchObject(expectedConnection);
      } else {
        expect(firstPayload.connectionAction).toMatchObject(expectedConnection);
      }
      expect((await modelRequests()).filter(call => call.kind === "final")).toHaveLength(1);
      expect((await modelRequests()).filter(call => call.kind === "error")).toEqual([]);
      expect(await oauthRequests()).toEqual([]);
      expect(await connector.toolCalls()).toEqual([]);
      expect((await messages()).filter(message => record(message.info).role === "user")).toEqual(users);
      expect(await modelTools()).toEqual(calls);
      await user.screenshot();
      evidence.recordAssertionEvidence(`${choice} prompt renders the single connection App without legacy native UI`, JSON.stringify({ userMessages: 1, toolNames: calls.map(call => call.toolName), resourceUri: connectionUri }), true);
    });
  }
}
