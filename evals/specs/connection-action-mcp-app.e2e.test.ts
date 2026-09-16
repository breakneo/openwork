import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { connectionActionMcpApp, connectionActionPrompt, connectionActionReply, connectionStatusPrompt, isRecord, ordinaryDiscoveryPrompt, ordinaryDiscoveryReply } from "../worlds/library.ts";

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

for (const entry of [
  { name: "connection search", prompt: connectionActionPrompt, tools: ["search_capabilities"] },
  { name: "connection status execution", prompt: connectionStatusPrompt, tools: ["search_capabilities", "execute_capability"] },
]) {
  test(`desktop stops for ${entry.name} before explicit authorization without retrying`, async ({ world, user, probe, evidence }) => {
    const connector = world.den.mocks.connector;
    const enginePath = `/workspace/${encodeURIComponent(world.workspace.workspaceId)}/opencode/session`;
    const sessionPath = `${enginePath}/${encodeURIComponent(world.session.sessionId)}`;
    const messages = async () => {
      const response = await probe.desktopApi(`${sessionPath}/message`);
      expect(response.status).toBe(200);
      return rows(response.body);
    };
    const turnTools = (messages: Record<string, unknown>[], prompt: string) => {
      const start = messages.findLastIndex(message => record(message.info).role === "user"
        && rows(message.parts).some(part => part.type === "text" && part.text === prompt));
      expect(start, "The exact user task must exist in the engine transcript").toBeGreaterThanOrEqual(0);
      return messages.slice(start + 1).flatMap(message => rows(message.parts)).filter(part => part.type === "tool");
    };
    const modelTools = async () => (await connector.agentRequests({ promptMarker: entry.prompt })).filter(call => call.kind === "tool");
    const oauthRequests = async () => (await connector.requests()).filter(request => request.path === "/authorize" || request.path === "/token");
    const panel = async () => {
      const selector = '[data-testid="connection-decision-panel"]';
      const [cards, transcript, editors, misplaced, checklists, embedded, buttons, enabled] = await Promise.all([
        probe.dom(selector),
        probe.dom('[data-testid="desktop-connection-card"]'),
        probe.dom('[data-lexical-editor="true"][contenteditable="true"]'),
        probe.dom(`[data-message-role] ${selector}`),
        probe.dom(`${selector} ol`),
        probe.dom('[data-mcp-app-resource="ui://openwork/connection-action/v1/view.html"]'),
        probe.dom('button[aria-label="Connect Notion"]'),
        probe.dom(`${selector} button[aria-label="Connect Notion"]:not(:disabled):not([aria-disabled="true"])`),
      ]);
      const card = cards.elements[0];
      const composer = editors.elements[0];
      return {
        count: cards.elements.length,
        transcriptCards: transcript.elements.length,
        text: card?.text ?? "",
        height: card?.rect.height ?? 0,
        width: card?.rect.width ?? 0,
        aboveComposer: Boolean(card && composer && card.rect.bottom <= composer.rect.top),
        inTranscript: misplaced.elements.length > 0,
        hasChecklist: checklists.elements.length > 0,
        embeddedApp: embedded.elements.length > 0,
        connectCount: buttons.elements.length,
        connectEnabled: enabled.elements.length === 1,
      };
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
    const tools = record((await gateway("tools/list")).result).tools;
    expect(Array.isArray(tools)).toBe(true);
    expect(tools).toEqual(expect.arrayContaining([expect.objectContaining({ name: "execute_capability" })]));
    expect(tools).not.toEqual(expect.arrayContaining([expect.objectContaining({ name: "connection_action" })]));
    const legacyUri = "ui://openwork/connection-action/v1/view.html";
    const resources = record((await gateway("resources/list")).result).resources;
    expect(Array.isArray(resources)).toBe(true);
    expect(resources).not.toEqual(expect.arrayContaining([expect.objectContaining({ uri: legacyUri })]));
    const retiredResource = await gateway("resources/read", { uri: legacyUri });
    expect(retiredResource.error).toBeDefined();
    expect(retiredResource.result).toBeUndefined();
    evidence.recordAssertionEvidence("The gateway no longer exposes the legacy connection app", "App-host tools omit connection_action; resources omit the retired URI and a direct read returns an error without HTML", true);

    for (const prompt of [ordinaryDiscoveryPrompt, entry.prompt]) {
      for (const id of [world.connection.id, world.organizationId, world.workspace.workspaceId, world.session.sessionId]) expect(prompt).not.toContain(id);
    }
    await user.type("composer", ordinaryDiscoveryPrompt, { verify: true });
    await user.press("Enter");
    await user.see({ text: ordinaryDiscoveryReply }, { timeoutMs: 120_000 });
    await user.notSee({ testId: "connection-decision-panel" });
    await user.notSee({ testId: "desktop-connection-card" });
    await user.notSee({ testId: "connector-catalog" });
    await user.notSee({ role: "button", label: "Connect Notion" });
    expect(await oauthRequests()).toEqual([]);
    const discoveryCalls = (await connector.agentRequests({ promptMarker: ordinaryDiscoveryPrompt })).filter(call => call.kind === "tool");
    expect(discoveryCalls).toHaveLength(1);
    expect(discoveryCalls[0]?.toolName).toMatch(/search_capabilities$/);
    const discoveryTools = turnTools(await messages(), ordinaryDiscoveryPrompt);
    expect(discoveryTools).toHaveLength(1);
    const discovery = toolPayload(discoveryTools[0]);
    expect(discovery.connectionAction).toBeUndefined();
    expect(discovery.connectorCatalog).toBeUndefined();
    const statusMatch = rows(discovery.matches).find(match => match.kind === "connection_status"
      && isRecord(match.connectionStatus) && match.connectionStatus.connectionId === world.connection.id);
    if (!statusMatch || typeof statusMatch.name !== "string") throw new Error("Discovery did not return an exact status capability");
    const statusName = statusMatch.name;
    expect(statusMatch.connectionStatus).toMatchObject({ connectionId: world.connection.id, state: "needs_connection" });
    await user.screenshot();
    evidence.recordAssertionEvidence("Ordinary discovery stays quiet even for mounted user sends", "The actual tool result contains a needs_connection status match, but no action or catalog; no decision panel, transcript card, Connect button, or OAuth request appeared", true);

    await user.type("composer", entry.prompt, { verify: true });
    await user.press("Enter");
    await user.see({ testId: "connection-decision-panel" }, { timeoutMs: 120_000 });
    const stopped = await probe.eventually(async () => {
      const state = await panel();
      if (state.connectEnabled) expect(state.text).toContain("Turn stopped. Nothing retried.");
      expect(await oauthRequests()).toEqual([]);
      return state;
    }, { within: 30_000, label: "Stop is confirmed before Connect is enabled", until: state => state.connectEnabled });
    expect(stopped).toMatchObject({ count: 1, transcriptCards: 0, connectCount: 1, aboveComposer: true, inTranscript: false, hasChecklist: false, embeddedApp: false });
    expect(stopped.height).toBeGreaterThan(0);
    expect(stopped.height).toBeLessThan(160);
    await user.notSee({ text: "Stop not confirmed" });
    await user.notSee({ text: "Finish sign-in in your browser" });
    await user.notSee({ text: connectionActionReply });
    const status = await probe.desktopApi(`${enginePath}/status`);
    expect(status.status).toBe(200);
    const sessionStatus = record(status.body)[world.session.sessionId];
    expect(sessionStatus === undefined || (isRecord(sessionStatus) && sessionStatus.type === "idle")).toBe(true);
    const stoppedMessages = await messages();
    const userTurn = stoppedMessages.findLast(message => record(message.info).role === "user");
    if (!userTurn) throw new Error("The stopped user turn is missing");
    const interrupted = stoppedMessages.findLast(message => {
      const info = record(message.info);
      return info.role === "assistant" && info.parentID === record(userTurn.info).id && isRecord(info.error);
    });
    if (!interrupted) throw new Error("The engine did not persist an interrupted reply to this user turn");
    expect(record(interrupted.info).error).toMatchObject({ name: "MessageAbortedError" });
    expect(record(record(interrupted.info).time).completed).toEqual(expect.any(Number));
    const completedTools = turnTools(stoppedMessages, entry.prompt);
    expect(completedTools).toHaveLength(entry.tools.length);
    const callsAtStop = await modelTools();
    const allToolsAtStop = (await connector.agentRequests()).filter(call => call.kind === "tool");
    const usersAtStop = stoppedMessages.filter(message => record(message.info).role === "user");
    expect(callsAtStop).toHaveLength(entry.tools.length);
    for (const [index, tool] of entry.tools.entries()) {
      expect(callsAtStop[index]?.toolName).toMatch(new RegExp(`${tool}$`));
      expect(completedTools[index]?.tool).toMatch(new RegExp(`${tool}$`));
    }
    const expectedConnection = { connectionId: world.connection.id, connectionName: "Notion", state: "needs_connection", actor: "member", action: { type: "connect", surface: "openwork_your_connections" } };
    const firstPayload = toolPayload(completedTools[0]);
    if (entry.tools.length === 2) {
      expect(firstPayload.connectionAction).toBeUndefined();
      const discoveredStatus = rows(firstPayload.matches).find(match => match.name === statusName);
      expect(discoveredStatus?.connectionStatus).toMatchObject(expectedConnection);
      expect(callsAtStop[1]?.arguments).toMatchObject({ name: statusName });
      expect(record(completedTools[1].state).input).toMatchObject({ name: statusName });
      expect(toolPayload(completedTools[1])).toMatchObject(expectedConnection);
    } else {
      expect(firstPayload.connectionAction).toMatchObject(expectedConnection);
    }
    expect(await connector.toolCalls()).toEqual([]);
    await user.screenshot();
    evidence.recordAssertionEvidence(`${entry.name} stops the actual turn and presents one compact decision above the composer`, JSON.stringify({ panel: stopped, engineStatus: sessionStatus ?? "idle", interrupted: record(interrupted.info).error, toolNames: callsAtStop.map(call => call.toolName) }), true);

    const clickedAt = new Date().toISOString();
    await user.click({ role: "button", label: "Connect Notion" });
    const authorization = await connector.authorizeRequestSince(clickedAt, { timeoutMs: 60_000 });
    expect(authorization.path).toBe("/authorize");
    expect(authorization.params.get("state")).toBeTruthy();
    await user.see({ text: "Notion: Connected. Nothing retried." }, { timeoutMs: 120_000 });
    await user.notSee({ role: "button", label: "Connect Notion" });
    await user.notSee({ text: "Your Connections" });
    const connected = await panel();
    expect(connected).toMatchObject({ count: 1, transcriptCards: 0, connectCount: 0, aboveComposer: true, width: stopped.width, height: stopped.height });
    const oauth = await oauthRequests();
    expect(oauth.filter(request => request.path === "/authorize")).toHaveLength(1);
    expect(oauth.filter(request => request.path === "/token")).toEqual(expect.arrayContaining([expect.objectContaining({ status: 200, grantType: "authorization_code" })]));
    expect(await modelTools()).toEqual(callsAtStop);
    expect((await connector.agentRequests()).filter(call => call.kind === "tool")).toEqual(allToolsAtStop);
    expect((await messages()).filter(message => record(message.info).role === "user")).toEqual(usersAtStop);
    expect(await connector.toolCalls()).toEqual([]);
    await user.screenshot();
    evidence.recordAssertionEvidence("Only the user click authorizes; completion does not retry the stopped task", "The provider recorded one authorization and a successful authorization-code exchange; the decision panel reports Connected. Nothing retried. with no duplicate transcript card or new model/provider tool calls. This is OAuth completion, not provider-health proof.", true);

    await user.click({ role: "button", label: "Draft retry" });
    await user.notSee({ testId: "connection-decision-panel" });
    await user.see({ testId: "desktop-connection-card" });
    expect((await probe.dom('[data-testid="desktop-connection-card"]')).elements).toHaveLength(1);
    const draft = await probe.composer();
    expect(draft.draftText).toContain("Check whether the Notion connection is ready");
    expect(draft.draftText).toContain("Verify whether any earlier operation completed");
    expect(draft.draftText).not.toContain(world.connection.id);
    const quietUntil = Date.now() + 3_000;
    await probe.eventually(async () => {
      expect(await modelTools()).toEqual(callsAtStop);
      expect((await connector.agentRequests()).filter(call => call.kind === "tool")).toEqual(allToolsAtStop);
      const currentMessages = await messages();
      expect(currentMessages.filter(message => record(message.info).role === "user")).toEqual(usersAtStop);
      expect(turnTools(currentMessages, entry.prompt)).toEqual(completedTools);
      expect(await connector.toolCalls()).toEqual([]);
      return Date.now() >= quietUntil;
    }, { within: 10_000, label: "drafting a retry never submits or resumes the interrupted task", until: Boolean });
    await user.screenshot();
    evidence.recordAssertionEvidence("Draft retry is editable text, never an automatic submission", "A readiness-first draft asks to verify earlier completion; the persisted tool parts and mock model/provider tool counts stay unchanged throughout the observation window", true);

    await connector.resetOAuth();
    const rejected = await probe.api(world.den.admin, `/v1/mcp-connections/${encodeURIComponent(world.connection.id)}/tools`);
    expect(rejected.response.ok).toBe(false);
    expect(rejected.response.status).toBe(502);
    expect(rejected.body).toMatchObject({ error: "tool_catalog_failed", diagnostic: { httpStatus: 400 } });
    const rejectedRequests = await connector.requests();
    expect(rejectedRequests).toEqual(expect.arrayContaining([expect.objectContaining({ path: "/token", status: 400, grantType: "refresh_token" })]));
    const reauthRpc = await gateway("tools/call", { name: "execute_capability", arguments: { name: statusName } });
    expect(reauthRpc.error).toBeUndefined();
    const reauthResult = record(reauthRpc.result);
    expect(reauthResult.isError).not.toBe(true);
    expect(reauthResult.structuredContent).toMatchObject(expectedConnection);
    expect(record(reauthResult.structuredContent).state).not.toBe("connected");
    expect((await connector.requests()).filter(request => request.path === "/authorize")).toHaveLength(1);
    expect(await modelTools()).toEqual(callsAtStop);
    expect((await connector.agentRequests()).filter(call => call.kind === "tool")).toEqual(allToolsAtStop);
    expect((await messages()).filter(message => record(message.info).role === "user")).toEqual(usersAtStop);
    expect(await connector.toolCalls()).toEqual([]);
    evidence.recordAssertionEvidence("A successful status RPC is not a healthy-provider claim", `After mock credential revocation, the real tools probe returned HTTP ${rejected.response.status} and the provider rejected the refresh grant with HTTP 400. Exact status execution succeeded as an RPC but reported needs_connection and the member Connect action, with no new authorization or model retry.`, true);
  });
}
