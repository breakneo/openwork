/** @jsxImportSource react */
import { describe, expect, spyOn, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { createOpenworkServerClient, OpenworkServerError, type OpenworkMcpAppResource, type OpenworkServerClient } from "../src/app/lib/openwork-server";
import { createMcpAppActions } from "../src/components/chat/mcp-app-origin";
import { McpAppFrame } from "../src/components/chat/mcp-app-frame";
import { MessageListProvider } from "../src/components/chat/message-list-provider";
import { WorkspaceProvider } from "../src/react-app/shell/workspace-provider";

const app: OpenworkMcpAppResource = {
  launchId: "launch-a", serverName: "fixture", toolName: "render", resourceUri: "ui://fixture/view.html",
  html: "<p>Fixture</p>", csp: { connectDomains: [], resourceDomains: [], frameDomains: [], baseUriDomains: [] }, prefersBorder: true,
};
const result = { content: [{ type: "text", text: "ok" }] };
const needsApproval = () => new OpenworkServerError(422, "tool_requires_approval", "Approval required");

describe("App conversation ownership", () => {
  test.each([false, true])("split message origin survives discovery recovery and archive changes (retry: %j)", async (retry) => {
    GlobalRegistrator.register({ url: "http://localhost/" });
    const previousAct = Reflect.get(globalThis, "IS_REACT_ACT_ENVIRONMENT");
    Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
    const requests: unknown[] = [];
    const retryCallbacks: (() => void)[] = [];
    const delays: number[] = [];
    const setTimer = window.setTimeout.bind(window);
    const timerSpy = spyOn(window, "setTimeout").mockImplementation((callback, delay, ...args) => {
      if (typeof callback === "function" && (delay === 1_000 || delay === 3_000)) {
        const timer = setTimer(() => {}, 60_000);
        retryCallbacks.push(() => { window.clearTimeout(timer); callback(...args); });
        delays.push(delay);
        return timer;
      }
      return setTimer(callback, delay, ...args);
    });
    let toolCalls = 0;
    const primary = { ...createOpenworkServerClient({ baseUrl: "http://primary.invalid" }),
      resolveMcpApp: async () => { throw new Error("Must not use the primary endpoint"); } };
    const secondary: OpenworkServerClient = { ...createOpenworkServerClient({ baseUrl: "http://secondary.invalid" }),
      resolveMcpApp: async (workspaceId, name, launch, context) => {
        requests.push({ workspaceId, name, launch, context });
        if (retry && requests.length <= 3) throw new OpenworkServerError(503, "mcp_unreachable", "Starting");
        return { app: null };
      },
      callMcpAppTool: async () => { toolCalls++; return result; },
    };
    const container = document.createElement("div");
    const root = createRoot(container);
    const render = (readOnly: boolean) => <WorkspaceProvider client={null} openworkServerClient={primary} workspaceId="workspace-a" selectedWorkspaceRoot="/a">
      <MessageListProvider client={secondary} workspaceId="workspace-b" sessionId="session-b" readOnly={readOnly}
        showThinking={false} developerMode={false} displaySuggestions={false} providerConnectedCount={0}
        dispatchAction={() => {}} setPrompt={() => {}} onRevertToUserMessage={() => {}} onForkAtMessage={() => {}}
        onEditUserMessage={() => {}} onMcpReconnect={async () => { throw new Error("unused"); }}
        onMcpReopenAuthorization={async () => {}} onMcpRetry={() => {}}>
        <McpAppFrame part={{ type: "dynamic-tool", toolName: "fixture_render", toolCallId: "call-b", state: "output-available", input: {}, output: {},
          callProviderMetadata: { openwork: { mcpResult: { content: [] } } } }} />
      </MessageListProvider>
    </WorkspaceProvider>;
    try {
      await act(async () => { root.render(render(false)); });
      if (retry) {
        for (let i = 0; i < 2; i++) {
          const callback = retryCallbacks.shift();
          if (!callback) throw new Error("Missing discovery retry");
          await act(async () => callback());
        }
        expect(requests).toHaveLength(3);
        expect(delays).toEqual([1_000, 3_000]);
        expect(retryCallbacks).toEqual([]);
        const button = container.querySelector<HTMLButtonElement>("button");
        expect(button?.textContent).toBe("Retry");
        await act(async () => button?.click());
        expect(requests).toHaveLength(4);
        expect(container.querySelector("button")).toBeNull();
      }
      await act(async () => { root.render(render(true)); });
      expect(requests).toEqual([
        ...Array.from({ length: retry ? 4 : 1 }, () => ({ workspaceId: "workspace-b", name: "fixture_render", launch: undefined, context: { client: secondary, workspaceId: "workspace-b", sessionId: "session-b", readOnly: false } })),
        { workspaceId: "workspace-b", name: "fixture_render", launch: undefined, context: { client: secondary, workspaceId: "workspace-b", sessionId: "session-b", readOnly: true } },
      ]);
      expect(toolCalls).toBe(0);
    } finally {
      await act(async () => { root.unmount(); });
      timerSpy.mockRestore();
      Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", previousAct);
      await GlobalRegistrator.unregister();
    }
  });

  test.each([false, true])("follow-up calls retain the exact launch and only retry approval challenges (challenge: %j)", async (challenge) => {
    const requests: unknown[] = [];
    const client: OpenworkServerClient = { ...createOpenworkServerClient({ baseUrl: "http://secondary.invalid" }),
      callMcpAppTool: async (workspaceId, payload) => {
        requests.push({ workspaceId, payload });
        if (challenge && !payload.approved) throw needsApproval();
        return result;
      } };
    const actions = createMcpAppActions({ client, workspaceId: "workspace-b", sessionId: "session-b", readOnly: false }, app);
    expect(await actions.callTool("write_detail", { id: "b" })).toEqual(result);
    expect(requests).toEqual((challenge ? [false, true] : [false]).map(approved => ({ workspaceId: "workspace-b", payload: {
      launchId: "launch-a", sessionId: "session-b", serverName: "fixture", resourceUri: app.resourceUri,
      name: "write_detail", arguments: { id: "b" }, ...(approved ? { approved: true } : {}),
    } })));
  });

  test.each([
    new OpenworkServerError(403, "tool_denied", "Forbidden"),
    new Error("tool_requires_approval"),
    needsApproval(),
  ])("does not retry other errors or repeat a challenged retry: %s", async (failure) => {
    const approvals: Array<boolean | undefined> = [];
    const client: OpenworkServerClient = { ...createOpenworkServerClient({ baseUrl: "http://fixture.invalid" }),
      callMcpAppTool: async (_workspace, payload) => { approvals.push(payload.approved); throw failure; } };
    const actions = createMcpAppActions({ client, workspaceId: "b", sessionId: "b", readOnly: false }, app);
    await expect(actions.callTool("write_detail")).rejects.toBe(failure);
    expect(approvals).toEqual(failure instanceof OpenworkServerError && failure.code === "tool_requires_approval"
      ? [undefined, true] : [undefined]);
  });

  test("unmount before an approval challenge prevents retry and subsequent dispatch", async () => {
    let reject: (error: Error) => void = () => { throw new Error("Missing pending call"); };
    let calls = 0;
    const client: OpenworkServerClient = { ...createOpenworkServerClient({ baseUrl: "http://fixture.invalid" }),
      callMcpAppTool: async () => { calls++; return new Promise((_, fail) => { reject = fail; }); } };
    const actions = createMcpAppActions({ client, workspaceId: "b", sessionId: "b", readOnly: false }, app);
    const pending = actions.callTool("write_detail");
    actions.dispose();
    reject(needsApproval());
    await expect(pending).rejects.toThrow("closed or changed");
    await expect(actions.callTool("write_detail")).rejects.toThrow("closed or changed");
    expect(calls).toBe(1);
  });

  test.each([false, true])("a result completing after disposal is discarded (retry: %j)", async (retry) => {
    let complete: (value: typeof result) => void = () => { throw new Error("Missing pending call"); };
    let calls = 0;
    let started: () => void = () => {};
    const waiting = new Promise<void>(resolve => { started = resolve; });
    const client: OpenworkServerClient = { ...createOpenworkServerClient({ baseUrl: "http://fixture.invalid" }),
      callMcpAppTool: async (_workspace, payload) => {
        calls++;
        if (retry && !payload.approved) throw needsApproval();
        return new Promise(resolve => { complete = resolve; started(); });
      } };
    const actions = createMcpAppActions({ client, workspaceId: "b", sessionId: "b", readOnly: false }, app);
    const pending = actions.callTool("write_detail");
    await waiting;
    actions.dispose();
    complete(result);
    await expect(pending).rejects.toThrow("closed or changed");
    expect(calls).toBe(retry ? 2 : 1);
  });

  test("read-only previews and missing leases cannot call tools or open links", async () => {
    let calls = 0;
    const client: OpenworkServerClient = { ...createOpenworkServerClient({ baseUrl: "http://fixture.invalid" }),
      callMcpAppTool: async () => { calls++; return result; } };
    for (const readOnly of [true, false]) {
      const actions = createMcpAppActions({ client, workspaceId: "b", sessionId: "b", readOnly }, { ...app, launchId: readOnly ? app.launchId : undefined });
      expect(() => actions.assertActive()).toThrow(readOnly ? "read-only" : "no live launch context");
      await expect(actions.callTool("read_detail")).rejects.toThrow(readOnly ? "read-only" : "no live launch context");
    }
    expect(calls).toBe(0);
  });
});
