import { afterAll, describe, expect, spyOn, test } from "bun:test"
import { GlobalRegistrator } from "@happy-dom/global-registrator"
import { act, createElement } from "react"
import { createRoot } from "react-dom/client"
import { AppBridge } from "@modelcontextprotocol/ext-apps/app-bridge"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js"
import type { DynamicToolUIPart } from "ai"

import {
  createOpenworkServerClient,
  normalizeMcpAppHostOrigin,
  OpenworkServerError,
  type OpenworkMcpAppResource,
  type OpenworkServerClient,
} from "../src/app/lib/openwork-server"
import { formatMcpAppDiagnostic, safeMcpAppDiagnosticMessage } from "../src/components/chat/mcp-app-diagnostics"

GlobalRegistrator.register({ url: "http://localhost/", happyDOM: { settings: { disableIframePageLoading: true } } })
afterAll(() => GlobalRegistrator.unregister())
const { ConnectionCard } = await import("../src/components/chat/connection-card")
const { MessageListProvider } = await import("../src/components/chat/message-list-provider")
const { WorkspaceProvider } = await import("../src/react-app/shell/workspace-provider")
const {
  buildMcpAppCsp,
  connectorCatalogFromPart,
  hasPreservedMcpAppResult,
  gatewayMcpAppLaunch,
  isActionableMcpAppResolutionError,
  McpAppFrame,
  McpAppSandboxView,
  secureMcpAppHtml,
} = await import("../src/components/chat/mcp-app-frame")

function fixture(overrides: Partial<OpenworkMcpAppResource> = {}): OpenworkMcpAppResource {
  return {
    launchId: "launch_fixture",
    serverName: "fixture",
    toolName: "render",
    resourceUri: "ui://fixture/view.html",
    html: "<!doctype html><html><head><title>Fixture</title></head><body>ok</body></html>",
    csp: {
      connectDomains: [],
      resourceDomains: [],
      frameDomains: [],
      baseUriDomains: [],
    },
    prefersBorder: true,
    ...overrides,
  }
}

async function startupFixture() {
  const previousAct = Reflect.get(globalThis, "IS_REACT_ACT_ENVIRONMENT")
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true)
  const container = document.body.appendChild(document.createElement("div"))
  const root = createRoot(container)
  const timers = new Map<number, { at: number; run: () => void }>()
  const deadlines: number[] = []
  let now = 0
  let timerId = 0
  const timerSpy = spyOn(window, "setTimeout").mockImplementation((callback, delay = 0, ...args) => {
    if (typeof callback !== "function") throw new Error("Expected a timer callback")
    timers.set(++timerId, { at: now + delay, run: () => callback(...args) })
    if (delay === 10_000) deadlines.push(now + delay)
    return timerId
  })
  const clearSpy = spyOn(window, "clearTimeout").mockImplementation(id => { if (id !== undefined) timers.delete(id) })
  const bridges: AppBridge[] = []
  const connectSpy = spyOn(AppBridge.prototype, "connect").mockImplementation(async function () { bridges.push(this) })
  const resourceSpy = spyOn(AppBridge.prototype, "sendSandboxResourceReady").mockResolvedValue(undefined)
  const inputSpy = spyOn(AppBridge.prototype, "sendToolInput").mockResolvedValue(undefined)
  const resultSpy = spyOn(AppBridge.prototype, "sendToolResult").mockResolvedValue(undefined)
  const teardownSpy = spyOn(AppBridge.prototype, "teardownResource").mockResolvedValue({})
  const closeSpy = spyOn(AppBridge.prototype, "close").mockResolvedValue(undefined)
  const errorSpy = spyOn(console, "error").mockImplementation(() => {})
  const addListenerSpy = spyOn(window, "addEventListener")
  const removeListenerSpy = spyOn(window, "removeEventListener")
  const client: OpenworkServerClient = {
    ...createOpenworkServerClient({ baseUrl: "http://localhost:1" }),
    mcpAppSandbox: app => ({ url: `about:blank#${app.toolName}`, expectedOrigin: "https://sandbox.example" }),
  }
  const views = Array.from({ length: 6 }, (_, index) => createElement(McpAppSandboxView, {
    key: index,
    origin: { client, workspaceId: `workspace-${index % 2}`, sessionId: null, readOnly: true },
    app: fixture({ toolName: `render-${index}` }), toolName: `render-${index}`,
    inputArguments: {}, result: { content: [] }, unavailableNotice: "Unavailable",
  }))
  const render = async (ids: number[]) => { await act(async () => root.render(createElement("div", null, ids.map(id => views[id])))) }
  const frame = (id: number) => {
    const iframe = container.querySelector<HTMLIFrameElement>(`iframe[title="render-${id} interactive view"]`)
    if (!iframe?.contentWindow) throw new Error(`Missing iframe ${id}`)
    return iframe
  }
  const notify = async (id: number, method: string, origin = "https://sandbox.example") => {
    await act(async () => { window.dispatchEvent(new MessageEvent("message", { source: frame(id).contentWindow, origin, data: { method } })) })
  }
  const advance = async (ms: number) => {
    const target = now + ms
    for (;;) {
      const next = [...timers.entries()].filter(([, timer]) => timer.at <= target).sort((a, b) => a[1].at - b[1].at)[0]
      if (!next) break
      now = next[1].at
      timers.delete(next[0])
      await act(async () => next[1].run())
    }
    now = target
  }
  return {
    render, frame, notify, advance, bridges, deadlines, timers, container,
    connectSpy, resourceSpy, inputSpy, resultSpy, teardownSpy, closeSpy, errorSpy,
    async dispose() {
      try {
        await act(async () => root.unmount())
        expect(timers.size).toBe(0)
        const added = addListenerSpy.mock.calls.filter(([name]) => name === "message").map(([, listener]) => listener)
        const removed = removeListenerSpy.mock.calls.filter(([name]) => name === "message").map(([, listener]) => listener)
        expect(removed).toEqual(expect.arrayContaining(added))
      } finally {
        for (const spy of [timerSpy, clearSpy, connectSpy, resourceSpy, inputSpy, resultSpy, teardownSpy, closeSpy, errorSpy, addListenerSpy, removeListenerSpy]) spy.mockRestore()
        container.remove()
        Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", previousAct)
      }
    },
  }
}

