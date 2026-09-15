import type { OpenworkMcpAppResource, OpenworkServerClient } from "@/app/lib/openwork-server";

/** The host surface owns this value. Never derive it from the selected workspace or App HTML. */
export type McpAppOrigin = {
  client: OpenworkServerClient;
  workspaceId: string;
  sessionId: string | null;
  engine?: "v1" | "v2";
  readOnly: boolean;
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
) {
  let active = true;
  const assertActive = () => {
    if (!active) throw new Error("This App view has closed or changed. Reopen it before using its actions.");
    if (origin.readOnly) throw new Error("This view is read-only and cannot perform App actions.");
    if (!app.launchId) throw new Error("This App has no live launch context. Update OpenWork and reopen the App.");
  };
  return {
    dispose: () => { active = false; },
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
        // The connected App owns its action controls, including background calls.
        // This selects the authenticated collaborator path; live launch, same-server
        // and organization permission checks are still enforced by the server.
        approved: true,
      };
      try {
        const result = await origin.client.callMcpAppTool(origin.workspaceId, request);
        assertActive();
        return result;
      } catch (cause) {
        assertActive();
        // Never retry an action whose outcome may already have taken effect.
        throw cause;
      }
    },
  };
}
