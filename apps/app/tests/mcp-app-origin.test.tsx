/** @jsxImportSource react */
import { afterAll, describe, expect, spyOn, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, useLayoutEffect } from "react";
import { createRoot } from "react-dom/client";
import { createOpenworkServerClient, OpenworkServerError, type OpenworkMcpAppResource, type OpenworkServerClient } from "../src/app/lib/openwork-server";
import { createMcpAppActions } from "../src/components/chat/mcp-app-origin";

GlobalRegistrator.register({ url: "http://localhost/" });
afterAll(() => GlobalRegistrator.unregister());
const { useMcpAppApproval } = await import("../src/components/chat/use-mcp-app-approval");
const { McpAppFrame } = await import("../src/components/chat/mcp-app-frame");
const { MessageListProvider } = await import("../src/components/chat/message-list-provider");
const { WorkspaceProvider } = await import("../src/react-app/shell/workspace-provider");

const app: OpenworkMcpAppResource = {
  launchId: "launch-a", serverName: "fixture", toolName: "render", resourceUri: "ui://fixture/view.html",
  html: "<p>Fixture</p>", csp: { connectDomains: [], resourceDomains: [], frameDomains: [], baseUriDomains: [] }, prefersBorder: true,
};
const result = { content: [{ type: "text", text: "ok" }] };
const needsApproval = () => new OpenworkServerError(422, "tool_requires_approval", "Approval required");