describe("MCP App startup scheduling", () => {
  test("starts at most two Apps across workspaces and advances FIFO only after initialization", async () => {
    const host = await startupFixture()
    try {
      await host.render([0, 1, 2, 3, 4])
      expect([0, 1, 2, 3, 4].map(id => host.frame(id).getAttribute("src"))).toEqual(["about:blank#render-0", "about:blank#render-1", null, null, null])
      expect(host.deadlines).toEqual([10_000, 10_000])
      await host.notify(2, "ui/notifications/sandbox-proxy-ready")
      await host.notify(0, "ui/notifications/sandbox-proxy-ready", "https://wrong.example")
      expect(host.connectSpy).not.toHaveBeenCalled()
      await host.notify(0, "ui/notifications/sandbox-proxy-ready")
      await host.notify(1, "ui/notifications/sandbox-proxy-ready")
      expect(host.resourceSpy).toHaveBeenCalledTimes(2)
      expect(host.frame(2).getAttribute("src")).toBeNull()
      await act(async () => { host.bridges[1].oninitialized?.() })
      expect(host.frame(2).getAttribute("src")).toBe("about:blank#render-2")
      expect(host.frame(3).getAttribute("src")).toBeNull()
      await act(async () => { host.bridges[1].oninitialized?.() })
      expect(host.frame(3).getAttribute("src")).toBeNull()
      await act(async () => { host.bridges[0].oninitialized?.() })
      expect(host.frame(3).getAttribute("src")).toBe("about:blank#render-3")
      expect(host.frame(4).getAttribute("src")).toBeNull()
      expect(host.inputSpy).toHaveBeenCalledTimes(2)
      expect(host.resultSpy).toHaveBeenCalledTimes(2)
      await host.advance(10_000)
      expect(host.errorSpy.mock.calls.map(([, diagnostic]) => diagnostic.toolName)).toEqual(["render-2", "render-3"])
      expect(host.frame(0).getAttribute("src")).toBe("about:blank#render-0")
      expect(host.frame(1).getAttribute("src")).toBe("about:blank#render-1")
    } finally { await host.dispose() }
  })

  test("gives each navigation ten seconds, excludes queue time, and never retries a timed-out startup", async () => {
    const host = await startupFixture()
    try {
      await host.render([0, 1, 2, 3, 4])
      await host.advance(9_999)
      expect(host.errorSpy).not.toHaveBeenCalled()
      await host.advance(1)
      expect(host.errorSpy).toHaveBeenCalledTimes(2)
      expect(host.deadlines).toEqual([10_000, 10_000, 20_000, 20_000])
      expect(host.frame(2).getAttribute("src")).toBe("about:blank#render-2")
      expect(host.frame(4).getAttribute("src")).toBeNull()
      await host.advance(9_999)
      expect(host.errorSpy).toHaveBeenCalledTimes(2)
      await host.advance(1)
      expect(host.errorSpy).toHaveBeenCalledTimes(4)
      expect(host.deadlines).toEqual([10_000, 10_000, 20_000, 20_000, 30_000])
      await host.advance(9_999)
      expect(host.errorSpy).toHaveBeenCalledTimes(4)
      await host.advance(1)
      expect(host.errorSpy).toHaveBeenCalledTimes(5)
      for (const [, diagnostic] of host.errorSpy.mock.calls) {
        expect(diagnostic).toMatchObject({ code: "MCP_APP_SANDBOX_PROXY_TIMEOUT", message: expect.stringContaining("within 10 seconds") })
      }
      await host.advance(60_000)
      expect(host.deadlines).toHaveLength(5)
      expect(host.timers.size).toBe(0)
      expect(host.connectSpy).not.toHaveBeenCalled()
      expect(host.teardownSpy).not.toHaveBeenCalled()
      expect(host.closeSpy).toHaveBeenCalledTimes(5)
    } finally { await host.dispose() }
  })

  test("cancels queued unmounts and does not navigate siblings during a whole-view teardown", async () => {
    const host = await startupFixture()
    try {
      await host.render([0, 1, 2, 3, 4])
      await host.render([0, 1, 3, 4])
      expect(host.deadlines).toHaveLength(2)
      await host.render([1, 3, 4])
      expect(host.frame(3).getAttribute("src")).toBe("about:blank#render-3")
      expect(host.frame(4).getAttribute("src")).toBeNull()
      expect(host.deadlines).toHaveLength(3)
      await host.render([])
      expect(host.deadlines).toHaveLength(3)
      expect(host.timers.size).toBe(0)
      await host.render([0, 1, 2])
      expect(host.frame(0).getAttribute("src")).toBe("about:blank#render-0")
      expect(host.frame(1).getAttribute("src")).toBe("about:blank#render-1")
      expect(host.frame(2).getAttribute("src")).toBeNull()
    } finally { await host.dispose() }
  })

  test.each(["failure", "initialize-timeout", "teardown"])("releases a startup slot on %s and ignores late callbacks", async mode => {
    const host = await startupFixture()
    try {
      await host.render([0, 1, 2])
      await host.notify(0, "ui/notifications/sandbox-proxy-ready")
      await host.notify(1, "ui/notifications/sandbox-proxy-ready")
      await host.notify(0, "ui/notifications/sandbox-resource-accepted")
      await host.notify(1, "ui/notifications/sandbox-resource-accepted")
      if (mode === "failure") await host.notify(0, "ui/notifications/sandbox-diagnostic")
      else if (mode === "teardown") await act(async () => { await host.bridges[0].onrequestteardown?.({}) })
      else {
        await host.advance(10_000)
        expect(host.errorSpy).toHaveBeenCalledTimes(2)
        for (const [, diagnostic] of host.errorSpy.mock.calls) expect(diagnostic.code).toBe("MCP_APP_INITIALIZE_TIMEOUT")
      }
      expect(host.frame(2).getAttribute("src")).toBe("about:blank#render-2")
      const timerCount = host.timers.size
      await act(async () => { host.bridges[0].oninitialized?.() })
      expect(host.inputSpy).not.toHaveBeenCalled()
      expect(host.timers.size).toBe(timerCount)
      expect(host.resourceSpy).toHaveBeenCalledTimes(2)
    } finally { await host.dispose() }
  })

  test.each(["connect", "delivery"])("unmount during pending %s cannot deliver or recreate startup timers", async mode => {
    const host = await startupFixture()
    let finish: (() => void) | undefined
    const pending = new Promise<void>(resolve => { finish = resolve })
    try {
      if (mode === "connect") host.connectSpy.mockImplementationOnce(() => pending)
      else host.resourceSpy.mockImplementationOnce(() => pending)
      await host.render([0, 1, 2])
      await host.notify(0, "ui/notifications/sandbox-proxy-ready")
      await host.render([1, 2])
      expect(host.frame(2).getAttribute("src")).toBe("about:blank#render-2")
      await act(async () => { finish?.() })
      expect(host.resourceSpy).toHaveBeenCalledTimes(mode === "connect" ? 0 : 1)
      expect(host.timers.size).toBe(2)
      await host.render([])
      await host.advance(60_000)
      expect(host.errorSpy).not.toHaveBeenCalled()
      expect(host.timers.size).toBe(0)
    } finally { finish?.(); await host.dispose() }
  })
})

