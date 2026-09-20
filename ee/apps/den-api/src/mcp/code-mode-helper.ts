import { listExternalMcpTools } from "../capability-sources/external-mcp-client-runtime.js"
import { isToolDisabled } from "../capability-sources/external-mcp-tool-policy.js"
import { externalMcpAppResourceUri } from "./external-capabilities.js"
import { parseRemoteSessionCapabilityName } from "./remote-session-capabilities.js"
import type { CapabilityRegistryContext } from "./capability-registry.js"

/** A presentation helper, never a second generic execution entry point. */
export async function isCodeModeHelperCapability(ctx: CapabilityRegistryContext, name: string): Promise<boolean> {
  if (parseRemoteSessionCapabilityName(name)) return ctx.remoteSessionsEnabled
  const match = /^mcp:([^:]+):(.+)$/.exec(name)
  if (!match || !ctx.externalMcpConnectionsEnabled) return false
  if (match[2] === "*") return true // Status execution reauthorizes membership and grants.
  const namespaces = await ctx.resolveNamespaceContext()
  const connection = namespaces.codemodeExternalMcpConnections.find((entry) => entry.id === match[1])
  if (!connection || !ctx.member) return false
  const tools = await listExternalMcpTools(
    connection,
    `${ctx.redirectUriBase}/v1/mcp-connections/${encodeURIComponent(connection.id)}/connect/callback`,
    connection.credentialMode === "per_member" ? { orgMembershipId: ctx.member.orgMembershipId } : undefined,
  )
  return tools.some((tool) => tool.name === match[2]
    && !isToolDisabled(connection.toolPolicy, tool.name)
    && externalMcpAppResourceUri(tool) !== null)
}
