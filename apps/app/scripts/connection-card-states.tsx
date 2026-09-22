/**
 * Renders every ConnectionCard state to a static HTML page using the built app
 * CSS, for DESIGN.md P10 screenshot evidence. Not part of the app bundle.
 *
 *   pnpm exec vite build && bun scripts/connection-card-states.tsx > /tmp/connection-card-states.html
 */
import { readdirSync, readFileSync } from "node:fs"
import { GlobalRegistrator } from "@happy-dom/global-registrator"
import { act } from "react"
import { createRoot } from "react-dom/client"
import type { DynamicToolUIPart } from "ai"
import { ConnectionCard } from "../src/components/chat/connection-card"
import { chatMcpReconnectKey, useChatMcpReconnectStore, type ChatMcpReconnectPhase } from "../src/components/tools/mcp-reconnect-state"

const connectionId = "emc_stripe"
const payload = {
  schemaVersion: "1", connectionId, connectionName: "Stripe", state: "needs_connection", actor: "member",
  message: "You haven't connected your Stripe account yet.",
  action: { type: "connect", surface: "openwork_your_connections", label: "Connect Stripe" },
}
const part: DynamicToolUIPart = {
  type: "dynamic-tool", toolName: "openwork-cloud_execute_capability", toolCallId: "call-stripe",
  state: "output-available", input: {}, output: payload,
}
const owner = "owner"
const request = { requestId: "que_1", owner, sessionId: "ses_1", turnId: "msg_user", toolCallId: part.toolCallId, connectionId }
const decision = { request, isPending: () => true, respond: async () => {} }
const identities = [{ connectionId, name: "Stripe", iconUrl: "/ext-stripe.svg", toolPrefix: "" }]

GlobalRegistrator.register({ url: "http://localhost/" })
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true)

// Zustand serves its initial snapshot to static SSR, so phases need a client render.
async function render(phase: ChatMcpReconnectPhase | null, extra?: { error?: string; authorizeUrl?: string; output?: unknown; decision?: boolean; readOnly?: boolean }) {
  useChatMcpReconnectStore.getState().reset()
  if (phase) {
    useChatMcpReconnectStore.getState().setRecord(chatMcpReconnectKey(part.toolCallId, connectionId, owner), {
      phase, error: extra?.error ?? null, authorizeUrl: extra?.authorizeUrl ?? null,
    })
  }
  const target = extra?.output ? { ...part, output: extra.output } : part
  const container = document.createElement("div")
  const root = createRoot(container)
  await act(async () => root.render(
    <ConnectionCard part={target} reconnectScope={owner} connectorIdentities={identities}
      reconnectCallbacks={{ decision: extra?.decision === false ? null : decision, blocked: extra?.readOnly, onReconnect: async () => "connected", onReopenAuthorization: async () => {} }} />,
  ))
  const html = container.innerHTML
  await act(async () => root.unmount())
  return html
}

const states: Array<[string, string]> = [
  ["Ready — pending native question", await render(null)],
  ["Ready — no question (explicit connect flow)", await render(null, { decision: false })],
  ["Signing in", await render("opening")],
  ["Waiting for the browser", await render("authorization_opened", { authorizeUrl: "https://example.com/oauth" })],
  ["Connected", await render("connected")],
  ["Skipped", await render("skipped")],
  ["Sign-in didn't finish (technical details collapsed)", await render("failed", { error: "OAuth callback returned invalid_grant (state mismatch) after 90s" })],
  ["Blocked — organization admin", await render(null, { output: { ...payload, actor: "organization_admin", action: { type: "update_credentials", surface: "openwork_organization_connections", label: "Update credentials" } } })],
  ["Read-only history", await render("connected", { readOnly: true })],
]

const css = readdirSync("dist/assets").filter(file => file.endsWith(".css")).map(file => readFileSync(`dist/assets/${file}`, "utf8")).join("\n")
const body = states.map(([label, html]) => `
  <section class="flex flex-col gap-2">
    <h2 class="text-xs font-medium text-muted-foreground">${label}</h2>
    <div class="rounded-md border border-border bg-background" data-message-role="assistant">${html}</div>
  </section>`).join("\n")

await GlobalRegistrator.unregister()
process.stdout.write(`<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Connection card states</title>
<style>${css}</style><base href="/"></head>
<body class="bg-background text-foreground antialiased"><main class="mx-auto flex max-w-2xl flex-col gap-6 p-8">${body}</main></body></html>`)
