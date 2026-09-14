import { OpenworkServerError, type OpenworkMcpAppResource, type OpenworkServerClient } from "@/app/lib/openwork-server";

/** The host surface owns this value. Never derive it from the selected workspace or App HTML. */
export type McpAppOrigin = {
  client: OpenworkServerClient;
  workspaceId: string;
  sessionId: string | null;
  engine?: "v1" | "v2";
  readOnly: boolean;
};

export type McpAppApprovalRequest = {
  serverName: string;
  toolName: string;
  arguments?: Record<string, unknown>;
};

export function snapshotMcpAppArguments(args?: Record<string, unknown>) {
  const snapshot = structuredClone(args);
  const seen = new WeakSet<object>();
  const freeze = (value: unknown) => {
    if (!value || typeof value !== "object" || seen.has(value)) return;
    seen.add(value);
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  };
  freeze(snapshot);
  return snapshot;
}

export function createMcpAppActions(
  origin: McpAppOrigin,
  app: OpenworkMcpAppResource,
  requestApproval: (request: McpAppApprovalRequest, signal: AbortSignal) => Promise<boolean> = async () => false,
) {
  const controller = new AbortController();
  let active = true;
  let pendingApproval = false;
  const assertActive = () => {
    if (!active) throw new Error("This App view has closed or changed. Reopen it before using its actions.");
    if (origin.readOnly) throw new Error("This view is read-only and cannot perform App actions.");
    if (!app.launchId) throw new Error("This App has no live launch context. Update OpenWork and reopen the App.");
  };
  return {
    dispose: () => { active = false; controller.abort(); },
    assertActive,
    callTool: async (name: string, args?: Record<string, unknown>) => {
      assertActive();
      const request = {
        launchId: app.launchId,
        sessionId: origin.sessionId,
        ...(origin.engine ? { engine: origin.engine } : {}),
        serverName: app.serverName,
        resourceUri: app.resourceUri,
        name,
        arguments: snapshotMcpAppArguments(args),
      };
      try {
        const result = await origin.client.callMcpAppTool(origin.workspaceId, request);
        assertActive();
        return result;
      } catch (cause) {
        assertActive();
        if (!(cause instanceof OpenworkServerError) || cause.code !== "tool_requires_approval") throw cause;
        if (pendingApproval) throw new Error("Another App action is awaiting approval.");
        pendingApproval = true;
        try {
          const allowed = await requestApproval({ serverName: request.serverName, toolName: name, arguments: request.arguments }, controller.signal);
          assertActive();
          if (!allowed) throw new Error("App action cancelled.");
        } finally {
          pendingApproval = false;
        }
        const result = await origin.client.callMcpAppTool(origin.workspaceId, { ...request, approved: true });
        assertActive();
        return result;
      }
    },
  };
}
