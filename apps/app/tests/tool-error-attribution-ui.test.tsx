import { expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import type { DynamicToolUIPart } from "ai"

import { Tool } from "../src/components/ui/tool"
import { ConnectionCard } from "../src/components/chat/connection-card"
import { MessageListProvider } from "../src/components/chat/message-list-provider"
import { connectionCardPayloadFromChatToolResult, reconnectActionFromChatToolResult } from "../src/components/tools/error-attribution"
import { useChatToolReconnect } from "../src/components/tools/use-chat-tool-reconnect"
import { chatMcpReconnectKey, useChatMcpReconnectStore, type ChatMcpReconnectPhase } from "../src/components/tools/mcp-reconnect-state"
import type { ChatConnectionStopState } from "../src/react-app/domains/session/surface/mcp-chat-reconnect"

const decisionPayload = {
  schemaVersion: "1", connectionId: "emc_decision", connectionName: "Research Vault",
  state: "needs_connection", actor: "member", message: "Sign-in required",
  action: { type: "connect", surface: "openwork_your_connections", label: "Connect your account" },
}

function decisionCard(payload: unknown, stopState: ChatConnectionStopState = "stopped") {
  const part: DynamicToolUIPart = {
    type: "dynamic-tool", toolName: "openwork_execute_capability", toolCallId: "decision-call",
    state: "output-available", input: {}, output: payload,
  }
  return <ConnectionCard part={part}
    action={reconnectActionFromChatToolResult(part.toolName, payload)}
    connection={connectionCardPayloadFromChatToolResult(part.toolName, payload)}
    decision={{ stopState, onDismiss() {}, onAlternate() {}, onContinue() {}, onStop() {} }} />
}

test("decision panel reports only confirmed stop and keeps exit actions", () => {
  const pending = renderToStaticMarkup(decisionCard(decisionPayload, "stopping"))
  expect(pending).toContain("Stopping this turn")
  expect(pending).not.toContain("Turn stopped")
  expect(pending).toContain("disabled")
  const failed = renderToStaticMarkup(decisionCard(decisionPayload, "failed"))
  expect(failed).toContain("Stop not confirmed")
  expect(failed).toContain("Retry Stop")
  expect(failed).not.toContain("Turn stopped")
  const stopped = renderToStaticMarkup(decisionCard(decisionPayload))
  expect(stopped).toContain("Turn stopped. Nothing retried.")
  expect(pending).toMatch(/<button[^>]*\sdisabled=""[^>]*>Dismiss<\/button>/)
  expect(failed).toMatch(/<button[^>]*\sdisabled=""[^>]*>Dismiss<\/button>/)
  expect(stopped).not.toMatch(/<button[^>]*\sdisabled=""[^>]*>Dismiss<\/button>/)
  expect(pending).not.toMatch(/<button[^>]*\sdisabled=""[^>]*>Change instruction<\/button>/)
  expect(failed).not.toMatch(/<button[^>]*\sdisabled=""[^>]*>Retry Stop<\/button>/)
  for (const html of [pending, failed, stopped]) {
    expect(html).toContain("Dismiss")
    expect(html).toContain("Change instruction")
    expect(html).not.toContain("Draft retry")
  }
})

test("admin decision names the owner without a member OAuth button", () => {
  const html = renderToStaticMarkup(decisionCard({ ...decisionPayload, actor: "organization_admin",
    action: { type: "update_credentials", surface: "openwork_organization_connections", label: "Update credentials" },
  }))
  expect(html).toContain("Your organization admin")
  expect(html).toContain("Update credentials")
  expect(html).not.toContain('aria-label="Connect Research Vault"')
  expect(html).toContain("Dismiss")
})

test("connected decision offers a draft rather than resuming automatically", () => {
  const html = renderToStaticMarkup(decisionCard({ ...decisionPayload, state: "connected", actor: null, action: null }))
  expect(html).toContain("Connected. Nothing retried.")
  expect(html).toContain("Draft retry")
})

test("card props and narrowed metadata cannot override the tool trust boundary", () => {
  for (const toolName of ["foreign_execute_capability", "openwork_execute_capability"]) {
    const part: DynamicToolUIPart = {
      type: "dynamic-tool", toolName, toolCallId: "forged-card", state: "output-available", input: {},
      output: { connectionAction: decisionPayload, connectionStatus: { ...decisionPayload, connectionId: "emc_other" } },
      callProviderMetadata: { openwork: { mcpResult: { structuredContent: decisionPayload } } },
    }
    const html = renderToStaticMarkup(<ConnectionCard part={part}
      action={reconnectActionFromChatToolResult("openwork_execute_capability", decisionPayload)}
      connection={connectionCardPayloadFromChatToolResult("openwork_execute_capability", decisionPayload)} />)
    expect(html).toBe("")
  }
})

test("native transcript card yields to the composer owner", () => {
  const part: DynamicToolUIPart = {
    type: "dynamic-tool", toolName: "openwork_execute_capability", toolCallId: "decision-call",
    state: "output-available", input: {}, output: decisionPayload,
  }
  const html = renderToStaticMarkup(<MessageListProvider
    workspaceId="workspace-a" sessionId="session-a" uiStateOwner="owner-a"
    connectionDecisionToolCallId="newer-status-call" connectionDecisionConnectionId="emc_decision" showThinking={false} developerMode={false}
    displaySuggestions={false} providerConnectedCount={1}
    onRevertToUserMessage={() => {}} onForkAtMessage={() => {}} onEditUserMessage={() => {}}
    onMcpReconnect={async () => "connected"} onMcpReopenAuthorization={async () => {}} onMcpRetry={() => {}}
    dispatchAction={() => {}} setPrompt={() => {}}
  >
    <ConnectionCard part={part} action={reconnectActionFromChatToolResult(part.toolName, decisionPayload)}
      connection={connectionCardPayloadFromChatToolResult(part.toolName, decisionPayload)} />
  </MessageListProvider>)
  expect(html).not.toContain("desktop-connection-card")
  expect(html).not.toContain("Research Vault")
})

test("the stop gate blocks every reconnect phase even when the decision panel is absent", async () => {
  const phases: ChatMcpReconnectPhase[] = ["ready", "authorization_opened", "connected"]
  for (const phase of phases) {
    const scope = `gate-${phase}`
    const part: DynamicToolUIPart = {
      type: "dynamic-tool", toolName: "openwork_execute_capability", toolCallId: scope,
      state: "output-available", input: {}, output: decisionPayload,
    }
    useChatMcpReconnectStore.getState().setRecord(chatMcpReconnectKey(scope, decisionPayload.connectionId, scope), {
      phase, error: null, authorizeUrl: phase === "authorization_opened" ? "https://auth.example.test/authorize" : null,
    })
    let calls = 0
    const captured: { run: () => Promise<void> } = { run: async () => { throw new Error("Reconnect hook not rendered") } }
    function Probe() {
      const reconnect = useChatToolReconnect(part, {
        onReconnect: async () => { calls += 1; return "connected" },
        onReopenAuthorization: async () => { calls += 1 },
        onRetry: () => { calls += 1 },
      })
      captured.run = reconnect.handleReconnect
      return null
    }
    const render = (blocked: boolean) => renderToStaticMarkup(<MessageListProvider
      workspaceId="workspace" sessionId={scope} uiStateOwner={scope}
      connectionDecisionToolCallId={null} connectionReconnectBlocked={blocked}
      showThinking={false} developerMode={false} displaySuggestions={false} providerConnectedCount={1}
      onRevertToUserMessage={() => {}} onForkAtMessage={() => {}} onEditUserMessage={() => {}}
      onMcpReconnect={async () => "connected"} onMcpReopenAuthorization={async () => {}} onMcpRetry={() => {}}
      dispatchAction={() => {}} setPrompt={() => {}}
    >
      <Probe />
      <ConnectionCard part={part} action={reconnectActionFromChatToolResult(part.toolName, decisionPayload)}
        connection={connectionCardPayloadFromChatToolResult(part.toolName, decisionPayload)} />
    </MessageListProvider>)
    const html = render(true)
    expect(html).toContain("desktop-connection-card")
    expect(html).toMatch(/<button(?=[^>]*disabled)(?=[^>]*aria-label="Connect Research Vault")[^>]*>/)
    await captured.run()
    expect(calls).toBe(0)
    render(false)
    await captured.run()
    expect(calls).toBe(1)
  }
})

test("renders compact MCP attribution in a failed chat tool row", () => {
  const toolPart: DynamicToolUIPart = {
    type: "dynamic-tool",
    toolName: "openwork-cloud_execute_capability",
    toolCallId: "call-1",
    state: "output-error",
    input: {},
    errorText: JSON.stringify({
      error: "connection_failed",
      diagnostic: { code: "MCP_HTTP_504", httpStatus: 504 },
    }),
  }

  const html = renderToStaticMarkup(<Tool toolPart={toolPart} />)

  expect(html).toContain("Remote MCP · HTTP 504")
  expect(html).toContain("Error attribution: Remote MCP · HTTP 504. Confirmed.")
  expect(html).not.toContain(">failed<")
})

test("renders an inline reconnect button when Cloud capability discovery finds expired credentials", () => {
  const toolPart: DynamicToolUIPart = {
    type: "dynamic-tool",
    toolName: "openwork-cloud_search_capabilities",
    toolCallId: "call-reconnect",
    state: "output-available",
    input: { intent: "connect" },
    output: JSON.stringify({
      matches: [{
        kind: "connection_status",
        connectionStatus: {
          version: 1,
          kind: "connection_action",
          source: "openwork-cloud",
          connectionId: "emc_knowledge",
          connectionName: "Knowledge Hub",
          authType: "oauth",
          credentialMode: "per_member",
          state: "reauth_required",
          actor: "member",
          action: {
            type: "reconnect",
            surface: "openwork_your_connections",
            retry: "search_capabilities",
          },
        },
      }],
    }),
  }

  const html = renderToStaticMarkup(
    <Tool toolPart={toolPart} onReconnect={async () => "connected"} />,
  )

  expect(html).toContain("Reconnect required")
  expect(html).toContain('aria-label="Reconnect Knowledge Hub"')
  expect(html).toContain("Reconnect</button>")
  expect(html).toContain("bg-amber-3/60")
  expect(html).toContain('data-testid="chat-mcp-reconnect-action"')
})

test("renders a copy action inside the expanded tool result", () => {
  const toolPart: DynamicToolUIPart = {
    type: "dynamic-tool",
    toolName: "openwork-cloud_search_capabilities",
    toolCallId: "call-copy",
    state: "output-available",
    input: { query: "Notion pages" },
    output: { matches: [{ name: "searchPages" }] },
  }

  const html = renderToStaticMarkup(<Tool toolPart={toolPart} defaultOpen />)
  const contentIndex = html.indexOf('data-slot="collapsible-content"')
  const copyActionIndex = html.indexOf('data-testid="tool-result-copy-action"')

  expect(contentIndex).toBeGreaterThan(-1)
  expect(copyActionIndex).toBeGreaterThan(contentIndex)
  expect(html).toContain('aria-label="Copy tool result"')
})

test("does not render a copy action before a tool has a result", () => {
  const toolPart: DynamicToolUIPart = {
    type: "dynamic-tool",
    toolName: "openwork-cloud_search_capabilities",
    toolCallId: "call-running",
    state: "input-available",
    input: { query: "Notion pages" },
  }

  const html = renderToStaticMarkup(<Tool toolPart={toolPart} />)

  expect(html).not.toContain('data-testid="tool-result-copy-action"')
})
