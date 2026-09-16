import type { DynamicToolUIPart, UIMessage } from "ai"
import type { ConnectionActionPayload } from "@openwork/types/connection-action-app"
import type { DenExternalMcpConnection } from "@/app/lib/den"
import {
  connectionCardPayloadFromChatToolResult,
  connectionResultFromChatToolPart,
  reconnectActionFromChatToolResult,
  type ChatToolReconnectAction,
} from "@/components/tools/error-attribution"

import { getComposerQueuedDrafts, useComposerStateStore } from "./composer-state-store"
import { dispatchQueuedDrain } from "./queued-drain-machine"

export function prepareChatStopQueue(sessionId: string, intent: "manual" | "connection", isCurrent: () => boolean): boolean {
  if (!isCurrent()) return false
  if (intent === "connection") {
    dispatchQueuedDrain(sessionId, { type: "queue_held" })
  } else {
    const state = useComposerStateStore.getState()
    for (const item of getComposerQueuedDrafts(state, sessionId)) {
      for (const attachment of item.draft.attachments) {
        if (attachment.previewUrl) URL.revokeObjectURL(attachment.previewUrl)
      }
    }
    state.clearQueuedDrafts(sessionId)
    dispatchQueuedDrain(sessionId, { type: "queue_cleared" })
  }
  return true
}

export type ChatConnectionDecision = {
  owner: string
  turnId: string
  generation: number
  part: DynamicToolUIPart
  connection: ConnectionActionPayload
  action: ChatToolReconnectAction | null
}

export type ChatConnectionStopState = "stopping" | "stopped" | "failed"

export function createChatConnectionDecisionTracker() {
  let generation = 0
  let submission: {
    owner: string
    generation: number
    clientTurnId: string
    turnId: string | null
    dispatched: boolean
    native: boolean
    previousIds: Set<string>
    preparedText: string | null
    claimed: boolean
  } | null = null
  let latest: ChatConnectionDecision | null = null
  const current = (owner: string, expected: number) => submission?.owner === owner && submission.generation === expected
  const reconcile = (owner: string, messages: readonly UIMessage[], replacements: ReadonlyMap<string, string>) => {
    if (!submission || submission.owner !== owner || !submission.dispatched) return
    if (submission.turnId) return
    const exact = messages.find(message => message.role === "user"
      && (message.id === submission?.clientTurnId || replacements.get(message.id) === submission?.clientTurnId))
    if (exact) {
      submission.turnId = exact.id
      return
    }
    if (!submission.native || !submission.preparedText) return
    const newUsers = messages.filter(message => message.role === "user" && !submission?.previousIds.has(message.id))
    if (newUsers.length !== 1) return
    const user = newUsers[0]
    const text = user.parts.flatMap(part => part.type === "text" ? [part.text] : []).join("")
    if (text === submission.preparedText) submission.turnId = user.id
  }
  return {
    reset() {
      generation += 1
      submission = null
      latest = null
    },
    begin(owner: string, clientTurnId: string) {
      generation += 1
      submission = { owner, generation, clientTurnId, turnId: null, dispatched: false, native: false,
        previousIds: new Set(), preparedText: null, claimed: false }
      latest = null
      return generation
    },
    isCurrent: current,
    dispatch(owner: string, expected: number, previousIds: readonly string[], native: boolean) {
      if (!submission || !current(owner, expected)) return false
      submission.previousIds = new Set(previousIds)
      submission.native = native
      submission.dispatched = true
      return true
    },
    prepared(owner: string, expected: number, text: string | undefined) {
      if (submission && current(owner, expected) && text !== undefined) submission.preparedText = text
    },
    reconcile,
    observe(owner: string, messages: readonly UIMessage[], replacements: ReadonlyMap<string, string>): ChatConnectionDecision | null {
      reconcile(owner, messages, replacements)
      if (!submission || submission.owner !== owner || !submission.dispatched || !submission.turnId) return null
      const turnIndex = messages.findLastIndex(message => message.role === "user")
      if (messages[turnIndex]?.id !== submission.turnId) {
        latest = null
        return null
      }
      const statuses = new Map<string, ChatConnectionDecision>()
      for (const message of messages.slice(turnIndex + 1)) {
        if (message.role !== "assistant") continue
        for (const part of message.parts) {
          if (part.type !== "dynamic-tool" || (part.state !== "output-available" && part.state !== "output-error")) continue
          const result = connectionResultFromChatToolPart(part)
          const connection = connectionCardPayloadFromChatToolResult(part.toolName, result, part.input)
          if (!connection) continue
          statuses.set(connection.connectionId, { owner, generation: submission.generation, turnId: submission.turnId, part, connection,
            action: reconnectActionFromChatToolResult(part.toolName, result, part.input) })
        }
      }
      latest = statuses.size === 1 ? statuses.values().next().value ?? null : null
      return latest
    },
    canStop(decision: ChatConnectionDecision) {
      return current(decision.owner, decision.generation) && latest?.turnId === decision.turnId
        && latest.part.toolCallId === decision.part.toolCallId && latest.connection.state !== "connected"
        && Boolean(latest.connection.actor && latest.connection.action)
    },
    releaseClaim(decision: ChatConnectionDecision) {
      if (submission && current(decision.owner, decision.generation)) submission.claimed = false
    },
    claim(decision: ChatConnectionDecision) {
      if (!submission || submission.claimed || !current(decision.owner, decision.generation)
        || latest?.part.toolCallId !== decision.part.toolCallId || latest.connection.state === "connected"
        || !latest.connection.actor || !latest.connection.action) return false
      submission.claimed = true
      return true
    },
  }
}

