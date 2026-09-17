import type { McpServer } from "@modelcontextprotocol/server"
import { legacyConfirmationAppHtml } from "@openwork/mcp-apps/legacy-confirmation"
import { pluginFlowPayloadSchema } from "@openwork/types/plugin-flow-app"
import { RESOURCE_MIME_TYPE, registerAppResource, registerAppTool } from "./mcp-app-v2.js"

export const PLUGIN_FLOW_APP_RESOURCE_URI = "ui://openwork/plugin-flow/v1/view.html"
export const PLUGIN_FLOW_TOOL_NAME = "plugin_flow"
export const PLUGIN_FLOW_APP_HTML = legacyConfirmationAppHtml

export function registerAgentPluginFlowApp(server: McpServer) {
  registerAgentPluginFlowResource(server)
  registerAppTool(server, PLUGIN_FLOW_TOOL_NAME, {
    title: "Legacy sharing result",
    description: "App-only compatibility formatter for received legacy sharing results. Does not grant access or attach a card to new operations.",
    inputSchema: pluginFlowPayloadSchema,
    outputSchema: pluginFlowPayloadSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    _meta: { ui: { resourceUri: PLUGIN_FLOW_APP_RESOURCE_URI, visibility: ["app"] } },
  }, async (input) => {
    const payload = pluginFlowPayloadSchema.parse(input)
    return { content: [{ type: "text", text: JSON.stringify(payload) }], structuredContent: payload }
  })
}

export function registerAgentPluginFlowResource(server: McpServer) {
  const meta = { ui: { csp: { connectDomains: [], resourceDomains: [], frameDomains: [], baseUriDomains: [] }, prefersBorder: true } }
  registerAppResource(server, "OpenWork Plugin Flow", PLUGIN_FLOW_APP_RESOURCE_URI, {
    description: "Read-only legacy sharing result renderer.",
    _meta: meta,
  }, async () => ({ contents: [{ uri: PLUGIN_FLOW_APP_RESOURCE_URI, mimeType: RESOURCE_MIME_TYPE, text: PLUGIN_FLOW_APP_HTML, _meta: meta }] }))
}
