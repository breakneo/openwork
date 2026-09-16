"use client"

import { useId } from "react"
import { useOptionalMessageList } from "@/components/chat/message-list-provider"
import type { DynamicToolUIPart, ToolUIPart } from "ai"

import {
  connectionResultFromChatToolPart,
  reconnectActionFromChatToolResult,
  type ChatToolReconnectAction,
  type ChatToolReconnectProgress,
  type ChatToolReconnectResult,
} from "@/components/tools/error-attribution"
import {
  chatMcpReconnectKey,
  chatMcpReconnectPresentation,
  useChatMcpReconnectStore,
} from "@/components/tools/mcp-reconnect-state"

export type ChatToolReconnectCallbacks = {
  blocked?: boolean
  onReconnect?: (
    action: ChatToolReconnectAction,
    onProgress: (progress: ChatToolReconnectProgress) => void,
  ) => Promise<ChatToolReconnectResult>
  onReopenAuthorization?: (action: ChatToolReconnectAction, authorizeUrl: string) => Promise<void>
  onRetry?: (action: ChatToolReconnectAction) => void | Promise<void>
}

/**
 * Reconnect/Retry state for a chat tool call, shared between the generic
 * Tool card and the sentence-style failure line. Only OpenWork Cloud
 * capability tools can produce a reconnect action (see error-attribution).
 */
export function useChatToolReconnect(
  toolPart: ToolUIPart | DynamicToolUIPart,
  { onReconnect, onReopenAuthorization, onRetry, blocked = false }: ChatToolReconnectCallbacks,
  actionOverride?: ChatToolReconnectAction | null,
  scopeOverride?: string,
) {
  const messageList = useOptionalMessageList()
  const instanceId = useId()
  const scope = scopeOverride ?? messageList?.uiStateOwner ?? (messageList ? JSON.stringify([messageList.workspaceId, messageList.sessionId]) : instanceId)
  const reconnectBlocked = blocked || messageList?.connectionReconnectBlocked === true
  const candidateAction = actionOverride !== undefined ? actionOverride : toolPart.type === "dynamic-tool"
    ? reconnectActionFromChatToolResult(toolPart.toolName, connectionResultFromChatToolPart(toolPart), toolPart.input)
    : null
  const reconnectAction = reconnectBlocked || messageList?.connectionDecisionToolCallId === toolPart.toolCallId
    || (candidateAction && messageList?.connectionDecisionConnectionId === candidateAction.connectionId) ? null : candidateAction
  const reconnectKey = reconnectAction
    ? chatMcpReconnectKey(toolPart.toolCallId, reconnectAction.connectionId, scope)
    : null
  const reconnectState = useChatMcpReconnectStore((store) => (
    reconnectKey ? store.records[reconnectKey]?.phase ?? "ready" : "ready"
  ))
  const reconnectError = useChatMcpReconnectStore((store) => (
    reconnectKey ? store.records[reconnectKey]?.error ?? null : null
  ))
  const setReconnectRecord = useChatMcpReconnectStore((store) => store.setRecord)
  const reconnectPresentation = reconnectAction
    ? chatMcpReconnectPresentation(reconnectAction, reconnectState)
    : null

  const handleReconnect = async () => {
    if (!reconnectAction || !reconnectKey || !onReconnect || reconnectBlocked || messageList?.readOnly) return
    const currentRecord = useChatMcpReconnectStore.getState().records[reconnectKey]
    const currentPhase = currentRecord?.phase ?? "ready"
    if (currentPhase === "connected") {
      await onRetry?.(reconnectAction)
      return
    }
    if (currentPhase === "authorization_opened") {
      if (!onReopenAuthorization) return
      const reconnectAuthorizeUrl = currentRecord?.authorizeUrl
      if (!reconnectAuthorizeUrl) {
        setReconnectRecord(reconnectKey, {
          phase: "failed",
          error: `${reconnectAction.connectionName} sign-in is no longer pending. Try reconnecting again.`,
          authorizeUrl: null,
        })
        return
      }
      try {
        await onReopenAuthorization(reconnectAction, reconnectAuthorizeUrl)
        setReconnectRecord(reconnectKey, {
          phase: "authorization_opened",
          error: null,
          authorizeUrl: reconnectAuthorizeUrl,
        })
      } catch (error) {
        setReconnectRecord(reconnectKey, {
          phase: "failed",
          error: error instanceof Error ? error.message : "Could not reopen sign-in.",
          authorizeUrl: null,
        })
      }
      return
    }
    if (currentPhase === "opening") return
    setReconnectRecord(reconnectKey, { phase: "opening", error: null, authorizeUrl: null })
    try {
      const result = await onReconnect(reconnectAction, (progress) => {
        setReconnectRecord(reconnectKey, {
          phase: progress.phase,
          error: null,
          authorizeUrl: progress.phase === "authorization_opened" ? progress.authorizeUrl : null,
        })
      })
      setReconnectRecord(reconnectKey, { phase: result, error: null, authorizeUrl: null })
    } catch (error) {
      setReconnectRecord(reconnectKey, {
        phase: "failed",
        error: error instanceof Error ? error.message : "Could not reconnect this account.",
        authorizeUrl: null,
      })
    }
  }

  return { reconnectAction, reconnectState, reconnectError, reconnectPresentation, reconnectBlocked, handleReconnect }
}
