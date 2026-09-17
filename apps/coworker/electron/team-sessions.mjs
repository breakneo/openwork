import { mkdir, readFile, realpath, rename, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { HeadlessThreadError, isNativeV2ObservationError } from "@openwork/headless-threads/v2";

export function assertOwnedNativeTool({ slug, context, name, args, entry, snapshot, workspaceId, active }) {
  const message = snapshot.messages.find((item) => item.id === context.messageID && item.role === "assistant");
  const part = message?.parts.find((item) => item.type === "tool" && item.callId === context.callID);
  if (!active || entry?.state !== "running" || !entry.sentAt || entry.owner.slug !== slug || entry.owner.threadId !== context.sessionID
    || entry.workspaceId !== workspaceId || snapshot.threadId !== context.sessionID || !context.directory || !snapshot.directory
    || path.resolve(context.directory) !== path.resolve(snapshot.directory) || entry.tools?.[name] === false
    || !snapshot.messages.some((item) => item.id === entry.messageId && item.role === "user")
    || message?.parentId !== entry.messageId || message.completedAt != null || message.error || part?.tool !== name
    || part.toolStatus !== "running" || !isDeepStrictEqual(part.toolInput, args)) throw new Error("This action requires its exact admitted native tool call.");
}

const kinds = new Set(["unassigned", "private", "assignment", "worker", "group", "consultation", "coordinator", "legacy"]);
const nonempty = (value) => typeof value === "string" && value.length > 0;
const sameDirectory = async (left, right) => { try { return await realpath(left) === await realpath(right); } catch { return false; } };
const same = (left, right) => ["slug", "createdAt", "sessionId", "workspaceId", "nativeWorkspaceId", "directory", "kind"].every((key) => left[key] === right[key]);

function checked(input) {
  if (!input || !/^(?:[a-z0-9][a-z0-9-]*|\.coordinator)$/.test(input.slug)
    || !nonempty(input.createdAt) || !/^ses_[A-Za-z0-9_]+$/.test(input.sessionId)
    || !nonempty(input.workspaceId) || (input.nativeWorkspaceId !== undefined && !nonempty(input.nativeWorkspaceId))
    || !path.isAbsolute(input.directory ?? "") || !kinds.has(input.kind)) throw new Error("A complete host-owned session binding is required.");
  return { slug: input.slug, createdAt: input.createdAt, sessionId: input.sessionId, workspaceId: input.workspaceId, nativeWorkspaceId: input.nativeWorkspaceId ?? input.workspaceId, directory: path.resolve(input.directory), kind: input.kind };
}

export async function resolveNativeFilesystemScope(owner, capability) {
  if (capability?.filesystemScopeVersion !== 1 || capability.filesystemScopeProjectResolution !== 1) throw new Error("Native invocation scope and project resolution were not observed.");
  return { directory: await realpath(owner.path) };
}

export function createTeamSessionRegistry({ file, coworkerFor, executionFor }) {
  let tail = Promise.resolve();
  async function read() {
    let text;
    try { text = await readFile(file, "utf8"); }
    catch (error) { if (error.code === "ENOENT") return {}; throw error; }
    const state = JSON.parse(text);
    if (state.version !== 1 || !Array.isArray(state.sessions)) throw new Error("The host session bindings cannot be read. Existing history was not changed.");
    const sessions = {};
    for (const input of state.sessions) {
      const binding = checked(input);
      if (Object.hasOwn(sessions, binding.sessionId)) throw new Error("Conflicting host session bindings. Existing history was not changed.");
      sessions[binding.sessionId] = binding;
    }
    return sessions;
  }
  async function current(binding) {
    const owner = await coworkerFor(binding.slug);
    if (!owner || owner.slug !== binding.slug || owner.createdAt !== binding.createdAt) throw new Error("This session belongs to an unknown, retired or replaced coworker.");
    return owner;
  }
  async function resolve(sessionId, owner) {
    await tail;
    const binding = (await read())[sessionId];
    if (!binding || (owner && (owner.slug !== binding.slug || owner.createdAt !== binding.createdAt))) throw new Error("This session has no matching host owner.");
    await current(binding);
    return binding;
  }
  function bind(input, classification = false) {
    const binding = checked(input);
    const work = tail.then(async () => {
      await current(binding);
      const sessions = await read();
      const previous = sessions[binding.sessionId];
      if (previous) {
        if (same(previous, binding)) return previous;
        if (!classification || previous.kind !== "unassigned" || !same({ ...previous, kind: binding.kind }, binding)) throw new Error("A session's original host binding cannot be reassigned.");
      }
      sessions[binding.sessionId] = binding;
      await mkdir(path.dirname(file), { recursive: true });
      const temporary = `${file}.${randomUUID()}.tmp`;
      await writeFile(temporary, JSON.stringify({ version: 1, sessions: Object.values(sessions) }) + "\n", { mode: 0o600 });
      await rename(temporary, file);
      return binding;
    });
    tail = work.then(() => undefined, () => undefined);
    return work;
  }
  async function context(input) {
    const binding = await resolve(input?.sessionID);
    if (!nonempty(input.directory) || !await sameDirectory(input.directory, binding.directory)) throw new Error("The native session location does not match its host binding.");
    const entry = await executionFor(binding);
    if (!entry || !nonempty(entry.id) || !nonempty(entry.messageId) || !nonempty(entry.model?.providerId) || !nonempty(entry.model?.modelId) || !nonempty(entry.agent)
      || entry.state !== "running" || entry.owner?.slug !== binding.slug || entry.owner?.threadId !== binding.sessionId
      || entry.coworkerCreatedAt !== binding.createdAt || entry.workspaceId !== binding.workspaceId
      || (binding.kind !== "legacy" && entry.owner.kind !== binding.kind)
      || (input.executionID !== undefined && input.executionID !== entry.id)
      || (input.agent !== undefined && input.agent !== entry.agent)
      || (input.model !== undefined && (input.model.providerID !== entry.model.providerId || input.model.id !== entry.model.modelId
        || (input.model.variant ?? "default") !== (entry.model.variant ?? "default")))) throw new Error("This session has no matching admitted native execution.");
    return { binding, entry, coworker: await current(binding) };
  }
  return {
    bind: (input) => bind(input), resolve, context,
    async cleanupBinding(sessionId) {
      await tail;
      const binding = (await read())[sessionId];
      if (!binding) throw new Error("This cleanup has no original host session binding.");
      return binding;
    },
    async classify(sessionId, owner, kind) {
      return bind({ ...await resolve(sessionId, owner), kind }, true);
    },
    async list(owner) {
      await tail;
      const bindings = Object.values(await read()).filter((binding) => binding.slug === owner.slug && binding.createdAt === owner.createdAt);
      for (const binding of bindings) await current(binding);
      return bindings;
    },
    async importLegacy({ owner, workspace, sessions, classify }) {
      if (!owner.workspaceId || workspace.id !== owner.workspaceId || path.resolve(workspace.path) !== path.resolve(owner.path)
        || !Number.isFinite(Date.parse(owner.createdAt))) throw new Error("Legacy history requires the original host workspace and coworker identity.");
      const bindings = [];
      for (const session of sessions) {
        if (!session.location?.directory || path.resolve(session.location.directory) !== path.resolve(workspace.path)) throw new Error("Legacy history returned a foreign native location.");
        if (!Number.isFinite(session.time?.created) || session.time.created < Date.parse(owner.createdAt)) continue;
        bindings.push(await bind({ slug: owner.slug, createdAt: owner.createdAt, sessionId: session.id, workspaceId: workspace.id, directory: workspace.path, kind: classify(session.id) }));
      }
      return bindings;
    },
    async route(sessionId, owner, clients, { allowUnavailable = false } = {}) {
      const binding = await resolve(sessionId, owner);
      const client = await clients(binding);
      let session;
      try { session = await client.getSession(sessionId); }
      catch (error) {
        if (!allowUnavailable || !(isNativeV2ObservationError(error) || (error instanceof HeadlessThreadError && error.method === "GET" && error.code === "request_failed" && error.status === 404))) throw error;
        return { binding, session: null, client };
      }
      if (session.id !== binding.sessionId || !session.location?.directory || path.resolve(session.location.directory) !== binding.directory) throw new Error("The native history does not match its original host binding.");
      return { binding, session, client };
    },
  };
}