describe("App conversation ownership", () => {
  test.each(["abort", "unmount", "replace"])("one host dialog owns a cancellable decision across views: %s", async mode => {
    const previousAct = Reflect.get(globalThis, "IS_REACT_ACT_ENVIRONMENT");
    Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
    const confirmSpy = spyOn(window, "confirm").mockReturnValue(true);
    const container = document.body.appendChild(document.createElement("div"));
    const root = createRoot(container);
    const callbacks: Array<ReturnType<typeof useMcpAppApproval>["requestApproval"]> = [];
    function Host({ index }: { index: number }) {
      const { requestApproval, approvalDialog } = useMcpAppApproval();
      useLayoutEffect(() => { callbacks[index] = requestApproval; }, [index, requestApproval]);
      return approvalDialog;
    }
    const request = { serverName: "fixture", toolName: "write_detail", arguments: { value: "<img src=x onerror=alert(1)>" } };
    const controller = new AbortController();
    let first: Promise<boolean> | undefined;
    try {
      await act(async () => root.render(<><Host index={0} /><Host index={1} /></>));
      const stable = callbacks[0];
      if (!stable || !callbacks[1]) throw new Error("Missing host");
      await act(async () => { first = stable(request, controller.signal); });
      expect(callbacks[0]).toBe(stable);
      expect(await callbacks[1](request, new AbortController().signal)).toBe(false);
      expect(await stable(request, controller.signal)).toBe(false);
      expect(document.querySelectorAll('[role="alertdialog"]')).toHaveLength(1);
      expect(document.querySelector('[role="alertdialog"] pre')?.textContent).toContain(request.arguments.value);
      expect(document.querySelector('[role="alertdialog"] img')).toBeNull();
      if (mode === "abort") await act(async () => controller.abort());
      else await act(async () => root.render(<>{mode === "unmount" ? null : <Host index={0} key={mode} />}<Host index={1} /></>));
      expect(await first).toBe(false);
      expect(document.querySelector('[role="alertdialog"]')).toBeNull();
      let next: Promise<boolean> | undefined;
      await act(async () => { next = callbacks[1]?.(request, new AbortController().signal); });
      const allow = Array.from(document.querySelectorAll<HTMLButtonElement>('[role="alertdialog"] button')).find(button => button.textContent === "Allow once");
      if (!allow) throw new Error("Missing Allow once");
      await act(async () => allow.click());
      expect(await next).toBe(true);
      expect(confirmSpy).not.toHaveBeenCalled();
    } finally {
      await act(async () => root.unmount());
      confirmSpy.mockRestore();
      container.remove();
      Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", previousAct);
    }
  });

  test.each([false, true])("split message origin survives discovery recovery and archive changes (retry: %j)", async (retry) => {
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
    const actions = createMcpAppActions({ client, workspaceId: "workspace-b", sessionId: "session-b", readOnly: false }, app, async () => true);
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
    const actions = createMcpAppActions({ client, workspaceId: "b", sessionId: "b", readOnly: false }, app, async () => true);
    await expect(actions.callTool("write_detail")).rejects.toBe(failure);
    expect(approvals).toEqual(failure instanceof OpenworkServerError && failure.code === "tool_requires_approval"
      ? [undefined, true] : [undefined]);
  });

  test("unmount before an approval challenge prevents retry and subsequent dispatch", async () => {
    let reject: (error: Error) => void = () => { throw new Error("Missing pending call"); };
    let calls = 0;
    const client: OpenworkServerClient = { ...createOpenworkServerClient({ baseUrl: "http://fixture.invalid" }),
      callMcpAppTool: async () => { calls++; return new Promise((_, fail) => { reject = fail; }); } };
    const actions = createMcpAppActions({ client, workspaceId: "b", sessionId: "b", readOnly: false }, app, async () => true);
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
    const actions = createMcpAppActions({ client, workspaceId: "b", sessionId: "b", readOnly: false }, app, async () => true);
    const pending = actions.callTool("write_detail");
    await waiting;
    actions.dispose();
    complete(result);
    await expect(pending).rejects.toThrow("closed or changed");
    expect(calls).toBe(retry ? 2 : 1);
  });

  test.each(["allow", "cancel", "dispose", "default"])("approval is per-call and bound to an immutable active request: %s", async mode => {
    const calls: Array<{ approved?: boolean; arguments?: Record<string, unknown> }> = [];
    let decide: (allowed: boolean) => void = () => { throw new Error("Missing decision"); };
    let signal: AbortSignal | undefined;
    let shown: unknown;
    let requested: () => void = () => {};
    const waiting = new Promise<void>(resolve => { requested = resolve; });
    const client: OpenworkServerClient = { ...createOpenworkServerClient({ baseUrl: "http://fixture.invalid" }),
      callMcpAppTool: async (_workspace, payload) => {
        calls.push(payload);
        if (!payload.approved) throw needsApproval();
        return result;
      } };
    const origin = { client, workspaceId: "b", sessionId: "b", readOnly: false };
    const actions = mode === "default" ? createMcpAppActions(origin, app) : createMcpAppActions(origin, app, (request, abortSignal) => {
      shown = request;
      signal = abortSignal;
      requested();
      return new Promise(resolve => { decide = resolve; });
    });
    const args = { nested: { value: "original" } };
    const pending = actions.callTool("write_detail", args);
    const outcome = pending.then(value => value, error => error);
    args.nested.value = "changed";
    if (mode !== "default") {
      await waiting;
      expect(calls).toHaveLength(1);
      expect(shown).toEqual({ serverName: "fixture", toolName: "write_detail", arguments: { nested: { value: "original" } } });
      expect(Object.isFrozen(calls[0]?.arguments?.nested)).toBe(true);
      await expect(actions.callTool("another_write")).rejects.toThrow("awaiting approval");
      expect(calls.every(call => !call.approved)).toBe(true);
      if (mode === "dispose") { actions.dispose(); expect(signal?.aborted).toBe(true); }
      decide(mode !== "cancel");
    }
    if (mode === "allow") {
      expect(await outcome).toEqual(result);
      expect(calls.at(-1)).toMatchObject({ approved: true, arguments: { nested: { value: "original" } } });
    } else {
      expect(await outcome).toBeInstanceOf(Error);
      expect(calls.every(call => !call.approved)).toBe(true);
    }
    actions.dispose();
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
