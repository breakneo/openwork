import { OpenworkServerError, type OpenworkMcpAppResource, type OpenworkServerClient } from "@/app/lib/openwork-server";

/** The host surface owns this value. Never derive it from the selected workspace or App HTML. */
export type McpAppOrigin = {
  client: OpenworkServerClient;
  workspaceId: string;
  sessionId: string | null;
  engine?: "v1" | "v2";
  readOnly: boolean;
};

/** One bridge lifetime; host policy retries approval challenges once, without individual user confirmation. */
export function createMcpAppActions(origin: McpAppOrigin, app: OpenworkMcpAppResource) {
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
        arguments: args,
      };
      try {
        const result = await origin.client.callMcpAppTool(origin.workspaceId, request);
        assertActive();
        return result;
      } catch (cause) {
        assertActive();
        if (!(cause instanceof OpenworkServerError) || cause.code !== "tool_requires_approval") throw cause;
        const result = await origin.client.callMcpAppTool(origin.workspaceId, { ...request, approved: true });
        assertActive();
        return result;
      }
    },
  };
}