export function createChatConnectionStopCoordinator() {
  const pending = new Map<string, Promise<boolean | undefined>>()
  const unconfirmed = new Set<string>()
  const listeners = new Set<() => void>()
  const notify = () => { for (const listener of listeners) listener() }
  return {
    subscribe(listener: () => void) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    phase(owner: string): "idle" | "stopping" | "failed" {
      return pending.has(owner) ? "stopping" : unconfirmed.has(owner) ? "failed" : "idle"
    },
    isPending(owner: string) {
      return pending.has(owner)
    },
    isBlocked(owner: string) {
      return pending.has(owner) || unconfirmed.has(owner)
    },
    needsConfirmation(owner: string) {
      return unconfirmed.has(owner)
    },
    run(owner: string, stop: () => Promise<boolean | undefined>) {
      const existing = pending.get(owner)
      if (existing) return existing
      let resolve: (result: boolean | undefined) => void = () => {}
      let reject: (error: unknown) => void = () => {}
      const promise = new Promise<boolean | undefined>((onResolve, onReject) => {
        resolve = onResolve
        reject = onReject
      })
      pending.set(owner, promise)
      notify()
      const finish = () => {
        if (pending.get(owner) === promise) pending.delete(owner)
        notify()
      }
      const execute = async () => {
        try {
          const result = await stop()
          if (result === true) unconfirmed.delete(owner)
          else if (result === false) unconfirmed.add(owner)
          finish()
          resolve(result)
        } catch (error) {
          unconfirmed.add(owner)
          finish()
          reject(error)
        }
      }
      void execute()
      return promise
    },
  }
}

export const chatConnectionStops = createChatConnectionStopCoordinator()

export function chatConnectionRetryPrompt(connectionName: string): string {
  return `Check whether the ${connectionName} connection is ready, then review the interrupted request. Verify whether any earlier operation completed before proposing a retry. Ask me before repeating a send, post, purchase, delete, or other consequential action.`
}

export const CHAT_MCP_RECONNECT_POLL_INTERVAL_MS = 2_000
export const CHAT_MCP_RECONNECT_TIMEOUT_MS = 90_000

export type ChatMcpReconnectScope = {
  baseUrl: string
  token: string
  organizationId: string
}

export function isChatMcpReconnectScopeCurrent(
  expected: ChatMcpReconnectScope,
  current: ChatMcpReconnectScope,
): boolean {
  return expected.baseUrl === current.baseUrl
    && expected.token === current.token
    && expected.organizationId === current.organizationId
}

export function hasFreshMcpAuthorization(
  connection: Pick<DenExternalMcpConnection, "connectedForMe" | "connectedAt"> | null | undefined,
  previousConnectedAt: string | null,
): boolean {
  return connection?.connectedForMe === true
    && typeof connection.connectedAt === "string"
    && connection.connectedAt.length > 0
    && connection.connectedAt !== previousConnectedAt
}

export async function waitForFreshMcpAuthorization(input: {
  connectionId: string
  connectionName: string
  previousConnectedAt: string | null
  listConnections: () => Promise<DenExternalMcpConnection[]>
  isScopeCurrent: () => boolean
  timeoutMs?: number
  intervalMs?: number
  now?: () => number
  sleep?: (milliseconds: number) => Promise<void>
}): Promise<DenExternalMcpConnection> {
  const timeoutMs = input.timeoutMs ?? CHAT_MCP_RECONNECT_TIMEOUT_MS
  const intervalMs = input.intervalMs ?? CHAT_MCP_RECONNECT_POLL_INTERVAL_MS
  const now = input.now ?? Date.now
  const sleep = input.sleep ?? ((milliseconds) => new Promise((resolve) => window.setTimeout(resolve, milliseconds)))
  const startedAt = now()

  while (now() - startedAt < timeoutMs) {
    if (!input.isScopeCurrent()) {
      throw new Error("The active OpenWork Cloud account changed while reconnecting. Try again in this workspace.")
    }
    try {
      const connections = await input.listConnections()
      if (!input.isScopeCurrent()) {
        throw new Error("The active OpenWork Cloud account changed while reconnecting. Try again in this workspace.")
      }
      const connection = connections.find((entry) => entry.id === input.connectionId)
      if (connection && hasFreshMcpAuthorization(connection, input.previousConnectedAt)) return connection
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("The active OpenWork Cloud account changed")) throw error
      // A transient list failure should not turn a successful browser callback
      // into a false failure. Keep polling until the bounded timeout.
    }
    await sleep(intervalMs)
  }

  throw new Error(`Authorization for ${input.connectionName} did not finish. Complete it in the browser, then try reconnecting again.`)
}
