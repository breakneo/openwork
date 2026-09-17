import { createHash, randomUUID } from "node:crypto";

export type PromptAdmissionState = "queued" | "forwarding" | "accepted" | "cancelled" | "rejected" | "unknown";
export type PromptAdmissionScope = { credential: string; workspace: string; session: string };
type Entry = {
  ticket: string;
  fingerprint: string;
  expiresAt: number;
  state: PromptAdmissionState;
  claimed: boolean;
  onQueuedSettlement?: () => void;
};

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const reply = (state: PromptAdmissionState, status = 200, ticket?: string) =>
  Response.json({ protocol: "openwork-prompt-admission-v1", state, ...(ticket ? { ticket } : {}) }, { status, headers: { "Cache-Control": "no-store" } });

export function promptMessageID(body: string): string | undefined {
  try {
    const value: unknown = JSON.parse(body);
    if (value && typeof value === "object" && "messageID" in value && typeof value.messageID === "string"
      && value.messageID.length > 0 && value.messageID.length <= 256) return value.messageID;
  } catch { /* Invalid native input is not a ticketed admission. */ }
  return undefined;
}

/** Tickets authorize ONE forwarding attempt, not an engine acknowledgement.
 * Dedupe is scoped to retained, valid tickets, NOT lifetime message IDs.
 * Finalized/expired slots can be reclaimed; forgotten tickets never dispatch.
 * OpenWork must prepare only once per attempted identity, not reacquire a
 * ticket after an uncertain dispatch, eviction, expiry or restart.
 */
export class PromptAdmissionLedger {
  private readonly entries = new Map<string, Entry>();
  private readonly generation = randomUUID();
  private closed = false;

  constructor(private readonly capacity = 4096, private readonly ttlMs = 24 * 60 * 60_000,
    private readonly now: () => number = Date.now) {}

  private key(scope: PromptAdmissionScope, messageID: string) {
    return hash(JSON.stringify([scope.credential, scope.workspace, scope.session, messageID]));
  }

  private state(entry: Entry | undefined): PromptAdmissionState {
    return this.closed || !entry || this.now() >= entry.expiresAt ? "unknown" : entry.state;
  }

  private retire(key: string, entry: Entry): void {
    entry.state = "unknown";
    entry.onQueuedSettlement?.();
    this.entries.delete(key);
  }

  private reclaim(): void {
    for (const [key, entry] of this.entries) {
      if (this.now() >= entry.expiresAt) this.retire(key, entry);
    }
    if (this.entries.size < this.capacity) return;
    for (const [key, entry] of this.entries) {
      if (entry.state !== "accepted" && entry.state !== "cancelled" && entry.state !== "rejected") continue;
      this.retire(key, entry);
      break;
    }
  }

  close(): void {
    this.closed = true;
    for (const entry of this.entries.values()) {
      if (entry.state !== "queued") continue;
      entry.state = "cancelled";
      entry.onQueuedSettlement?.();
    }
  }

  prepare(scope: PromptAdmissionScope, body: string): Response {
    if (this.closed) return reply("unknown", 503);
    const messageID = promptMessageID(body);
    if (!messageID) return reply("rejected", 400);
    const key = this.key(scope, messageID);
    const fingerprint = hash(body);
    const existing = this.entries.get(key);
    if (existing) {
      if (existing.fingerprint !== fingerprint) return reply("unknown", 409);
      const state = this.state(existing);
      return reply(state, state === "unknown" ? 410 : 200, state === "unknown" ? undefined : existing.ticket);
    }
    this.reclaim();
    if (this.entries.size >= this.capacity) return reply("unknown", 503);
    const entry: Entry = { ticket: `${this.generation}.${randomUUID()}`, fingerprint,
      expiresAt: this.now() + this.ttlMs, state: "queued", claimed: false };
    this.entries.set(key, entry);
    return reply("queued", 200, entry.ticket);
  }

  inspect(scope: PromptAdmissionScope, messageID: string, cancel = false): Response {
    const entry = this.entries.get(this.key(scope, messageID));
    if (entry && this.state(entry) === "queued" && cancel) {
      entry.state = "cancelled";
      entry.onQueuedSettlement?.();
    }
    return reply(this.state(entry));
  }

  /** A still-authorized proxy rejected this exact ticket/payload before native
   * forwarding (e.g. policy changed after preparation). Invalidate any queued
   * closure too; never overwrite a forwarding/accepted/uncertain outcome. */
  rejectQueued(scope: PromptAdmissionScope, ticket: string, body: string): void {
    const messageID = promptMessageID(body);
    const entry = messageID ? this.entries.get(this.key(scope, messageID)) : undefined;
    if (!entry || entry.ticket !== ticket || entry.fingerprint !== hash(body) || this.state(entry) !== "queued") return;
    entry.state = "rejected";
    entry.onQueuedSettlement?.();
  }

  async dispatch(scope: PromptAdmissionScope, ticket: string, body: string,
    schedule: (operation: () => Promise<Response>) => Promise<Response>,
    forward: () => Promise<Response>): Promise<Response> {
    const messageID = promptMessageID(body);
    const entry = messageID ? this.entries.get(this.key(scope, messageID)) : undefined;
    if (!entry || entry.ticket !== ticket || entry.fingerprint !== hash(body)) return reply("unknown", 409);
    const state = this.state(entry);
    if (state === "accepted") return new Response(null, { status: 204 });
    if (state === "cancelled" || state === "rejected") return reply(state, 409);
    if (state !== "queued" || entry.claimed) return reply(state, 409);
    entry.claimed = true;
    const cancelled = new Promise<Response>((resolve) => {
      entry.onQueuedSettlement = () => resolve(reply(this.state(entry), 409));
    });
    try {
      const scheduled = schedule(async () => {
        // This check and the transition MUST be synchronous, inside the fence.
        // Cancelling a queued ticket invalidates the original closure as well.
        const current = this.state(entry);
        if (current !== "queued") return reply(current, 409);
        entry.state = "forwarding";
        try {
          const response = await forward();
          entry.state = response.ok ? "accepted"
            : response.status >= 400 && response.status < 500 && response.status !== 408 ? "rejected" : "unknown";
          return response;
        } catch (error) {
          entry.state = "unknown";
          throw error;
        }
      });
      // Release the HTTP/task-recovery admission wait immediately on cancel,
      // without removing the fence's original guarded callback.
      return await Promise.race([scheduled, cancelled]);
    } catch (error) {
      if (entry.state === "queued") entry.state = "rejected";
      throw error;
    } finally {
      delete entry.onQueuedSettlement;
    }
  }
}
