"use client"

import { useState } from "react"
import type { DynamicToolUIPart } from "ai"
import type { ConnectionActionPayload } from "@openwork/types/connection-action-app"
import { ArrowUpRight, Loader2, LockKeyhole } from "lucide-react"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { connectionCardPayloadFromChatToolResult, connectionResultFromChatToolPart, reconnectActionFromChatToolResult, type ChatToolReconnectAction } from "@/components/tools/error-attribution"
import { useChatToolReconnect, type ChatToolReconnectCallbacks } from "@/components/tools/use-chat-tool-reconnect"
import type { ConnectorToolIdentity } from "@/react-app/domains/connections/connector-tool-identity"
import type { ChatConnectionStopState } from "@/react-app/domains/session/surface/mcp-chat-reconnect"
import { useOptionalMessageList } from "./message-list-provider"

const ACTION_OWNER = {
  member: "You",
  organization_admin: "Your organization admin",
  provider_admin: "The provider admin",
  network_admin: "Your network admin",
  openwork: "OpenWork support",
}

export function ConnectionCard({ part, callbacks, reconnectCallbacks, reconnectScope, connectorIdentities, decision }: {
  callbacks?: ChatToolReconnectCallbacks
  part: DynamicToolUIPart
  action: ChatToolReconnectAction | null
  connection: ConnectionActionPayload | null
  reconnectCallbacks?: ChatToolReconnectCallbacks
  reconnectScope?: string
  connectorIdentities?: ConnectorToolIdentity[]
  decision?: {
    stopState: ChatConnectionStopState
    onDismiss: () => void
    onAlternate: () => void
    onContinue: () => void
    onStop: () => void
  }
}) {
  const messageList = useOptionalMessageList()
  const result = connectionResultFromChatToolPart(part)
  const action = reconnectActionFromChatToolResult(part.toolName, result, part.input)
  const connection = connectionCardPayloadFromChatToolResult(part.toolName, result, part.input)
  const { reconnectState, reconnectError, reconnectBlocked, handleReconnect } = useChatToolReconnect(part, reconnectCallbacks ?? {
    onReconnect: callbacks?.onReconnect ?? messageList?.onMcpReconnect,
    onReopenAuthorization: callbacks?.onReopenAuthorization ?? messageList?.onMcpReopenAuthorization,
  }, action, reconnectScope)
  const [failedIcon, setFailedIcon] = useState<string | null>(null)
  const identity = connection ?? action
  if (!identity || (!decision && (messageList?.connectionDecisionToolCallId === part.toolCallId
    || messageList?.connectionDecisionConnectionId === identity.connectionId))) return null
  const icon = (connectorIdentities ?? messageList?.connectorIdentities ?? []).find(entry => entry.connectionId === identity.connectionId)?.iconUrl
  const connected = connection?.state === "connected" || reconnectState === "connected"
  const opening = reconnectState === "opening"
  const waiting = reconnectState === "authorization_opened"
  const status = reconnectBlocked && !decision ? "Stop not confirmed" : connected ? decision ? "Connected. Nothing retried." : "Connected" : opening ? "Opening sign-in…" : waiting ? "Finish sign-in in your browser" : reconnectState === "failed" ? "Sign-in could not finish" : action ? "Sign-in required" : connection?.state === "provider_error" ? "Connection needs attention" : "Connection setup required"
  const label = reconnectState === "failed" ? "Try again" : waiting ? "Open sign-in" : action?.label
  const readOnly = messageList?.readOnly ?? false
  const stopPending = decision?.stopState === "stopping"
  const stopFailed = decision?.stopState === "failed"

  return (
    <section data-testid={decision ? "connection-decision-panel" : "desktop-connection-card"} aria-label={`${identity.connectionName} connection`} aria-live="polite"
      className={cn("max-w-full self-start px-3 py-3 text-sm text-foreground", decision ? "w-full border-b border-border" : "w-96 rounded-xl bg-muted/40")}>
      <div className="flex min-h-10 min-w-0 flex-wrap items-center gap-3">
        <span aria-hidden="true" className={cn("flex size-7 shrink-0 items-center justify-center overflow-hidden rounded-md", !icon && "bg-muted text-xs font-medium")}>
          {icon && icon !== failedIcon ? <img src={icon} alt="" className="size-5 object-contain" onError={() => setFailedIcon(icon)} /> : identity.connectionName.charAt(0).toUpperCase()}
        </span>
        <div className="min-w-0 flex-1">
          <p className="font-medium">{identity.connectionName}: {status}</p>
          {!action && !connected && connection?.action ? (
            <p className="text-muted-foreground">
              {connection.actor ? `${ACTION_OWNER[connection.actor]}: ` : ""}{connection.action.label}
            </p>
          ) : null}
        </div>
        {!connected && action ? (
          <Button variant={decision ? "default" : "ghost"} size="sm" disabled={readOnly || reconnectBlocked || opening || stopPending || stopFailed} onClick={() => void handleReconnect()} aria-label={`${label} ${identity.connectionName}`}>
            {opening ? <><Loader2 data-icon="inline-start" className="animate-spin" />Opening</> : <>{label}<ArrowUpRight data-icon="inline-end" /></>}
          </Button>
        ) : null}
      </div>
      {decision ? (
        <div className="flex flex-wrap items-center gap-2 pt-2">
          <p role="status" className="flex min-w-0 flex-1 items-center gap-2 text-xs text-muted-foreground">
            <LockKeyhole aria-hidden="true" className="size-4 shrink-0" strokeWidth={1.5} />
            {stopPending ? "Stopping this turn…" : stopFailed ? "Stop not confirmed. Retry Stop before continuing." : "Turn stopped. Nothing retried."}
          </p>
          {stopFailed ? <Button variant="outline" size="sm" onClick={decision.onStop}>Retry Stop</Button> : null}
          {connected && !stopPending && !stopFailed ? <Button size="sm" disabled={reconnectBlocked} onClick={decision.onContinue}>Draft retry</Button> : null}
          <Button variant="ghost" size="sm" onClick={decision.onAlternate}>Change instruction</Button>
          <Button variant="ghost" size="sm" disabled={stopPending || stopFailed} onClick={decision.onDismiss}>Dismiss</Button>
        </div>
      ) : null}
      {reconnectError ? <p role="alert" className="pt-2 text-xs text-destructive">{reconnectError}</p> : null}
    </section>
  )
}
