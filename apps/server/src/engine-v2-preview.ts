import { executionRules } from "./managed-policy-rules.js";
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { resolveOpencodeV2Version } from "./opencode-v2-binary.js";
import { waitForNativeOpenWorkV2Skills } from "./opencode-v2-instructions.js";
import {
  CloudNativeSkillSyncError,
  cloudNativeSkillScopeKey,
  createCloudNativeSkillSync,
  EMPTY_CLOUD_NATIVE_SKILL_STATE,
  type CloudNativeSkillState,
  type CloudNativeSkillSyncCode,
} from "./cloud-native-skills.js";
import {
  createManagedOpencodeV2Server,
  installOpencodeV2Binary,
  nativeCatalogModelMetadata,
  type ManagedOpencodeV2Server,
  type OpencodeV2ProviderSpec,
} from "./managed-opencode-v2.js";
import { resolveOpencodeModelsUrl } from "./opencode-models-url.js";
import { runtimeDbPath, runtimeStorageDir } from "./runtime-db.js";
import {
  isEngineGlobalRuntimeConfigId,
  onRuntimeOpencodeConfigWrite,
  readGlobalRuntimeMcpConfig,
  readGlobalRuntimeOpencodeConfig,
  readEffectiveRuntimeOpencodeConfig,
  runtimeMcpMap,
  runtimeProviderMap,
} from "./runtime-opencode-config-store.js";
import type { EnvService } from "./env-file.js";
import { selectPrimaryCredentialEnvName } from "./managed-provider-auth.js";
import type { ServerConfig } from "./types.js";

const PREVIEW_STATE_FILE = "engine-v2-preview.json";
const UNSET_API_KEY = "openwork-engine-v2-preview-unset";
/** Reserved Connect MCP name; kept in sync with OPENWORK_CLOUD_MCP_NAME in cloud-mcp-health.ts. */
const OPENWORK_CLOUD_MCP_NAME = "openwork-cloud";
// A cold sidecar can return HTTP 503 while its model catalog initializes for 17–20 seconds.
const CATALOG_MIRROR_TIMEOUT_MS = 60_000;

export interface EngineV2PreviewStatus {
  enabled: boolean;
  chatRouting: boolean;
  running: boolean;
  version?: string;
  pid?: number;
  binSource?: "explicit" | "env" | "path" | "cache";
  mirroredProviderIds: string[];
  skippedProviderIds: string[];
  catalogModelIds: string[];
  lastMirroredAt?: string;
  lastError?: string;
}

export interface RuntimeProviderRecordLike {
  name?: string;
  npm?: string;
  options?: {
    baseURL?: string;
    apiKey?: string;
  };
  models?: Record<string, unknown>;
}

export interface EngineV2Preview {
  start(): Promise<void>;
  refresh(): Promise<void>;
  process(): { pid: number | null; isAlive(): boolean };
  status(): EngineV2PreviewStatus;
  setEnabled(enabled: boolean): Promise<EngineV2PreviewStatus>;
  setChatRouting(chatRouting: boolean): Promise<EngineV2PreviewStatus>;
  connection(): { url: string; username: string; password: string } | undefined;
  modelMetadata?(providerID: string, modelID: string): ReturnType<typeof nativeCatalogModelMetadata>;
  ensureWorkspaceReady(directory: string): Promise<void>;
  syncWorkspaceMcp(workspaceId: string, directory: string, forceNames?: string[]): Promise<void>;
  /** Fresh materialization of authorized Cloud skills as native skills. `failure` is set when they failed closed (cleared) for this admission. */
  syncCloudSkills(): Promise<{ root: string; state: CloudNativeSkillState; failure?: CloudNativeSkillSyncCode }>;
  /** One serialized fresh Cloud read + native readiness barrier for discovery/admission. */
  assertNativeSkillsScope(expectedScope: string | null): Promise<void>;
  withNativeSkills<T>(directory: string, use: (catalog: Awaited<ReturnType<typeof waitForNativeOpenWorkV2Skills>>, assertCurrent: () => Promise<void>) => Promise<T>, expectedScope?: string | null): Promise<T>;
  request(directory: string, path: string, init?: { method?: string; body?: unknown; timeoutMs?: number }): Promise<{ status: number; json: unknown }>;
  stop(): Promise<void>;
}

export const engineV2ByConfig = new WeakMap<ServerConfig, EngineV2Preview>();

export interface EngineV2PreviewState {
  enabled: boolean;
  chatRouting?: boolean;
}

export function resolveInitialEngineV2PreviewState(
  env: NodeJS.ProcessEnv,
  persisted: EngineV2PreviewState,
): EngineV2PreviewState {
  const override = env.OPENWORK_ENGINE_V2_PREVIEW;
  if (override === "1" || override === "chat") return { enabled: true, chatRouting: true };
  if (override === "sidecar") return { enabled: true, chatRouting: false };
  return persisted;
}

