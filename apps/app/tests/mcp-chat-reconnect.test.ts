import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import type { UIMessage } from "ai"
import type { ComposerDraft } from "../src/app/types"
import { getComposerQueuedDrafts, revokeUnownedAttachmentPreviews, useComposerStateStore } from "../src/react-app/domains/session/surface/composer-state-store"
import { assertQueuedSendCurrent, canAdmitNextQueuedItem, claimQueuedSend, dispatchQueuedDrain, getQueuedDrainState, getQueuedSendGeneration, resetQueuedDrainForTests, subscribeQueuedDrain } from "../src/react-app/domains/session/surface/queued-drain-machine"

import {
  chatConnectionRetryPrompt,
  createChatConnectionDecisionTracker,
  createChatConnectionStopCoordinator,
  hasFreshMcpAuthorization,
  isChatMcpReconnectScopeCurrent,
  prepareChatStopQueue,
  waitForFreshMcpAuthorization,
} from "../src/react-app/domains/session/surface/mcp-chat-reconnect"

const baseConnection = {
  id: "emc_research",
  name: "Research Vault",
  url: "https://mcp.test/endpoint",
  authType: "oauth" as const,
  credentialMode: "per_member" as const,
  connected: true,
  connectedAt: "2026-07-16T20:00:00.000Z",
  connectedForMe: true,
}

function blockerMessages(turnId = "user-current", toolName = "openwork_execute_capability", input: unknown = {}): UIMessage[] {
  return [
    { id: turnId, role: "user", parts: [{ type: "text", text: "Read my next meeting" }] },
    { id: `${turnId}-assistant`, role: "assistant", parts: [{
      type: "dynamic-tool", toolName, toolCallId: `${turnId}-call`, state: "output-available", input,
      output: { connectionStatus: {
        version: 1, kind: "connection_action", source: "openwork-cloud",
        connectionId: "emc_research", connectionName: "Research Vault",
        authType: "oauth", credentialMode: "per_member", state: "reauth_required", actor: "member",
        action: { type: "reconnect", surface: "openwork_your_connections", retry: "search_capabilities" },
      } },
    }] },
  ]
}

const noReplacements = new Map<string, string>()

function armTracker(tracker: ReturnType<typeof createChatConnectionDecisionTracker>, owner: string, turnId: string) {
  const generation = tracker.begin(owner, turnId)
  tracker.dispatch(owner, generation, [], false)
  return generation
}

