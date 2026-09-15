import type { OpenworkMcpAppResource } from "@/app/lib/openwork-server";
import { createDashboardTileCacheStore, DASHBOARD_TILE_CACHE_STORAGE_PREFIX } from "@/app/lib/dashboard-cache-storage";
import type { PreservedMcpAppResult } from "@/components/chat/mcp-app-frame";

const MAX_CACHE_AGE_MS = 24 * 60 * 60 * 1_000;
const MAX_SCOPE_CACHE_BYTES = 3_000_000;
export const DASHBOARD_AUTO_REFRESH_INTERVAL_MS = 5 * 60 * 1_000;

export type DashboardTileCache = {
  argumentsSignature?: string;
  cachedAt: number;
  workspaceId: string;
  app: OpenworkMcpAppResource;
  result: PreservedMcpAppResult;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function parseApp(value: unknown): OpenworkMcpAppResource | null {
  if (!isRecord(value) || !isRecord(value.csp)) return null;
  if (
    typeof value.serverName !== "string"
    || typeof value.toolName !== "string"
    || typeof value.resourceUri !== "string"
    || typeof value.html !== "string"
    || typeof value.prefersBorder !== "boolean"
    || !isStringArray(value.csp.connectDomains)
    || !isStringArray(value.csp.resourceDomains)
    || !isStringArray(value.csp.frameDomains)
    || !isStringArray(value.csp.baseUriDomains)
  ) return null;
  return {
    serverName: value.serverName,
    toolName: value.toolName,
    resourceUri: value.resourceUri,
    html: value.html,
    prefersBorder: value.prefersBorder,
    csp: {
      connectDomains: value.csp.connectDomains,
      resourceDomains: value.csp.resourceDomains,
      frameDomains: value.csp.frameDomains,
      baseUriDomains: value.csp.baseUriDomains,
    },
  };
}

function parseResult(value: unknown): PreservedMcpAppResult | null {
  if (!isRecord(value) || !Array.isArray(value.content) || !value.content.every(isRecord)) return null;
  if (value.structuredContent !== undefined && !isRecord(value.structuredContent)) return null;
  if (value._meta !== undefined && !isRecord(value._meta)) return null;
  return {
    content: value.content,
    ...(typeof value.isError === "boolean" ? { isError: value.isError } : {}),
    ...(value.structuredContent ? { structuredContent: value.structuredContent } : {}),
    ...(value._meta ? { _meta: value._meta } : {}),
  };
}

function parseCache(value: unknown, now: number): DashboardTileCache | null {
  if (!isRecord(value) || typeof value.cachedAt !== "number" || !Number.isFinite(value.cachedAt)) return null;
  if (typeof value.workspaceId !== "string" || !value.workspaceId.trim()) return null;
  if (value.cachedAt <= 0 || now - value.cachedAt > MAX_CACHE_AGE_MS) return null;
  const app = parseApp(value.app);
  const result = parseResult(value.result);
  return app && result ? {
    cachedAt: value.cachedAt, workspaceId: value.workspaceId, app, result,
    ...(typeof value.argumentsSignature === "string" ? { argumentsSignature: value.argumentsSignature } : {}),
  } : null;
}

function parseScope(value: unknown, now: number): Map<string, DashboardTileCache> {
  const scope = new Map<string, DashboardTileCache>();
  if (!isRecord(value)) return scope;
  for (const [entryId, entry] of Object.entries(value)) {
    const cache = parseCache(entry, now);
    if (cache) scope.set(entryId, cache);
  }
  return scope;
}

function serializeScope(scope: Map<string, DashboardTileCache>, now: number): string | null {
  const entries: Array<{ entryId: string; serialized: string }> = [];
  let size = 2;
  for (const [entryId, value] of [...scope].sort((left, right) => left[1].cachedAt - right[1].cachedAt)) {
    const cache = parseCache(value, now);
    if (!cache) {
      scope.delete(entryId);
      continue;
    }
    let serialized: string;
    try {
      serialized = `${JSON.stringify(entryId)}:${JSON.stringify(cache)}`;
    } catch {
      scope.delete(entryId);
      continue;
    }
    if (serialized.length + 2 > MAX_SCOPE_CACHE_BYTES) {
      scope.delete(entryId);
      continue;
    }
    scope.set(entryId, cache);
    size += serialized.length + (entries.length > 0 ? 1 : 0);
    entries.push({ entryId, serialized });
  }
  while (size > MAX_SCOPE_CACHE_BYTES) {
    const oldest = entries.shift();
    if (!oldest) break;
    size -= oldest.serialized.length + (entries.length > 0 ? 1 : 0);
    scope.delete(oldest.entryId);
  }
  return entries.length > 0 ? `{${entries.map((entry) => entry.serialized).join(",")}}` : null;
}

const cacheStore = createDashboardTileCacheStore(parseScope, serializeScope);

export function dashboardTileCacheScopeKey(userId: string | null, organizationId: string | null): string {
  return `${DASHBOARD_TILE_CACHE_STORAGE_PREFIX}.${userId?.trim() || "local"}.${organizationId?.trim() || "none"}`;
}

export function dashboardTileRunsAutomatically(
  requiresApproval: boolean,
  autoLaunchEnabled: boolean,
  launchApproved: boolean,
  organizationAutoLaunch: boolean,
): boolean {
  return organizationAutoLaunch || (!requiresApproval && autoLaunchEnabled && !launchApproved);
}

/** Admin policy is an independent server-authored approval for this managed element. */
export function dashboardTileLaunchIsApproved(
  organizationAutoLaunch: boolean,
  memberApproved: boolean,
): boolean {
  return organizationAutoLaunch || memberApproved;
}

export function shouldAutoRefreshDashboardTile(input: {
  visible: boolean;
  refreshing: boolean;
  lastRefreshAt: number;
  now?: number;
}): boolean {
  const now = input.now ?? Date.now();
  return input.visible
    && !input.refreshing
    && now - input.lastRefreshAt >= DASHBOARD_AUTO_REFRESH_INTERVAL_MS;
}

export function readDashboardTileCache(
  scopeKey: string,
  entryId: string,
  now = Date.now(),
): DashboardTileCache | null {
  const scope = cacheStore.read(scopeKey, now);
  const cache = scope?.get(entryId);
  if (!scope || !cache) return null;
  if (now - cache.cachedAt > MAX_CACHE_AGE_MS) {
    scope.delete(entryId);
    cacheStore.schedule(scopeKey);
    return null;
  }
  return cache;
}

export function writeDashboardTileCache(
  scopeKey: string,
  entryId: string,
  cache: DashboardTileCache,
): void {
  const next = parseCache(cache, Date.now());
  if (!next) return;
  const scope = cacheStore.read(scopeKey);
  if (!scope) return;
  scope.set(entryId, next);
  cacheStore.schedule(scopeKey);
}

export function removeDashboardTileCache(scopeKey: string, entryId: string): void {
  const scope = cacheStore.read(scopeKey);
  if (!scope) return;
  scope.delete(entryId);
  cacheStore.schedule(scopeKey);
}