interface ResolvedBinary {
  bin: string;
  source: NonNullable<EngineV2PreviewStatus["binSource"]>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function statePath(config: ServerConfig): string {
  return join(runtimeStorageDir(config), PREVIEW_STATE_FILE);
}

export function readEngineV2PreviewState(config: ServerConfig): EngineV2PreviewState {
  try {
    const parsed: unknown = JSON.parse(readFileSync(statePath(config), "utf8"));
    if (
      !isRecord(parsed)
      || typeof parsed.enabled !== "boolean"
      || (parsed.chatRouting !== undefined && typeof parsed.chatRouting !== "boolean")
    ) {
      return { enabled: false, chatRouting: false };
    }
    return { enabled: parsed.enabled, chatRouting: parsed.chatRouting === true };
  } catch {
    return { enabled: false, chatRouting: false };
  }
}

export async function writeEngineV2PreviewState(
  config: ServerConfig,
  state: EngineV2PreviewState,
): Promise<void> {
  await mkdir(runtimeStorageDir(config), { recursive: true });
  await writeFile(statePath(config), `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

function exec(file: string, args: string[], options: { cwd?: string; timeout?: number } = {}): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(file, args, options, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

async function resolveBinary(config: ServerConfig): Promise<ResolvedBinary> {
  const selectedVersion = resolveOpencodeV2Version(config.opencodeV2?.version);
  if (config.opencodeV2?.bin) return { bin: config.opencodeV2.bin, source: "explicit" };
  // Mandatory hosts and explicit versions use only their binary or verified pin. PATH
  // and preview environment overrides must never downgrade the selected engine.
  if (config.engine === "v2" || config.opencodeV2?.version !== undefined) {
    return { bin: await installOpencodeV2Binary(join(runtimeStorageDir(config), "opencode-v2-verified"), selectedVersion), source: "cache" };
  }
  const override = process.env.OPENWORK_OPENCODE2_BIN?.trim();
  if (override) return { bin: override, source: "env" };

  let pathError = "not found";
  try {
    await exec("opencode2", ["--version"]);
    return { bin: "opencode2", source: "path" };
  } catch (error) {
    pathError = errorMessage(error);
  }

  try {
    const binary = await installOpencodeV2Binary(join(runtimeStorageDir(config), "opencode-v2-verified"), selectedVersion);
    return { bin: binary, source: "cache" };
  } catch (error) {
    throw new Error(
      `Unable to resolve OpenCode v2 (${pathError}; verified download: ${errorMessage(error)}). Set OPENWORK_OPENCODE2_BIN to a working opencode2 binary.`,
    );
  }
}

export function mapRuntimeProvidersToV2Specs(
  providerMap: Record<string, unknown>,
  storedCredentials: ReadonlyMap<string, string> = new Map(),
): { specs: OpencodeV2ProviderSpec[]; skippedProviderIds: string[] } {
  const specs: OpencodeV2ProviderSpec[] = [];
  const skippedProviderIds: string[] = [];

  for (const [id, value] of Object.entries(providerMap)) {
    if (!isRecord(value)) {
      skippedProviderIds.push(id);
      continue;
    }
    // Only built-in adapters: do not turn organization configuration into a
    // request to install an arbitrary runtime package.
    const packages: Record<string, string> = {
      "@ai-sdk/openai": "@opencode-ai/ai/providers/openai",
      "@ai-sdk/anthropic": "@opencode-ai/ai/providers/anthropic",
      "@openrouter/ai-sdk-provider": "@opencode-ai/ai/providers/openrouter",
      "@ai-sdk/openai-compatible": "@opencode-ai/ai/providers/openai-compatible",
    };
    const options = isRecord(value.options) ? value.options : {};
    // Catalog `api` metadata may use only the native adapter's trusted origin.
    // Custom destinations must use the existing explicit options.baseURL path.
    const explicitBaseUrl = typeof options.baseURL === "string" && options.baseURL.trim()
      ? options.baseURL : undefined;
    if (!explicitBaseUrl && value.api !== undefined) {
      const nativeOrigins: Record<string, string> = {
        "@ai-sdk/openai": "https://api.openai.com",
        "@ai-sdk/anthropic": "https://api.anthropic.com",
        "@openrouter/ai-sdk-provider": "https://openrouter.ai",
      };
      let trusted = false;
      try {
        const url = new URL(typeof value.api === "string" ? value.api : "");
        trusted = typeof value.npm === "string" && Object.hasOwn(nativeOrigins, value.npm)
          && url.origin === nativeOrigins[value.npm] && !url.username && !url.password;
      } catch { /* Invalid endpoint metadata is never mirrored. */ }
      if (!trusted) { skippedProviderIds.push(id); continue; }
    }
    const endpoint = explicitBaseUrl ?? value.api;
    const baseUrl = typeof endpoint === "string" && endpoint.trim() ? endpoint : undefined;
    const packageName = typeof value.npm === "string" && Object.hasOwn(packages, value.npm) ? packages[value.npm] : undefined;
    if ((value.npm !== undefined && !packageName)
      || (!baseUrl && (!packageName || value.npm === "@ai-sdk/openai-compatible"))) {
      skippedProviderIds.push(id);
      continue;
    }
    const { apiKey, baseURL, headers, ...settings } = options;
    const envNames = Array.isArray(value.env)
      ? value.env.filter((name): name is string => typeof name === "string") : [];
    const credentialName = selectPrimaryCredentialEnvName(envNames, storedCredentials.keys());
    const storedKey = credentialName ? storedCredentials.get(credentialName) : undefined;
    // Resolve only this provider's declared credential, never inherit the
    // server environment or copy unrelated secrets into the sidecar.
    const explicitKey = typeof apiKey === "string" && apiKey.trim() !== "" && !apiKey.includes("{env:") ? apiKey : undefined;
    const resolvedKey = explicitKey ?? storedKey;
    if (envNames.length > 0 && !resolvedKey) {
      skippedProviderIds.push(id);
      continue;
    }
    const models = isRecord(value.models)
      ? Object.entries(value.models)
        .map(([modelId, model]) => ({
          id: modelId,
          name: isRecord(model) && typeof model.name === "string" ? model.name : modelId,
          ...(isRecord(model) ? { config: model } : {}),
        }))
        .sort((left, right) => left.id.localeCompare(right.id))
      : [];
    specs.push({
      id,
      name: typeof value.name === "string" ? value.name : id,
      ...(baseUrl ? { baseUrl } : {}),
      ...(packageName ? { package: packageName } : {}),
      ...(Object.keys(settings).length ? { settings } : {}),
      ...(isRecord(headers) ? { headers } : {}),
      apiKey: resolvedKey ?? UNSET_API_KEY,
      models,
    });
  }

  specs.sort((left, right) => left.id.localeCompare(right.id));
  skippedProviderIds.sort((left, right) => left.localeCompare(right));
  return { specs, skippedProviderIds };
}

function catalogModelIds(payload: unknown, mirroredProviderIds: string[]): string[] {
  const mirrored = new Set(mirroredProviderIds);
  const ids = new Set<string>();

  function visit(value: unknown, withinMirroredProvider: boolean): void {
    if (Array.isArray(value)) {
      for (const entry of value) visit(entry, withinMirroredProvider);
      return;
    }
    if (!isRecord(value)) return;

    const providerId = typeof value.providerID === "string"
      ? value.providerID
      : typeof value.providerId === "string"
        ? value.providerId
        : undefined;
    const withinProvider = withinMirroredProvider || (providerId !== undefined && mirrored.has(providerId));
    if (withinProvider && typeof value.id === "string" && (providerId !== undefined || !mirrored.has(value.id))) ids.add(value.id);
    if (withinProvider && isRecord(value.models)) {
      for (const modelId of Object.keys(value.models)) ids.add(modelId);
    }
    for (const [key, child] of Object.entries(value)) {
      visit(child, withinProvider || mirrored.has(key));
    }
  }

  visit(payload, false);
  return [...ids].sort((left, right) => left.localeCompare(right));
}

/** Translate only fields supported by the pinned v2 MCP API. */
export function mapRuntimeMcpToV2(value: unknown): Record<string, unknown> | undefined {
  if (!isRecord(value)) return undefined;
  if (value.enabled === false || value.disabled === true) return undefined;
  const shared = {
    ...(typeof value.codemode === "boolean" ? { codemode: value.codemode } : {}),
    ...(typeof value.timeout === "number" && value.timeout > 0
      ? { timeout: { startup: value.timeout, catalog: value.timeout, execution: value.timeout } } : {}),
  };
  const strings = (input: unknown) => isRecord(input)
    ? Object.fromEntries(Object.entries(input).filter((entry): entry is [string, string] => typeof entry[1] === "string")) : {};
  if (value.type === "local" && Array.isArray(value.command)
    && value.command.length > 0 && value.command.every((part) => typeof part === "string" && part.trim())) {
    return { type: "local", command: value.command, environment: strings(value.environment),
      ...(typeof value.cwd === "string" ? { cwd: value.cwd } : {}), ...shared };
  }
  if (value.type !== "remote" || typeof value.url !== "string" || !/^https?:\/\//i.test(value.url)) return undefined;
  const oauth = isRecord(value.oauth) ? {
    ...(typeof value.oauth.clientId === "string" ? { client_id: value.oauth.clientId } : {}),
    ...(typeof value.oauth.clientSecret === "string" ? { client_secret: value.oauth.clientSecret } : {}),
    ...(typeof value.oauth.scope === "string" ? { scope: value.oauth.scope } : {}),
  } : value.oauth === false ? false : undefined;
  return { type: "remote", url: value.url, headers: strings(value.headers),
    ...(oauth === undefined ? {} : { oauth }), ...shared };
}

export function createEngineV2Preview(options: { config: ServerConfig; env?: Pick<EnvService, "list" | "onChange">; deferStart?: boolean }): EngineV2Preview {
  const { config } = options;
  const mandatory = config.engine === "v2";
  const rootDir = config.opencodeV2?.rootDir ?? join(runtimeStorageDir(config), "opencode-v2", "state");
  const workspaceDir = join(rootDir, "workspace");
  const initialState = mandatory ? { enabled: true, chatRouting: true }
    : resolveInitialEngineV2PreviewState(process.env, readEngineV2PreviewState(config));
  let enabled = initialState.enabled;
  let chatRouting = initialState.chatRouting === true;
  let allowRunning = true;
  let running = false;
  let version: string | undefined;
  let pid: number | undefined;
  let binSource: EngineV2PreviewStatus["binSource"];
  let mirroredProviderIds: string[] = [];
  let removedProviderIds: string[] = [];
  let skippedProviderIds: string[] = [];
  let currentCatalogModelIds: string[] = [];
  let lastMirroredAt: string | undefined;
  let lastError: string | undefined;
  let sidecar: ManagedOpencodeV2Server | undefined;
  let unsubscribe: (() => void) | undefined;
  let startPromise: Promise<void> | undefined;
  let mirrorInFlight: Promise<void> | undefined;
  let mirrorDirty = false;
  let mirrorError: unknown;
  const workspaceReadiness = new Map<string, Promise<void>>();
  let mirroredSpecs: OpencodeV2ProviderSpec[] = [];
  const workspaceMcp = new Map<string, Map<string, string>>();
  const mcpInFlight = new Map<string, Promise<void>>();
  const mcpWorkspaces = new Map<string, string>();
  const cloudSkillsRoot = join(rootDir, "cloud-skills");
  let skillAdmissions: Promise<unknown> = Promise.resolve();
  const cloudSkills = createCloudNativeSkillSync({
    root: cloudSkillsRoot,
    readCloudConfig: () => readGlobalRuntimeMcpConfig(config, OPENWORK_CLOUD_MCP_NAME),
    register: async (directory) => {
      const active = sidecar;
      if (!active) throw new CloudNativeSkillSyncError("cloud_skill_engine_unavailable", "OpenCode v2 is not running");
      await active.setSkills(directory ? [directory] : []);
    },
  });

  async function syncCloudSkills(): Promise<{ root: string; state: CloudNativeSkillState; failure?: CloudNativeSkillSyncCode }> {
    if (!sidecar) throw new CloudNativeSkillSyncError("cloud_skill_engine_unavailable", "OpenCode v2 is not running");
    try {
      return { root: cloudSkillsRoot, state: await cloudSkills.sync() };
    } catch (error) {
      if (!(error instanceof CloudNativeSkillSyncError)) throw error;
      // Skills fail closed, the conversation does not: sync() already cleared
      // and unregistered the root, so the caller admits without Cloud skills.
      return { root: cloudSkillsRoot, state: EMPTY_CLOUD_NATIVE_SKILL_STATE, failure: error.code };
    }
  }

  async function assertNativeSkillsScope(expectedScope: string | null): Promise<void> {
    if (!mandatory || expectedScope === null) return;
    if (!/^[0-9a-f]{64}$/.test(expectedScope)
      || expectedScope !== cloudNativeSkillScopeKey(await readGlobalRuntimeMcpConfig(config, "openwork-cloud"))) {
      // Never expose either the expected/current scope, endpoint or credential.
      throw new CloudNativeSkillSyncError("cloud_skill_scope_mismatch", "The selected Cloud skills belong to a different authorization scope");
    }
  }

  function withNativeSkills<T>(directory: string, use: (catalog: Awaited<ReturnType<typeof waitForNativeOpenWorkV2Skills>>, assertCurrent: () => Promise<void>) => Promise<T>, expectedScope: string | null = null): Promise<T> {
    const sync = cloudSkills;
    if (!sync) return Promise.reject(new Error("Cloud-native skills require a mandatory v2 host"));
    const pending = skillAdmissions.catch(() => undefined).then(async () => {
      for (let retry = 0; retry < 3; retry++) {
        // This is the caller's ingress expectation, never the account found
        // after waiting in this queue. A request bound to A cannot adopt B.
        await assertNativeSkillsScope(expectedScope);
        const active = sidecar;
        if (!allowRunning || !active?.isAlive()) throw new CloudNativeSkillSyncError("cloud_skill_engine_unavailable", "OpenCode v2 is not running");
        let state;
        try { state = await sync.sync(); } catch (error) {
          if (!(error instanceof CloudNativeSkillSyncError)) throw error;
          // Transport/auth failures clear files and registration first. Ordinary
          // chat can continue only after native confirms the empty Cloud set.
          state = EMPTY_CLOUD_NATIVE_SKILL_STATE;
        }
        await assertNativeSkillsScope(expectedScope);
        const generation = sync.generation();
        let catalog: Awaited<ReturnType<typeof waitForNativeOpenWorkV2Skills>>;
        try {
          catalog = await waitForNativeOpenWorkV2Skills(directory, async () => {
            // Direct daemon read, never the host /opencode2 proxy: no recursive
            // preparation and no refetch inside the native watcher poll.
            const result = await active.fetchJson("/api/skill", { directory, timeoutMs: 5_000 });
            if (result.status !== 200) throw new Error("Native skill catalog is unavailable");
            return result.json;
          }, { root: cloudSkillsRoot, state });
        } catch (error) {
          if (generation !== sync.generation()) continue;
          throw error;
        }
        await assertNativeSkillsScope(expectedScope);
        if (generation !== sync.generation()) continue;
        // Never retry the admitted operation, including an uncertain POST.
        return use(catalog, async () => {
          // Session ownership, permission and instruction work can await after
          // readiness. Recheck local auth scope immediately before forwarding,
          // without another Cloud fetch or replaying an uncertain operation.
          await sync.reconcileScope();
          await assertNativeSkillsScope(expectedScope);
          if (!allowRunning || generation !== sync.generation()) {
            throw new CloudNativeSkillSyncError("cloud_skill_sync_stale", "OpenWork Cloud skill authorization changed before admission");
          }
        });
      }
      throw new CloudNativeSkillSyncError("cloud_skill_sync_stale", "OpenWork Cloud configuration kept changing during skill preparation");
    });
    skillAdmissions = pending;
    return pending;
  }

  async function syncWorkspaceMcp(workspaceId: string, directory: string, forceNames?: string[]): Promise<void> {
    mcpWorkspaces.set(directory, workspaceId);
    // Serialize each location, then re-read authoritative state. A queued call
    // must not reuse a snapshot taken before a removal or credential update.
    const previous = mcpInFlight.get(directory);
    const pending = (async () => {
      if (previous) await previous.catch(() => undefined);
      const active = sidecar;
      if (!active?.isAlive()) throw new Error("OpenCode v2 is not running");
      const runtime = runtimeMcpMap(await readEffectiveRuntimeOpencodeConfig(config, workspaceId));
      const desired = new Map(Object.entries(runtime).flatMap(([name, value]) => {
        const mapped = mapRuntimeMcpToV2(value);
        return mapped ? [[name, mapped] as const] : [];
      }));
      const applied = workspaceMcp.get(directory) ?? new Map<string, string>();
      workspaceMcp.set(directory, applied);
      for (const name of forceNames ?? []) applied.set(name, "");
      let changed = false;
      // Remove first so a failed replacement cannot leave an old credential or
      // revoked tool active. Only touch registrations owned by this mirror.
      for (const [name, fingerprint] of applied) {
        if (desired.has(name) && JSON.stringify(desired.get(name)) === fingerprint) continue;
        const result = await active.fetchJson(`/api/mcp/${encodeURIComponent(name)}`, {
          method: "DELETE", directory, timeoutMs: 15_000,
        });
        if (result.status !== 204 && result.status !== 404) throw new Error(`OpenCode v2 MCP removal failed (${result.status})`);
        applied.delete(name);
        changed = true;
      }
      for (const [name, mcpConfig] of desired) {
        const fingerprint = JSON.stringify(mcpConfig);
        if (applied.get(name) === fingerprint) continue;
        const result = await active.fetchJson(`/api/mcp/${encodeURIComponent(name)}`, {
          method: "PUT", body: { config: mcpConfig }, directory, timeoutMs: 30_000,
        });
        if (result.status !== 204) throw new Error(`OpenCode v2 MCP registration failed (${result.status})`);
        applied.set(name, fingerprint);
        changed = true;
      }
      if (changed) {
        const deadline = Date.now() + 30_000;
        while (true) {
          const result = await active.fetchJson("/api/mcp", { directory, timeoutMs: 5_000 });
          const entries = isRecord(result.json) ? result.json.data : undefined;
          if (result.status !== 200 || !Array.isArray(entries)) throw new Error("OpenCode v2 MCP status is unavailable");
          const pending = [...desired.keys()].some((name) => {
            const entry = entries.find((entry) => isRecord(entry) && entry.name === name);
            return !isRecord(entry) || !isRecord(entry.status) || entry.status.status === "pending";
          });
          if (!pending) break;
          if (Date.now() >= deadline) {
            // Retry readiness on the next request rather than cache an
            // acknowledged registration as usable before its tools exist.
            throw new Error("OpenCode v2 MCP connections did not settle");
          }
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        // The pinned beta batches MCP ToolsChanged events for 100ms after
        // connection startup. Admission must follow that registry refresh,
        // not merely the PUT acknowledgement or connected status.
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    })();
    mcpInFlight.set(directory, pending);
    try { await pending; }
    catch (error) {
      // Retain ownership for removals, but never cache a failed readiness
      // attempt as an applied configuration.
      const applied = workspaceMcp.get(directory);
      if (applied) for (const name of applied.keys()) applied.set(name, "");
      throw error;
    }
    finally { if (mcpInFlight.get(directory) === pending) mcpInFlight.delete(directory); }
  }

  function status(): EngineV2PreviewStatus {
    return {
      enabled,
      chatRouting,
      running: running && sidecar?.isAlive() === true,
      ...(version === undefined ? {} : { version }),
      ...(pid === undefined ? {} : { pid }),
      ...(binSource === undefined ? {} : { binSource }),
      mirroredProviderIds: [...mirroredProviderIds],
      skippedProviderIds: [...skippedProviderIds],
      catalogModelIds: [...currentCatalogModelIds],
      ...(lastMirroredAt === undefined ? {} : { lastMirroredAt }),
      ...(lastError === undefined ? {} : { lastError }),
    };
  }

  async function mirrorProviders(): Promise<void> {
    const active = sidecar;
    if (!active) return;
    const providerMap = runtimeProviderMap(await readGlobalRuntimeOpencodeConfig(config));
    const credentials = new Map((await options.env?.list() ?? []).map((entry) => [entry.key, entry.value]));
    const mapped = mapRuntimeProvidersToV2Specs(providerMap, credentials);
    const nextMirroredProviderIds = mapped.specs.map((spec) => spec.id);
    await active.setProviders(mapped.specs);
    mirroredSpecs = mapped.specs;
    workspaceReadiness.clear();
    removedProviderIds = [...new Set([...removedProviderIds, ...mirroredProviderIds])]
      .filter((id) => !nextMirroredProviderIds.includes(id));
    mirroredProviderIds = nextMirroredProviderIds;
    skippedProviderIds = [...mapped.skippedProviderIds];
    lastMirroredAt = new Date().toISOString();
    const expectedModelIds = mapped.specs.flatMap((spec) => spec.models.map((model) => model.id));
    const deadline = Date.now() + CATALOG_MIRROR_TIMEOUT_MS;
    let catalog = await active.fetchJson("/api/model", { directory: workspaceDir });
    let nextCatalogModelIds = catalogModelIds(catalog.json, nextMirroredProviderIds);
    while (((mandatory && catalog.status !== 200) || expectedModelIds.some((modelId) => !nextCatalogModelIds.includes(modelId)))
      && allowRunning && active.isAlive() && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      catalog = await active.fetchJson("/api/model", { directory: workspaceDir });
      nextCatalogModelIds = catalogModelIds(catalog.json, nextMirroredProviderIds);
    }
    currentCatalogModelIds = nextCatalogModelIds;
    const missingModelIds = expectedModelIds.filter((modelId) => !nextCatalogModelIds.includes(modelId));
    const catalogMessage = isRecord(catalog.json) && typeof catalog.json.message === "string"
      ? ` ${catalog.json.message}`
      : "";
    lastError = missingModelIds.length === 0
      ? undefined
      : `catalog missing [${missingModelIds.join(", ")}] after ${CATALOG_MIRROR_TIMEOUT_MS}ms: ${catalog.status}${catalogMessage}`;
    if (mandatory && (catalog.status !== 200 || lastError)) {
      throw new Error(lastError ?? `OpenCode v2 catalog returned HTTP ${catalog.status}`);
    }
  }

  function scheduleMirror(): void {
    mirrorDirty = true;
    if (mirrorInFlight) return;
    mirrorInFlight = (async () => {
      try {
        while (mirrorDirty && allowRunning && sidecar) {
          mirrorDirty = false;
          try {
            await mirrorProviders();
            mirrorError = undefined;
          } catch (error) {
            mirrorError = error;
            lastError = errorMessage(error);
          }
        }
      } finally {
        mirrorInFlight = undefined;
        if (mirrorDirty && allowRunning && sidecar) scheduleMirror();
      }
    })();
    void mirrorInFlight;
  }

  async function refresh(): Promise<void> {
    if (!sidecar?.isAlive()) throw new Error("OpenCode v2 is not running");
    scheduleMirror();
    if (mirrorInFlight) await mirrorInFlight;
    if (mirrorError) throw mirrorError;
  }

  async function closeSidecar(): Promise<void> {
    const active = sidecar;
    workspaceReadiness.clear();
    workspaceMcp.clear();
    mcpWorkspaces.clear();
    if (!active) return;
    try {
      await active.close();
    } catch (error) {
      lastError = errorMessage(error);
      if (mandatory) throw error;
    }
    sidecar = undefined;
    running = false;
    version = undefined;
    pid = undefined;
  }

  async function startSidecar(): Promise<void> {
    const resolved = await resolveBinary(config);
    binSource = resolved.source;
    if (!enabled || !allowRunning) return;
    await mkdir(workspaceDir, { recursive: true });
    // No stale private files from an earlier process become visible at boot.
    await cloudSkills.reset();
    const opencodeModelsUrl = await resolveOpencodeModelsUrl({ env: config.opencodeV2?.env ?? process.env });
    const managed = await createManagedOpencodeV2Server({
      bin: resolved.bin,
      rootDir,
      cwd: mandatory ? workspaceDir : undefined,
      config: config.opencodeV2?.config,
      nativeSkills: mandatory,
      nativeCatalogMetadata: mandatory,
      bootTimeoutMs: config.opencodeV2?.bootTimeoutMs,
      expectedVersion: mandatory || config.opencodeV2?.version !== undefined ? resolveOpencodeV2Version(config.opencodeV2?.version) : undefined,
      env: {
        ...config.opencodeV2?.env,
        OPENCODE_MODELS_URL: opencodeModelsUrl,
        ...(mandatory ? {
          OPENWORK_SERVER_URL: `http://${config.host === "0.0.0.0" ? "127.0.0.1" : config.host}:${config.port}`,
          OPENWORK_SERVER_TOKEN: config.token,
        } : {}),
      },
      permissions: async () => executionRules((await readGlobalRuntimeOpencodeConfig(config)).managedPolicy?.execution),
    });
    sidecar = managed;
    if (!enabled || !allowRunning) {
      await closeSidecar();
      return;
    }
    try {
      const health = await managed.health();
      version = health.version;
      pid = health.pid;
      running = health.healthy;
      const unsubscribeConfig = onRuntimeOpencodeConfigWrite((writeConfig, workspaceId) => {
        if (runtimeDbPath(writeConfig) !== runtimeDbPath(config)) return;
        const global = isEngineGlobalRuntimeConfigId(workspaceId);
        if (global) scheduleMirror();
        if (global) void cloudSkills.reconcileScope().catch(() => {
          // No provider payload, URL, or credential-bearing error is logged.
          if (sidecar) lastError = "Cloud skill scope could not be cleared";
        });
        // Connections installed through OpenWork also update already-open
        // locations while a conversation is active. Request admission joins
        // the same serialized reconciliation rather than racing it.
        for (const [directory, id] of mcpWorkspaces) {
          if (global || id === workspaceId) void syncWorkspaceMcp(id, directory).catch((error) => {
            if (sidecar) lastError = `MCP: ${errorMessage(error)}`;
          });
        }
      });
      const unsubscribeEnv = options.env?.onChange(scheduleMirror);
      unsubscribe = () => { unsubscribeConfig(); unsubscribeEnv?.(); };
      scheduleMirror();
      if (mirrorInFlight) await mirrorInFlight;
      if (mandatory && mirrorError) throw mirrorError;
      if (mandatory) {
        await ensureWorkspaceReady(workspaceDir);
        for (const workspace of config.workspaces) {
          if (workspace.workspaceType === "local") await ensureWorkspaceReady(workspace.path);
        }
      }
      if (!enabled || !allowRunning) {
        await closeSidecar();
        return;
      }
    } catch (error) {
      unsubscribe?.();
      unsubscribe = undefined;
      try { await closeSidecar(); } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], "OpenCode v2 startup failed and cleanup was incomplete");
      }
      throw error;
    }
  }

  async function start(): Promise<void> {
    if (sidecar?.isAlive()) return;
    if (startPromise) {
      await startPromise;
      return;
    }
    const pending = startSidecar();
    startPromise = pending;
    try {
      await pending;
    } finally {
      if (startPromise === pending) startPromise = undefined;
    }
  }

  function recordStartError(error: unknown): void {
    running = false;
    lastError = mandatory ? errorMessage(error)
      : `${errorMessage(error)} Set OPENWORK_OPENCODE2_BIN to a working opencode2 binary to override resolution.`;
  }

  async function stopRuntime(): Promise<void> {
    allowRunning = false;
    unsubscribe?.();
    unsubscribe = undefined;
    mirrorDirty = false;
    if (startPromise) await startPromise.catch(() => undefined);
    if (mirrorInFlight) await mirrorInFlight;
    await Promise.allSettled([...mcpInFlight.values()]);
    if (cloudSkills) {
      await skillAdmissions.catch(() => undefined);
      try { await cloudSkills.invalidate(); } finally { await closeSidecar(); }
    } else await closeSidecar();
  }

  async function setEnabled(nextEnabled: boolean): Promise<EngineV2PreviewStatus> {
    if (mandatory) {
      if (!nextEnabled) throw new Error("OpenCode v2 is mandatory for this host");
      return status();
    }
    if (nextEnabled && enabled && running) return status();
    await writeEngineV2PreviewState(config, { enabled: nextEnabled, chatRouting });
    enabled = nextEnabled;
    if (!enabled) {
      await stopRuntime();
      return status();
    }
    allowRunning = true;
    lastError = undefined;
    // Fire and forget: binary resolution can install from npm and boot can take
    // tens of seconds, while renderer config requests time out after 10s. The
    // status endpoint reports progress and records failures via lastError.
    void start().catch(recordStartError);
    return status();
  }

  async function setChatRouting(nextChatRouting: boolean): Promise<EngineV2PreviewStatus> {
    if (mandatory) {
      if (!nextChatRouting) throw new Error("OpenCode v2 routing is mandatory for this host");
      return status();
    }
    await writeEngineV2PreviewState(config, { enabled, chatRouting: nextChatRouting });
    chatRouting = nextChatRouting;
    return status();
  }

  function connection(): { url: string; username: string; password: string } | undefined {
    if (!running || !sidecar?.isAlive()) return undefined;
    return { url: sidecar.url, username: sidecar.username, password: sidecar.password };
  }

  async function ensureWorkspaceReady(directory: string): Promise<void> {
    if (mirrorInFlight) await mirrorInFlight;
    if (mandatory && mirrorError) throw mirrorError;
    const active = sidecar;
    if (!active?.isAlive()) throw new Error("OpenCode v2 is not running");
    const existing = workspaceReadiness.get(directory);
    if (existing) return existing;
    // V2 discovers configuration asynchronously for each new location. Its
    // initial catalog can be empty even after the preview location is ready.
    const pending = (async () => {
      if (mandatory) {
        const activated = await active.fetchJson("/api/plugin/await-activation", { method: "POST", directory, timeoutMs: 30_000 });
        if (activated.status !== 204) throw new Error("OpenCode v2 plugin activation did not settle");
        const plugins = await active.fetchJson("/api/plugin", { directory, timeoutMs: 5_000 });
        const entries = isRecord(plugins.json) ? plugins.json.data : undefined;
        if (plugins.status !== 200 || !Array.isArray(entries)
          || entries.some((entry) => !isRecord(entry) || !isRecord(entry.state) || entry.state.status !== "active")) {
          throw new Error("OpenCode v2 has an inactive or failed configured plugin");
        }
      }
      const deadline = Date.now() + 8_000;
      do {
        const response = await active.fetchJson("/api/provider", { directory, timeoutMs: 5_000 });
        const payload = isRecord(response.json) ? response.json.data : undefined;
        if (response.status === 200 && Array.isArray(payload)
          && (!mandatory || removedProviderIds.every((id) => !payload.some((provider) => {
            if (!isRecord(provider) || provider.id !== id) return false;
            // A host-authored native provider may legitimately reappear after
            // its mirrored override is removed. Only accept that known source
            // when the native package and credential/base URL match it.
            const configured = isRecord(config.opencodeV2?.config?.providers) ? config.opencodeV2.config.providers[id] : undefined;
            const settings = isRecord(configured) && isRecord(configured.settings) ? configured.settings : undefined;
            const independent = isRecord(configured) && settings && typeof settings.apiKey === "string"
              && provider.package === configured.package && isRecord(provider.settings)
              && provider.settings.apiKey === settings.apiKey && provider.settings.baseURL === settings.baseURL;
            return !independent;
          })))
          && mirroredSpecs.every((spec) =>
          payload.some((provider) => isRecord(provider) && provider.id === spec.id
            && isRecord(provider.settings) && provider.settings.apiKey === spec.apiKey)
        )) return;
        await new Promise((resolve) => setTimeout(resolve, 100));
      } while (Date.now() < deadline);
      throw new Error("OpenCode v2 workspace provider configuration did not become ready");
    })();
    workspaceReadiness.set(directory, pending);
    try { await pending; } catch (error) {
      if (workspaceReadiness.get(directory) === pending) workspaceReadiness.delete(directory);
      throw error;
    }
  }

  async function stop(): Promise<void> {
    await stopRuntime();
  }

  async function startWhenReady(): Promise<void> {
    if (!enabled) return;
    if (mandatory) {
      try { await start(); } catch (error) { recordStartError(error); throw error; }
    } else void start().catch(recordStartError);
  }
  if (!options.deferStart) void startWhenReady().catch(recordStartError);
  return { start: startWhenReady, refresh,
    modelMetadata: (providerID, modelID) => {
      if (!mandatory || !running || !sidecar?.isAlive() || mirrorInFlight || mirrorError) return {};
      const model = mirroredSpecs.find((spec) => spec.id === providerID)?.models.find((model) => model.id === modelID);
      return model?.config ? nativeCatalogModelMetadata(model.config) : {};
    },
    request: (directory, path, init = {}) => {
      if (!sidecar?.isAlive()) throw new Error("OpenCode v2 is not running");
      return sidecar.fetchJson(path, { ...init, directory, timeoutMs: init.timeoutMs ?? 10_000 });
    },
    process: () => {
      const managed = sidecar;
      return { pid: managed?.childPid ?? null, isAlive: () => managed?.isAlive() === true };
    },
    status, setEnabled, setChatRouting, connection, ensureWorkspaceReady, syncWorkspaceMcp, syncCloudSkills, assertNativeSkillsScope, withNativeSkills, stop };
}