describe("current-turn connection decisions", () => {
  test("history, delayed hydration, reset, and remount cannot arm an interruption", () => {
    const tracker = createChatConnectionDecisionTracker()
    expect(tracker.observe("owner-a", [], noReplacements)).toBeNull()
    expect(tracker.observe("owner-a", blockerMessages(), noReplacements)).toBeNull()
    armTracker(tracker, "owner-a", "user-current")
    tracker.reset()
    expect(tracker.observe("owner-a", blockerMessages(), noReplacements)).toBeNull()
    expect(createChatConnectionDecisionTracker().observe("owner-a", blockerMessages(), noReplacements)).toBeNull()
  })

  test("claims one new result once for the exact submitted turn and session owner", () => {
    const tracker = createChatConnectionDecisionTracker()
    armTracker(tracker, "owner-a", "user-current")
    expect(tracker.observe("owner-b", blockerMessages(), noReplacements)).toBeNull()
    expect(tracker.observe("owner-a", blockerMessages("old-turn"), noReplacements)).toBeNull()
    const decision = tracker.observe("owner-a", blockerMessages(), noReplacements)
    expect(decision?.action?.label).toBe("Reconnect")
    expect(decision?.owner).toBe("owner-a")
    if (!decision) throw new Error("Expected a connection decision")
    expect(tracker.claim(decision)).toBe(true)
    expect(tracker.claim(decision)).toBe(false)
    expect(tracker.observe("owner-a", blockerMessages(), noReplacements)).toEqual(decision)
    armTracker(tracker, "owner-a", "next-turn")
    expect(tracker.observe("owner-a", blockerMessages(), noReplacements)).toBeNull()
    expect(tracker.observe("owner-a", blockerMessages("next-turn"), noReplacements)?.turnId).toBe("next-turn")
  })

  test("uses acknowledged native message identity rather than guessing a turn", () => {
    const tracker = createChatConnectionDecisionTracker()
    armTracker(tracker, "owner-a", "user-current")
    expect(tracker.observe("owner-a", blockerMessages("native-id"), noReplacements)).toBeNull()
    expect(tracker.observe("owner-a", blockerMessages("native-id").slice(0, 1), new Map([["native-id", "user-current"]]))).toBeNull()
    expect(tracker.observe("owner-a", blockerMessages("native-id"), noReplacements)?.turnId).toBe("native-id")
  })

  test("ignores incidental discovery, arbitrary tools, user content, and unfinished calls", () => {
    const tracker = createChatConnectionDecisionTracker()
    armTracker(tracker, "owner-a", "user-current")
    expect(tracker.observe("owner-a", blockerMessages("user-current", "openwork_search_capabilities"), noReplacements)).toBeNull()
    expect(tracker.observe("owner-a", blockerMessages("user-current", "foreign_execute_capability"), noReplacements)).toBeNull()
    const userContent: UIMessage[] = blockerMessages().map(message => ({ ...message, role: "user" }))
    expect(tracker.observe("owner-a", userContent, noReplacements)).toBeNull()
    const unfinished: UIMessage[] = [blockerMessages()[0], { id: "running", role: "assistant", parts: [{
      type: "dynamic-tool", toolName: "openwork_execute_capability", toolCallId: "call-running", state: "input-available", input: {},
    }] }]
    expect(tracker.observe("owner-a", unfinished, noReplacements)).toBeNull()
    expect(tracker.observe("owner-a", blockerMessages("user-current", "openwork_search_capabilities", { intent: "connect" }), noReplacements)?.action?.label).toBe("Reconnect")
  })

  test("a newer user instruction prevents stopping for an older blocker", () => {
    const tracker = createChatConnectionDecisionTracker()
    armTracker(tracker, "owner-a", "user-current")
    const messages: UIMessage[] = [...blockerMessages(), { id: "alternate", role: "user", parts: [{ type: "text", text: "Use the local file instead" }] }]
    expect(tracker.observe("owner-a", messages, noReplacements)).toBeNull()
  })

  test("admin blockers remain descriptive and do not grant member authorization", () => {
    const tracker = createChatConnectionDecisionTracker()
    armTracker(tracker, "owner-a", "user-current")
    const messages: UIMessage[] = [blockerMessages()[0], { id: "admin", role: "assistant", parts: [{
      type: "dynamic-tool", toolName: "openwork_execute_capability", toolCallId: "call-admin", state: "output-error", input: {},
      errorText: JSON.stringify({ connectionStatus: {
        version: 1, kind: "connection_action", source: "openwork-cloud", connectionId: "emc_research", connectionName: "Research Vault",
        authType: "apikey", credentialMode: "shared", state: "needs_connection", actor: "organization_admin",
        action: { type: "update_credentials", surface: "openwork_organization_connections", retry: "search_capabilities" },
      } }),
    }] }]
    const decision = tracker.observe("owner-a", messages, noReplacements)
    expect(decision?.connection.actor).toBe("organization_admin")
    expect(decision?.action).toBeNull()
  })

  test("retry draft checks readiness and asks before consequential repetition", () => {
    const prompt = chatConnectionRetryPrompt("Research Vault")
    expect(prompt).toContain("Check whether the Research Vault connection is ready")
    expect(prompt).toContain("Verify whether any earlier operation completed")
    expect(prompt).toContain("Ask me before repeating")
    expect(prompt).not.toContain("connection is restored")
  })
})