describe("MCP App iframe policy", () => {
  test.each([
    { isError: true, readOnly: false, preview: false, challenge: false },
    { isError: false, readOnly: false, preview: false, challenge: false },
    { isError: undefined, readOnly: false, preview: false, challenge: false },
    { isError: false, readOnly: false, preview: false, challenge: true },
    { isError: false, readOnly: true, preview: false, challenge: true },
    { isError: false, readOnly: true, preview: true, challenge: true },
  ].flatMap(entry => (entry.challenge && !entry.readOnly ? [true, false] : [true]).map(allow => ({ ...entry, allow }))))("delivers complete launch results and truthful SDK responses without native confirmations (%j)", async ({ isError, readOnly, preview, challenge, allow }) => {
    const previousAct = Object.getOwnPropertyDescriptor(globalThis, "IS_REACT_ACT_ENVIRONMENT")
    Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true })
    const container = document.body.appendChild(document.createElement("div"))
    const root = createRoot(container)
    const [viewTransport, hostTransport] = InMemoryTransport.createLinkedPair()
    const confirmSpy = spyOn(window, "confirm").mockReturnValue(false)
    const connect = AppBridge.prototype.connect
    const connectSpy = spyOn(AppBridge.prototype, "connect").mockImplementation(function () {
      return connect.call(this, hostTransport)
    })
    const messages: JSONRPCMessage[] = []
    let reply: ((message: JSONRPCMessage) => void) | undefined
    viewTransport.onmessage = (message) => {
      messages.push(message)
      if ("id" in message && ("result" in message || "error" in message)) reply?.(message)
      if ("method" in message && message.method === "ui/resource-teardown" && "id" in message) {
        void viewTransport.send({ jsonrpc: "2.0", id: message.id, result: {} })
      }
    }
    let id = 0
    const request = async (method: string, params: Record<string, unknown> = {}) => {
      const requestId = ++id
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        const response = new Promise<JSONRPCMessage>((resolve, reject) => {
          reply = message => { if ("id" in message && message.id === requestId) resolve(message) }
          timer = setTimeout(() => reject(new Error(`No response to ${method}`)), 1_000)
        })
        await viewTransport.send({ jsonrpc: "2.0", id: requestId, method, params })
        return await response
      } finally { clearTimeout(timer); reply = undefined }
    }
    const result = {
      content: [{ type: "text", text: "Provider fallback" }],
      structuredContent: { serverTools: { provider: true }, schemaGuidance: "provider data" },
      _meta: { privateFixture: "view-only" },
      ...(isError === undefined ? {} : { isError }),
    }
    const input = { query: "complete launch input" }
    const resolutions: unknown[] = []
    const toolCalls: unknown[] = []
    const releases: unknown[] = []
    const opened: string[] = []
    Reflect.set(window, "__OPENWORK_ELECTRON__", { shell: { openExternal: async (url: string) => { opened.push(url); return { ok: true } } } })
    const app = fixture({ launchId: readOnly ? undefined : "launch_fixture" })
    const client: OpenworkServerClient = {
      ...createOpenworkServerClient({ baseUrl: "http://localhost:1" }),
      resolveMcpApp: async (workspaceId, name, launch, context) => {
        resolutions.push({ workspaceId, name, launch, context })
        return { app }
      },
      mcpAppSandbox: () => ({ url: "about:blank", expectedOrigin: "https://sandbox.example" }),
      callMcpAppTool: async (workspaceId, payload) => {
        toolCalls.push({ workspaceId, payload })
        if (payload.name === "forbidden_detail") throw new OpenworkServerError(403, "tool_denied", "Forbidden")
        if (challenge && !payload.approved) throw new OpenworkServerError(422, "tool_requires_approval", "Approval required")
        return result
      },
      releaseMcpApp: async (workspaceId, launchId) => { releases.push({ workspaceId, launchId }); return { released: true } },
    }
    const primaryClient: OpenworkServerClient = {
      ...client,
      resolveMcpApp: async () => { throw new Error("Must not resolve through the selected workspace") },
      callMcpAppTool: async () => { throw new Error("Must not call through the selected workspace") },
      releaseMcpApp: async () => { throw new Error("Must not release through the selected workspace") },
    }
    const part: DynamicToolUIPart = {
      type: "dynamic-tool", toolName: "fixture_render", toolCallId: "launch", state: "output-available",
      input, output: "Provider fallback", callProviderMetadata: { openwork: { mcpResult: result } },
    }
    try {
      await viewTransport.start()
      await act(async () => root.render(createElement(WorkspaceProvider, {
        client: null, openworkServerClient: primaryClient, workspaceId: "primary", selectedWorkspaceRoot: "/primary",
        children: preview
          ? createElement(McpAppSandboxView, {
              origin: { client, workspaceId: "fixture", sessionId: null, readOnly: true },
              app, toolName: part.toolName, inputArguments: input, result, unavailableNotice: "Unavailable",
            })
          : createElement(MessageListProvider, {
              client, workspaceId: "fixture", sessionId: "session_fixture", mcpAppEngine: "v2", readOnly,
              uiStateOwner: "fixture-principal/org/endpoint/workspace/session", showThinking: false, developerMode: false,
              displaySuggestions: false, providerConnectedCount: 0,
              dispatchAction: () => {}, setPrompt: () => {}, onRevertToUserMessage: () => {},
              onForkAtMessage: () => {}, onEditUserMessage: () => {},
              onMcpReconnect: async () => { throw new Error("Unexpected reconnect in protocol fixture") },
              onMcpReopenAuthorization: async () => {}, onMcpRetry: () => {},
              children: createElement(McpAppFrame, { part }),
            }),
      })))
      expect(resolutions).toEqual(preview ? [] : [{
        workspaceId: "fixture", name: part.toolName, launch: undefined,
        context: { client, workspaceId: "fixture", sessionId: "session_fixture", engine: "v2", readOnly },
      }])
      const iframe = container.querySelector("iframe")
      if (!iframe?.contentWindow) throw new Error("Missing fixture iframe")
      await act(async () => window.dispatchEvent(new MessageEvent("message", {
        source: iframe.contentWindow, origin: "https://sandbox.example",
        data: { method: "ui/notifications/sandbox-proxy-ready" },
      })))
      const initialized = await request("ui/initialize", {
        appInfo: { name: "fixture", version: "1" }, appCapabilities: {}, protocolVersion: "2026-01-26",
      })
      expect(initialized).toMatchObject({ result: {
        protocolVersion: "2026-01-26",
        hostContext: { displayMode: "inline", availableDisplayModes: ["inline"] },
      } })
      if (!("result" in initialized)) throw new Error("Initialization failed")
      expect(initialized.result.hostCapabilities).toEqual(readOnly ? {} : { serverTools: {}, openLinks: {} })
      expect(messages.some(message => "method" in message && message.method === "ui/notifications/tool-result")).toBe(false)
      await act(async () => { await viewTransport.send({ jsonrpc: "2.0", method: "ui/notifications/initialized" }) })
      const delivered = messages.filter(message => "method" in message && message.method.startsWith("ui/notifications/tool-"))
      expect(delivered).toEqual([
        { jsonrpc: "2.0", method: "ui/notifications/tool-input", params: { arguments: input } },
        { jsonrpc: "2.0", method: "ui/notifications/tool-result", params: result },
      ])
      for (const mode of ["inline", "fullscreen", "pip"]) {
        expect(await request("ui/request-display-mode", { mode })).toMatchObject({ result: { mode: "inline" } })
      }
      expect(await request("ui/request-display-mode", { mode: "invalid" })).toMatchObject({ error: { message: expect.stringContaining("Invalid input") } })
      for (const [method, params] of [
        ["ui/message", { role: "user", content: [{ type: "text", text: "not delivered" }] }],
        ["ui/update-model-context", { content: [{ type: "text", text: "not stored" }] }],
        ["resources/list", {}],
      ] satisfies Array<[string, Record<string, unknown>]>) {
        expect(await request(method, params)).toMatchObject({ error: { code: -32601 } })
      }
      let pendingCall: Promise<JSONRPCMessage> | undefined
      await act(async () => { pendingCall = request("tools/call", { name: "read_detail", arguments: {} }) })
      if (challenge && !readOnly) {
        expect(toolCalls).toHaveLength(1)
        const dialog = document.querySelector('[role="alertdialog"]')
        expect(dialog?.textContent).toContain("Allow App action?")
        expect(dialog?.textContent).toContain("fixture")
        expect(dialog?.textContent).toContain("read_detail")
        const button = Array.from(dialog?.querySelectorAll("button") ?? []).find(button => button.textContent === (allow ? "Allow once" : "Cancel"))
        if (!button) throw new Error("Missing approval decision")
        await act(async () => button.click())
      } else expect(document.querySelector('[role="alertdialog"]')).toBeNull()
      expect(await pendingCall).toMatchObject(
        readOnly ? { error: { code: -32601 } } : challenge && !allow ? { error: { message: expect.stringContaining("cancelled") } } : { result },
      )
      expect(await request("ui/open-link", { url: "https://example.com/" })).toMatchObject(
        readOnly ? { error: { code: -32601 } } : { result: {} },
      )
      expect(await request("ui/open-link", { url: "file:///not-a-web-link" })).toMatchObject(
        readOnly ? { error: { code: -32601 } } : { result: { isError: true } },
      )
      expect(toolCalls).toEqual(readOnly ? [] : (challenge && allow ? [false, true] : [false]).map(approved => ({ workspaceId: "fixture", payload: {
        launchId: "launch_fixture", sessionId: "session_fixture", engine: "v2",
        serverName: app.serverName, resourceUri: app.resourceUri, name: "read_detail", arguments: {},
        ...(approved ? { approved: true } : {}),
      } })))
      const callsBeforeDenial = toolCalls.length
      expect(await request("tools/call", { name: "forbidden_detail", arguments: {} })).toMatchObject(
        readOnly ? { error: { code: -32601 } } : { error: { message: expect.stringContaining("Forbidden") } },
      )
      expect(toolCalls).toHaveLength(callsBeforeDenial + (readOnly ? 0 : 1))
      expect(opened).toEqual(readOnly ? [] : ["https://example.com/"])
      if (challenge && !readOnly) {
        const callsBeforeReplacement = toolCalls.length
        await act(async () => { await viewTransport.send({ jsonrpc: "2.0", id: ++id, method: "tools/call", params: { name: "write_detail", arguments: { value: "old scope" } } }) })
        const staleAllow = document.querySelector<HTMLButtonElement>('[data-slot="alert-dialog-action"]')
        expect(staleAllow).not.toBeNull()
        expect(toolCalls).toHaveLength(callsBeforeReplacement + 1)
        await act(async () => root.render(allow ? createElement(McpAppSandboxView, {
          origin: { client, workspaceId: "other-workspace", sessionId: "other-session", readOnly: true },
          app, toolName: part.toolName, inputArguments: input, result, unavailableNotice: "Unavailable",
        }) : null))
        await act(async () => staleAllow?.click())
        expect(document.querySelector('[role="alertdialog"]')).toBeNull()
        expect(toolCalls).toHaveLength(callsBeforeReplacement + 1)
      }
      expect(confirmSpy).not.toHaveBeenCalled()
    } finally {
      try {
        await act(async () => root.unmount())
        expect(messages.some(message => "method" in message && message.method === "ui/resource-teardown")).toBe(true)
        expect(releases).toEqual(readOnly ? [] : [{ workspaceId: "fixture", launchId: "launch_fixture" }])
      } finally {
        confirmSpy.mockRestore()
        connectSpy.mockRestore()
        await viewTransport.close()
        container.remove()
        if (previousAct) Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", previousAct)
        else Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT")
      }
    }
  })

  test("connection status execution renders the native card even without preserved app metadata", () => {
    const part: DynamicToolUIPart = {
      type: "dynamic-tool", toolName: "openwork-cloud_execute_capability", toolCallId: "status-probe",
      state: "output-available", input: { name: "mcp:emc_notes:*" },
      output: { schemaVersion: "1", connectionId: "emc_notes", connectionName: "Notes", state: "needs_connection",
        actor: "member", message: "Connect Notes to continue.",
        action: { type: "connect", label: "Connect Notes", surface: "openwork_your_connections" } },
    }
    expect(hasPreservedMcpAppResult(part)).toBe(true)
    expect(McpAppFrame({ part })?.type).toBe(ConnectionCard)
    expect(McpAppFrame({ part: { ...part, output: { ...part.output, state: "connected", actor: null, action: null } } })?.type).toBe(ConnectionCard)
  })

  test("an unsupported first-party connection launch cannot fall back to the legacy iframe", () => {
    const part: DynamicToolUIPart = {
      type: "dynamic-tool", toolName: "openwork-cloud_execute_capability", toolCallId: "old-status-probe",
      state: "output-available", input: {}, output: {},
      callProviderMetadata: { openwork: { mcpResult: { content: [], _meta: { "openwork/mcpApp": {
        toolName: "connection_action", resourceUri: "ui://openwork/connection-action/v1/view.html", arguments: { connectionId: "emc_notes" },
      } } } } },
    }
    expect(McpAppFrame({ part })).toBeNull()
    expect(McpAppFrame({ part: { ...part, toolName: "other_execute_capability" } })).not.toBeNull()
  })

  test("accepts a namespaced gateway launch reference without exposing credentials", () => {
    expect(gatewayMcpAppLaunch({
      source: "provider",
      "openwork/mcpApp": {
        connectionId: "emc_01atlas",
        toolName: "open_project_atlas",
        resourceUri: "ui://atlas/1/index.html",
        arguments: { query: "migration" },
      },
    })).toEqual({
      connectionId: "emc_01atlas",
      toolName: "open_project_atlas",
      resourceUri: "ui://atlas/1/index.html",
      arguments: { query: "migration" },
    })
    expect(gatewayMcpAppLaunch({
      "openwork/mcpApp": {
        connectionId: "emc_01atlas",
        toolName: "open_project_atlas",
        resourceUri: "ui://atlas/1/index.html",
      },
    })).toBeNull()
  })

  test("accepts a same-server generated App launch without a connection reference", () => {
    expect(gatewayMcpAppLaunch({
      "openwork/mcpApp": {
        toolName: "render_artifact_view",
        resourceUri: "ui://openwork/artifacts/atlas/views/1/index.html",
        arguments: { input: { query: "migration" } },
      },
    })).toEqual({
      toolName: "render_artifact_view",
      resourceUri: "ui://openwork/artifacts/atlas/views/1/index.html",
      arguments: { input: { query: "migration" } },
    })
  })

  test("uses the opaque message origin for packaged file hosts", () => {
    expect(normalizeMcpAppHostOrigin("file://")).toBe("null")
    expect(normalizeMcpAppHostOrigin("null")).toBe("null")
    expect(normalizeMcpAppHostOrigin("https://desktop.example")).toBe("https://desktop.example")

    const client = createOpenworkServerClient({ baseUrl: "http://localhost:61856" })
    const sandbox = client.mcpAppSandbox(fixture(), "file://")
    expect(new URL(sandbox.url).searchParams.get("hostOrigin")).toBe("null")
  })

  test("keeps ordinary tools silent while surfacing advertised resource failures", () => {
    expect(isActionableMcpAppResolutionError(new OpenworkServerError(503, "mcp_unreachable", "offline"))).toBe(true)
    expect(isActionableMcpAppResolutionError(new OpenworkServerError(404, "resource_read_failed", "missing"))).toBe(true)
    expect(isActionableMcpAppResolutionError(new Error("generic failure"))).toBe(false)
  })

  test("formats safe, copyable handshake diagnostics", () => {
    const details = formatMcpAppDiagnostic({
      code: "MCP_APP_INITIALIZE_TIMEOUT",
      causeCode: "mcp_unreachable",
      stage: "app-initialization",
      message: "The HTML document loaded, but initialization did not complete.",
      toolName: "artifact_render_card",
      resourceUri: "ui://openwork/artifacts/arv_1/views/avr_2/index.html",
      sandboxOrigin: "http://127.0.0.1:4321",
      elapsedMs: 10_025,
      checkpoints: ["resource-resolved+0ms", "resource-document-loaded+24ms"],
      sandboxDocument: { readyState: "complete", hasHtmlRoot: true, scriptCount: 1 },
    })
    expect(details).toContain("Code: MCP_APP_INITIALIZE_TIMEOUT")
    expect(details).toContain("Cause code: mcp_unreachable")
    expect(details).toContain("Stage: app-initialization")
    expect(details).toContain("Resource: ui://openwork/artifacts/arv_1/views/avr_2/index.html")
    expect(details).toContain("Document: readyState=complete, htmlRoot=true, scripts=1")
    expect(details).toContain("resource-document-loaded+24ms")
  })

  test("redacts credentials from diagnostic messages", () => {
    expect(safeMcpAppDiagnosticMessage(
      new Error("request failed: Bearer secret-value https://example.com?access_token=also-secret"),
      "fallback",
    )).toBe("request failed: Bearer [redacted] https://example.com?access_token=[redacted]")
  })

  test("defaults every ambient capability closed", () => {
    const csp = buildMcpAppCsp(fixture())
    expect(csp).toContain("default-src 'none'")
    expect(csp).toContain("connect-src 'none'")
    expect(csp).toContain("frame-src 'none'")
    expect(csp).toContain("base-uri 'none'")
    expect(csp).toContain("form-action 'none'")
  })

  test("injects the host-enforced CSP before resource markup runs", () => {
    const html = secureMcpAppHtml(fixture())
    const policy = html.indexOf('http-equiv="Content-Security-Policy"')
    const title = html.indexOf("<title>")
    expect(policy).toBeGreaterThan(-1)
    expect(policy).toBeLessThan(title)
  })

  test("creates a valid policy-bearing head when the resource omits one", () => {
    const html = secureMcpAppHtml(fixture({ html: "<html><body>headless resource</body></html>" }))
    expect(html).toContain('<html><head><meta http-equiv="Content-Security-Policy"')
    expect(html.indexOf("Content-Security-Policy")).toBeLessThan(html.indexOf("<body>"))

    const fragment = secureMcpAppHtml(fixture({ html: "<main>fragment resource</main>" }))
    expect(fragment).toStartWith('<!doctype html><html><head><meta http-equiv="Content-Security-Policy"')
    expect(fragment).toContain("<body><main>fragment resource</main></body>")
  })

  test("rejects executable markup before an existing document policy", () => {
    expect(() => secureMcpAppHtml(fixture({
      html: "<script>globalThis.beforePolicy = true</script><html><head></head><body>bad</body></html>",
    }))).toThrow("executable markup before its HTML root")
    expect(() => secureMcpAppHtml(fixture({
      html: "<html><script>globalThis.beforePolicy = true</script><head></head><body>bad</body></html>",
    }))).toThrow("markup before its policy-bearing head")
  })

  test("allows only the server-declared origins in each directive", () => {
    const csp = buildMcpAppCsp(fixture({
      csp: {
        connectDomains: ["https://api.example.com"],
        resourceDomains: ["https://static.example.com"],
        frameDomains: ["https://embed.example.com"],
        baseUriDomains: [],
      },
    }))
    expect(csp).toContain("connect-src https://api.example.com")
    expect(csp).toContain("script-src 'unsafe-inline' https://static.example.com")
    expect(csp).toContain("frame-src https://embed.example.com")
  })
})


test("only canonical completed gateway search results render connector setup suggestions", () => {
  const catalog = { version: 1, selectedIds: ["slack"], entries: [{ id: "slack", name: "Slack", description: "Work chat", setup: "oauth_client", setupUrl: "https://example.com/dashboard/mcp-connections?quickAdd=slack" }] };
  const part = { type: "dynamic-tool", toolName: "openwork-cloud_search_capabilities", toolCallId: "catalog", state: "output-available", input: { query: "Slack", intent: "connect" }, output: JSON.stringify({ connectorCatalog: catalog }) } satisfies import("ai").DynamicToolUIPart;
  expect(connectorCatalogFromPart(part)).toEqual(catalog);
  expect(hasPreservedMcpAppResult(part)).toBe(true);
  expect(hasPreservedMcpAppResult({ ...part, input: { query: "Slack" } })).toBe(false);
  expect(connectorCatalogFromPart({ ...part, toolName: "other_search_capabilities" })).toBeNull();
  expect(connectorCatalogFromPart({ ...part, output: "invalid json" })).toBeNull();
  expect(connectorCatalogFromPart({ ...part, output: { connectorCatalog: { ...catalog, version: 2 } } })).toBeNull();
});