describe("connection decision race regressions", () => {
  test("invalidates synchronously before optimistic submission or history admission", async () => {
    const tracker = createChatConnectionDecisionTracker()
    const stops = createChatConnectionStopCoordinator()
    armTracker(tracker, "owner", "user-current")
    const old = tracker.observe("owner", blockerMessages(), noReplacements)
    if (!old) throw new Error("Expected the old blocker")
    expect(tracker.claim(old)).toBe(true)
    let calls = 0
    const generation = tracker.begin("owner", "new-instruction")
    const stopping = stops.run("owner", async () => {
      if (!tracker.canStop(old)) return undefined
      calls += 1
      return true
    })
    expect(tracker.observe("owner", blockerMessages(), noReplacements)).toBeNull()
    expect(tracker.canStop(old)).toBe(false)
    expect(tracker.dispatch("owner", old.generation, [], false)).toBe(false)
    expect(await stopping).toBeUndefined()
    expect(calls).toBe(0)
    tracker.dispatch("owner", generation, ["user-current"], false)
    expect(tracker.observe("owner", blockerMessages(), noReplacements)).toBeNull()
    expect(tracker.observe("owner", blockerMessages("new-instruction"), noReplacements)?.generation).toBe(generation)
  })

  for (const path of ["queued", "resume", "question-deferred", "permission-deferred"]) {
    test(`retains the native acknowledgement for ${path} without pendingMessages`, () => {
      const tracker = createChatConnectionDecisionTracker()
      const generation = tracker.begin("owner", `${path}-client`)
      tracker.dispatch("owner", generation, ["old-user"], true)
      tracker.prepared("owner", generation, "Read my next meeting")
      const messages = blockerMessages(`${path}-native`)
      tracker.reconcile("owner", messages.slice(0, 1), noReplacements)
      tracker.prepared("owner", generation, undefined)
      const result = tracker.observe("owner", messages, noReplacements)
      expect(result?.turnId).toBe(`${path}-native`)
      expect(result?.generation).toBe(generation)
    })
  }

  test("identity reconciliation survives a consumed mapping during interaction deferral", () => {
    const tracker = createChatConnectionDecisionTracker()
    const generation = tracker.begin("owner", "client")
    tracker.dispatch("owner", generation, [], true)
    const messages = blockerMessages("native")
    tracker.reconcile("owner", messages.slice(0, 1), new Map([["native", "client"]]))
    expect(tracker.observe("owner", messages, noReplacements)?.turnId).toBe("native")
  })

  test("rejects ambiguous native acknowledgements and stale preparation completions", () => {
    const tracker = createChatConnectionDecisionTracker()
    const first = tracker.begin("owner", "first-client")
    const second = tracker.begin("owner", "second-client")
    tracker.dispatch("owner", second, ["old"], true)
    tracker.prepared("owner", first, "Read my next meeting")
    expect(tracker.observe("owner", blockerMessages("native"), noReplacements)).toBeNull()
    tracker.prepared("owner", second, "Read my next meeting")
    const ambiguous: UIMessage[] = [blockerMessages("another-user")[0], ...blockerMessages("native")]
    expect(tracker.observe("owner", ambiguous, noReplacements)).toBeNull()
    expect(tracker.canStop({ owner: "owner", generation: first, turnId: "native", part: {
      type: "dynamic-tool", toolName: "openwork_execute_capability", toolCallId: "old", input: {}, state: "output-available", output: {},
    }, action: null, connection: { schemaVersion: "1", connectionId: "c", connectionName: "Research Vault", state: "connected", actor: null, action: null, message: "Connected" } })).toBe(false)
  })

  test("connected status supersedes older failures before and after a stop claim", () => {
    const tracker = createChatConnectionDecisionTracker()
    armTracker(tracker, "owner", "user-current")
    const failed = tracker.observe("owner", blockerMessages(), noReplacements)
    if (!failed) throw new Error("Expected a failure")
    expect(tracker.claim(failed)).toBe(true)
    const connected: UIMessage = { id: "connected-result", role: "assistant", parts: [{
      type: "dynamic-tool", toolName: "openwork_connection_action", toolCallId: "latest-connected", input: {}, state: "output-available",
      output: { schemaVersion: "1", connectionId: "emc_research", connectionName: "Research Vault", state: "connected", actor: null, action: null, message: "Connected" },
    }] }
    const result = tracker.observe("owner", [...blockerMessages(), connected], noReplacements)
    expect(result?.connection.state).toBe("connected")
    expect(result?.action).toBeNull()
    expect(tracker.canStop(failed)).toBe(false)
    if (!result) throw new Error("Expected the connected status")
    expect(tracker.claim(result)).toBe(false)
    const fresh = createChatConnectionDecisionTracker()
    armTracker(fresh, "owner", "user-current")
    const resolved = fresh.observe("owner", [...blockerMessages(), connected], noReplacements)
    if (!resolved) throw new Error("Expected a resolved status")
    expect(fresh.claim(resolved)).toBe(false)
  })

  test("mixed connected and blocked connections do not select an arbitrary decision", () => {
    const tracker = createChatConnectionDecisionTracker()
    armTracker(tracker, "owner", "user-current")
    const messages: UIMessage[] = [...blockerMessages(), { id: "other-connected", role: "assistant", parts: [{
      type: "dynamic-tool", toolName: "openwork_connection_action", toolCallId: "other-connection", input: {}, state: "output-available",
      output: { schemaVersion: "1", connectionId: "emc_other", connectionName: "Other Service", state: "connected", actor: null, action: null, message: "Connected" },
    }] }]
    expect(tracker.observe("owner", messages, noReplacements)).toBeNull()
  })

  test("a skipped unfocused stop claim can be resumed without losing turn identity", () => {
    const tracker = createChatConnectionDecisionTracker()
    const generation = armTracker(tracker, "owner", "user-current")
    const decision = tracker.observe("owner", blockerMessages(), noReplacements)
    if (!decision) throw new Error("Expected a blocker")
    expect(tracker.claim(decision)).toBe(true)
    tracker.releaseClaim(decision)
    expect(tracker.isCurrent("owner", generation)).toBe(true)
    expect(tracker.claim(decision)).toBe(true)
    tracker.begin("owner", "new-instruction")
    tracker.releaseClaim(decision)
    expect(tracker.canStop(decision)).toBe(false)
  })

  test("latest failing result replaces the older repair owner without another automatic stop", () => {
    const tracker = createChatConnectionDecisionTracker()
    armTracker(tracker, "owner", "user-current")
    const first = tracker.observe("owner", blockerMessages(), noReplacements)
    if (!first) throw new Error("Expected a blocker")
    tracker.claim(first)
    const changed: UIMessage = { id: "admin-result", role: "assistant", parts: [{
      type: "dynamic-tool", toolName: "openwork_connection_action", toolCallId: "latest-admin", input: {}, state: "output-available",
      output: { schemaVersion: "1", connectionId: "emc_research", connectionName: "Research Vault", state: "needs_connection", actor: "organization_admin", message: "Admin setup required",
        action: { type: "update_credentials", surface: "openwork_organization_connections", label: "Update credentials" } },
    }] }
    const latest = tracker.observe("owner", [...blockerMessages(), changed], noReplacements)
    expect(latest?.connection.actor).toBe("organization_admin")
    expect(latest?.action).toBeNull()
    if (!latest) throw new Error("Expected the admin blocker")
    expect(tracker.claim(latest)).toBe(false)
  })

  test("normal and connection Stop join one owner promise and preserve its result", async () => {
    const stops = createChatConnectionStopCoordinator()
    let release: (result: boolean) => void = () => { throw new Error("Stop did not start") }
    let calls = 0
    const normal = stops.run("owner", () => {
      calls += 1
      return new Promise<boolean>(resolve => { release = resolve })
    })
    const connection = stops.run("owner", async () => { calls += 1; return false })
    expect(connection).toBe(normal)
    expect(stops.isPending("owner")).toBe(true)
    expect(stops.isPending("other-owner")).toBe(false)
    await Promise.resolve()
    release(true)
    expect(await connection).toBe(true)
    expect(calls).toBe(1)
    expect(stops.isPending("owner")).toBe(false)
    expect(await stops.run("owner", async () => false)).toBe(false)
    expect(stops.isBlocked("owner")).toBe(true)
    expect(stops.needsConfirmation("owner")).toBe(true)
    expect(stops.phase("owner")).toBe("failed")
    expect(await stops.run("owner", async () => undefined)).toBeUndefined()
    expect(stops.isBlocked("owner")).toBe(true)
    expect(await stops.run("owner", async () => true)).toBe(true)
    expect(stops.isBlocked("owner")).toBe(false)
    expect(stops.phase("owner")).toBe("idle")
  })

  test("temporary split focus changes neither submission identity nor the stop claim", () => {
    const tracker = createChatConnectionDecisionTracker()
    const generation = armTracker(tracker, "owner", "user-current")
    tracker.reconcile("owner", blockerMessages(), noReplacements)
    expect(tracker.isCurrent("owner", generation)).toBe(true)
    const whenFocused = tracker.observe("owner", blockerMessages(), noReplacements)
    if (!whenFocused) throw new Error("Expected the retained blocker")
    expect(tracker.claim(whenFocused)).toBe(true)
    tracker.reconcile("owner", blockerMessages(), noReplacements)
    expect(tracker.claim(whenFocused)).toBe(false)
    expect(tracker.isCurrent("other-owner", generation)).toBe(false)
    tracker.reset()
    expect(tracker.observe("owner", blockerMessages(), noReplacements)).toBeNull()
  })
})

describe("connection blocker queue preservation", () => {
  const sessionId = "held-session"
  const owner = "held-owner"
  const revoked: string[] = []
  const originalRevoke = URL.revokeObjectURL
  const queue = () => getComposerQueuedDrafts(useComposerStateStore.getState(), sessionId)
  const held = () => getQueuedDrainState(sessionId)

  beforeEach(() => {
    resetQueuedDrainForTests()
    useComposerStateStore.setState({ sessions: {}, queuedDrafts: {}, failedDrafts: {}, pendingMessages: {} })
    revoked.length = 0
    URL.revokeObjectURL = url => { revoked.push(url) }
    const file = new File(["image bytes"], "evidence.png", { type: "image/png" })
    const draft: ComposerDraft = {
      mode: "prompt", text: "  Keep exact text\n[pasted text 1] [attachment evidence]  ",
      resolvedText: "  Keep exact text\nexpanded source  ",
      parts: [{ type: "text", text: "  Keep exact text\nexpanded source  " }],
      attachments: [{ id: "evidence", name: file.name, mimeType: file.type, size: file.size, kind: "image", file, previewUrl: "blob:held-preview" }],
    }
    useComposerStateStore.getState().appendQueuedDraft(sessionId, draft)
    useComposerStateStore.getState().appendQueuedDraft(sessionId, { ...draft, text: "second", attachments: [] })
    useComposerStateStore.getState().setDraft(sessionId, "newer composer instruction")
  })

  afterEach(() => {
    URL.revokeObjectURL = originalRevoke
    resetQueuedDrainForTests()
    useComposerStateStore.setState({ sessions: {}, queuedDrafts: {}, failedDrafts: {}, pendingMessages: {} })
  })

  for (const confirmed of [true, false]) {
    test(`automatic Stop preserves queue identity and attachments before and after confirmation=${confirmed}`, async () => {
      const before = queue()
      const stops = createChatConnectionStopCoordinator()
      let finish: (result: boolean) => void = () => { throw new Error("Stop was not started") }
      const stopping = stops.run(owner, async () => {
        prepareChatStopQueue(sessionId, "connection", () => true)
        const result = await new Promise<boolean>(resolve => { finish = resolve })
        if (result) dispatchQueuedDrain(sessionId, { type: "stop_confirmed" })
        return result
      })
      expect(queue()).toBe(before)
      expect(revoked).toEqual([])
      expect(held().held).toBe(true)
      expect(claimQueuedSend(sessionId, before[0].id)).toBe(false)
      finish(confirmed)
      expect(await stopping).toBe(confirmed)
      expect(queue()).toBe(before)
      expect(queue()[0].draft.attachments[0].file).toBe(before[0].draft.attachments[0].file)
      expect(useComposerStateStore.getState().sessions[sessionId].draft).toBe("newer composer instruction")
      expect(canAdmitNextQueuedItem(held())).toBe(false)
      expect(revoked).toEqual([])
    })
  }

  test("Stop exceptions keep the held queue and its attachment ownership", async () => {
    const before = queue()
    const stops = createChatConnectionStopCoordinator()
    await expect(stops.run(owner, async () => {
      prepareChatStopQueue(sessionId, "connection", () => true)
      throw new Error("Stop failed")
    })).rejects.toThrow("Stop failed")
    revokeUnownedAttachmentPreviews(before[0].draft.attachments)
    expect(stops.needsConfirmation(owner)).toBe(true)
    expect(queue()).toBe(before)
    expect(held().held).toBe(true)
    expect(revoked).toEqual([])
  })

  test("stale connection generations cannot hold, clear, revoke, or fence a newer instruction", () => {
    const before = queue()
    const tracker = createChatConnectionDecisionTracker()
    const generation = armTracker(tracker, owner, "user-current")
    const decision = tracker.observe(owner, blockerMessages(), noReplacements)
    if (!decision) throw new Error("Expected a blocker")
    tracker.claim(decision)
    tracker.begin(owner, "new-instruction")
    const sendGeneration = getQueuedSendGeneration(sessionId)
    expect(prepareChatStopQueue(sessionId, "connection", () => tracker.isCurrent(owner, generation))).toBe(false)
    expect(queue()).toBe(before)
    expect(held().held).not.toBe(true)
    expect(getQueuedSendGeneration(sessionId)).toBe(sendGeneration)
    expect(revoked).toEqual([])
  })

  test("the hold fences claimed preflight without dropping its row or revoking its image", async () => {
    const before = queue()
    const item = before[0]
    expect(claimQueuedSend(sessionId, item.id)).toBe(true)
    const generation = getQueuedSendGeneration(sessionId)
    let release = () => {}
    const preflight = new Promise<void>(resolve => { release = resolve })
    let sends = 0
    const sending = (async () => {
      await preflight
      try {
        assertQueuedSendCurrent(sessionId, generation)
        sends += 1
      } catch {
        dispatchQueuedDrain(sessionId, { type: "send_result", itemId: item.id, outcome: "cancelled", at: 1 })
      } finally {
        revokeUnownedAttachmentPreviews(item.draft.attachments)
      }
    })()
    prepareChatStopQueue(sessionId, "connection", () => true)
    dispatchQueuedDrain(sessionId, { type: "stop_confirmed" })
    dispatchQueuedDrain(sessionId, { type: "queue_released" })
    expect(held().held).toBe(true)
    expect(claimQueuedSend(sessionId, item.id, true)).toBe(false)
    release()
    await sending
    expect(sends).toBe(0)
    expect(queue()).toBe(before)
    expect(revoked).toEqual([])
    expect(canAdmitNextQueuedItem(held())).toBe(false)
  })

  test("a synchronous hold during send-slot notification cannot start preflight with a fresh generation", () => {
    const before = queue()
    const unsubscribe = subscribeQueuedDrain(sessionId, () => {
      if (!held().held) prepareChatStopQueue(sessionId, "connection", () => true)
    })
    expect(claimQueuedSend(sessionId, before[0].id)).toBe(false)
    unsubscribe()
    expect(held().phase.kind).toBe("ready")
    expect(held().held).toBe(true)
    expect(queue()).toBe(before)
    expect(revoked).toEqual([])
    expect(claimQueuedSend(sessionId, before[0].id)).toBe(false)
  })

  test("accepted-row cleanup preserves previews still owned by another queued draft or composer", () => {
    const item = queue()[0]
    useComposerStateStore.getState().appendQueuedDraft(sessionId, item.draft)
    prepareChatStopQueue(sessionId, "connection", () => true)
    useComposerStateStore.getState().removeQueuedDraft(sessionId, item.id)
    revokeUnownedAttachmentPreviews(item.draft.attachments)
    expect(revoked).toEqual([])
    useComposerStateStore.getState().setAttachments(sessionId, item.draft.attachments)
    useComposerStateStore.getState().clearQueuedDrafts(sessionId)
    revokeUnownedAttachmentPreviews(item.draft.attachments)
    expect(revoked).toEqual([])
  })

  test("a late accepted send consumes only its admitted row and leaves the rest paused", () => {
    const [item, next] = queue()
    expect(claimQueuedSend(sessionId, item.id)).toBe(true)
    prepareChatStopQueue(sessionId, "connection", () => true)
    dispatchQueuedDrain(sessionId, { type: "stop_confirmed" })
    useComposerStateStore.getState().removeQueuedDraft(sessionId, item.id)
    dispatchQueuedDrain(sessionId, { type: "send_result", itemId: item.id, outcome: "accepted", at: 1 })
    revokeUnownedAttachmentPreviews(item.draft.attachments)
    dispatchQueuedDrain(sessionId, { type: "busy_observed" })
    dispatchQueuedDrain(sessionId, { type: "idle_reconciled", observedAt: 2 })
    expect(queue()).toEqual([next])
    expect(revoked).toEqual(["blob:held-preview"])
    expect(claimQueuedSend(sessionId, next.id)).toBe(false)
  })

  for (const admission of ["admission_observed", "admission_rejected"]) {
    test(`unknown admission remains protected across hold and ${admission}`, () => {
      const item = queue()[0]
      expect(claimQueuedSend(sessionId, item.id)).toBe(true)
      prepareChatStopQueue(sessionId, "connection", () => true)
      dispatchQueuedDrain(sessionId, { type: "send_unknown", itemId: item.id, messageID: "msg-exact", at: 1 })
      dispatchQueuedDrain(sessionId, { type: "stop_confirmed" })
      dispatchQueuedDrain(sessionId, { type: "queue_released" })
      expect(held().phase.kind).toBe("admission_unknown")
      expect(held().held).toBe(true)
      expect(claimQueuedSend(sessionId, item.id, true)).toBe(false)
      if (admission === "admission_observed") {
        dispatchQueuedDrain(sessionId, { type: "admission_observed", itemId: item.id, messageID: "msg-exact", at: 2 })
      } else {
        dispatchQueuedDrain(sessionId, { type: "admission_rejected", itemId: item.id, messageID: "msg-exact" })
      }
      dispatchQueuedDrain(sessionId, { type: "idle_reconciled", observedAt: 3 })
      dispatchQueuedDrain(sessionId, { type: "user_retry" })
      expect(canAdmitNextQueuedItem(held())).toBe(false)
      expect(revoked).toEqual([])
    })
  }

  test("reconnect, dismiss, idle, gate recovery and remount cannot release a held queue", () => {
    const tracker = createChatConnectionDecisionTracker()
    armTracker(tracker, owner, "user-current")
    tracker.observe(owner, blockerMessages(), noReplacements)
    const before = queue()
    prepareChatStopQueue(sessionId, "connection", () => true)
    const connected: UIMessage = { id: "connected", role: "assistant", parts: [{
      type: "dynamic-tool", toolName: "openwork_connection_action", toolCallId: "connected", state: "output-available", input: {},
      output: { schemaVersion: "1", connectionId: "emc_research", connectionName: "Research Vault", state: "connected", actor: null, action: null, message: "Connected" },
    }] }
    tracker.observe(owner, [...blockerMessages(), connected], noReplacements)
    tracker.reset()
    dispatchQueuedDrain(sessionId, { type: "stop_confirmed" })
    dispatchQueuedDrain(sessionId, { type: "busy_observed" })
    dispatchQueuedDrain(sessionId, { type: "idle_reconciled", observedAt: 2 })
    dispatchQueuedDrain(sessionId, { type: "user_retry" })
    const unsubscribe = subscribeQueuedDrain(sessionId, () => {})
    unsubscribe()
    expect(queue()).toBe(before)
    expect(claimQueuedSend(sessionId, before[0].id)).toBe(false)
    expect(revoked).toEqual([])
  })

  test("manual Send now sends only the chosen row; explicit Resume queue releases the remainder", () => {
    const [item, next] = queue()
    prepareChatStopQueue(sessionId, "connection", () => true)
    dispatchQueuedDrain(sessionId, { type: "stop_confirmed" })
    expect(claimQueuedSend(sessionId, item.id, true)).toBe(true)
    expect(claimQueuedSend(sessionId, item.id, true)).toBe(false)
    useComposerStateStore.getState().removeQueuedDraft(sessionId, item.id)
    dispatchQueuedDrain(sessionId, { type: "send_result", itemId: item.id, outcome: "sent", at: 1 })
    dispatchQueuedDrain(sessionId, { type: "busy_observed" })
    dispatchQueuedDrain(sessionId, { type: "idle_reconciled", observedAt: 2 })
    expect(claimQueuedSend(sessionId, next.id)).toBe(false)
    dispatchQueuedDrain(sessionId, { type: "queue_released" })
    expect(claimQueuedSend(sessionId, next.id)).toBe(true)
  })

  test("manual Stop retains clear-and-revoke semantics even when joining an automatic Stop", async () => {
    const stops = createChatConnectionStopCoordinator()
    let finish: (result: boolean) => void = () => {}
    const automatic = stops.run(owner, async () => {
      prepareChatStopQueue(sessionId, "connection", () => true)
      return new Promise<boolean>(resolve => { finish = resolve })
    })
    expect(stops.isPending(owner)).toBe(true)
    prepareChatStopQueue(sessionId, "manual", () => true)
    const manual = stops.run(owner, async () => { throw new Error("Must join the existing Stop") })
    expect(manual).toBe(automatic)
    expect(queue()).toEqual([])
    expect(held().held).not.toBe(true)
    expect(revoked).toEqual(["blob:held-preview"])
    expect(useComposerStateStore.getState().sessions[sessionId].draft).toBe("newer composer instruction")
    finish(true)
    await manual
  })

  test("Stop queue policy and owned-preview cleanup are wired into both senders", () => {
    const surface = readFileSync(new URL("../src/react-app/domains/session/surface/session-surface.tsx", import.meta.url), "utf8")
    const background = readFileSync(new URL("../src/react-app/domains/session/sync/global-queue-drainer.ts", import.meta.url), "utf8")
    expect(surface).toContain('handleAbort("connection", isCurrent)')
    expect(surface).toContain("prepareChatStopQueue(props.sessionId, intent, isCurrent)")
    expect(surface).toContain('intent: "manual" | "connection" = "manual"')
    expect(surface).toContain('Queued messages are paused after a connection blocker.')
    expect(surface).not.toContain("nextDraft.attachments.forEach(revokeAttachmentPreview)")
    expect(surface).not.toContain("target.attachments.forEach(revokeAttachmentPreview)")
    expect(background).toContain("revokeUnownedAttachmentPreviews(draft.attachments)")
    expect(background).toContain('outcome === "cancelled" && !getQueuedDrainState(sessionId).held')
  })
})

describe("chat MCP reconnect completion", () => {
  test("requires a new member authorization timestamp, not merely an existing token", () => {
    expect(hasFreshMcpAuthorization(baseConnection, baseConnection.connectedAt)).toBe(false)
    expect(hasFreshMcpAuthorization({
      ...baseConnection,
      connectedAt: "2026-07-16T20:01:00.000Z",
    }, baseConnection.connectedAt)).toBe(true)
  })

  test("polls through the unchanged credential until the OAuth callback advances it", async () => {
    let now = 0
    let lists = 0
    const result = await waitForFreshMcpAuthorization({
      connectionId: baseConnection.id,
      connectionName: baseConnection.name,
      previousConnectedAt: baseConnection.connectedAt,
      listConnections: async () => {
        lists += 1
        return [{
          ...baseConnection,
          connectedAt: lists < 2 ? baseConnection.connectedAt : "2026-07-16T20:01:00.000Z",
        }]
      },
      isScopeCurrent: () => true,
      timeoutMs: 10,
      intervalMs: 1,
      now: () => now,
      sleep: async (milliseconds) => { now += milliseconds },
    })

    expect(result.connectedAt).toBe("2026-07-16T20:01:00.000Z")
    expect(lists).toBe(2)
  })

  test("stops if the active Den account or organization changes", async () => {
    const original = { baseUrl: "https://den.test", token: "member-a", organizationId: "org-a" }
    expect(isChatMcpReconnectScopeCurrent(original, { ...original })).toBe(true)
    expect(isChatMcpReconnectScopeCurrent(original, { ...original, organizationId: "org-b" })).toBe(false)

    await expect(waitForFreshMcpAuthorization({
      connectionId: baseConnection.id,
      connectionName: baseConnection.name,
      previousConnectedAt: baseConnection.connectedAt,
      listConnections: async () => [baseConnection],
      isScopeCurrent: () => false,
      timeoutMs: 10,
      intervalMs: 1,
    })).rejects.toThrow("active OpenWork Cloud account changed")
  })

  test("times out without claiming a stale connected account was repaired", async () => {
    let now = 0
    await expect(waitForFreshMcpAuthorization({
      connectionId: baseConnection.id,
      connectionName: baseConnection.name,
      previousConnectedAt: baseConnection.connectedAt,
      listConnections: async () => [baseConnection],
      isScopeCurrent: () => true,
      timeoutMs: 3,
      intervalMs: 1,
      now: () => now,
      sleep: async (milliseconds) => { now += milliseconds },
    })).rejects.toThrow("did not finish")
  })
})
