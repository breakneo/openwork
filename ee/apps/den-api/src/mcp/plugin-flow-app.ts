import type { McpServer } from "@modelcontextprotocol/server"
import { pluginFlowPayloadSchema } from "@openwork/types/plugin-flow-app"
import { RESOURCE_MIME_TYPE, registerAppResource, registerAppTool } from "./mcp-app-v2.js"

export const PLUGIN_FLOW_APP_RESOURCE_URI = "ui://openwork/plugin-flow/v1/view.html"
export const PLUGIN_FLOW_TOOL_NAME = "plugin_flow"
export const PLUGIN_FLOW_APP_HTML = String.raw`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Sharing result</title>
<style>:root{color-scheme:light dark;font-family:var(--font-sans,system-ui,sans-serif);color:var(--color-text-primary,inherit);background:transparent}body{margin:0;padding:16px;font-size:13px;line-height:1.5}p{margin:0;white-space:pre-wrap;overflow-wrap:anywhere}</style></head>
<body><p id="result" role="status">No sharing result received.</p><script>
(function () {
  'use strict';
  var initId = 'openwork-plugin-flow:init';
  var output = document.getElementById('result');
  function record(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
  function nullableText(value, max) { return value === null || typeof value === 'string' && value.trim().length > 0 && value.trim().length <= max; }
  function valid(value) {
    return record(value) && value.schemaVersion === '1'
      && ['marketplace_plugin_added', 'plugin_access_granted', 'marketplace_access_granted'].includes(value.mode)
      && nullableText(value.pluginId, 160) && nullableText(value.marketplaceId, 160)
      && (value.recipient === null || record(value.recipient)
        && ['member', 'team', 'org_wide'].includes(value.recipient.kind)
        && nullableText(value.recipient.id, 160) && nullableText(value.recipient.role, 60));
  }
  function post(message) { window.parent.postMessage(message, '*'); }
  function render(result) {
    output.textContent = 'No sharing result received.';
    if (!record(result) || result.isError === true) return;
    var payload = result.structuredContent;
    if (!valid(payload) && Array.isArray(result.content)) {
      for (var item of result.content) {
        if (!record(item) || item.type !== 'text' || typeof item.text !== 'string') continue;
        try { var candidate = JSON.parse(item.text); if (valid(candidate)) { payload = candidate; break; } } catch {}
      }
    }
    if (!valid(payload)) return;
    var labels = { marketplace_plugin_added: 'Plugin added to marketplace', plugin_access_granted: 'Plugin access granted', marketplace_access_granted: 'Marketplace access granted' };
    var lines = [labels[payload.mode]];
    if (payload.pluginId !== null) lines.push('Plugin: ' + payload.pluginId);
    if (payload.marketplaceId !== null) lines.push('Marketplace: ' + payload.marketplaceId);
    if (payload.recipient !== null) {
      lines.push('Recipient: ' + payload.recipient.kind + (payload.recipient.id === null ? '' : ' ' + payload.recipient.id));
      if (payload.recipient.role !== null) lines.push('Role: ' + payload.recipient.role);
    }
    output.textContent = lines.join('\n');
  }
  window.addEventListener('message', function (event) {
    if (event.source !== window.parent || !record(event.data) || event.data.jsonrpc !== '2.0') return;
    var message = event.data;
    if (message.id === initId && record(message.result)) post({ jsonrpc: '2.0', method: 'ui/notifications/initialized' });
    if (message.method === 'ui/notifications/tool-result') render(message.params);
    if (message.method === 'ui/notifications/tool-cancelled') render(null);
    if (message.method === 'ui/resource-teardown' && message.id !== undefined) post({ jsonrpc: '2.0', id: message.id, result: {} });
  });
  post({ jsonrpc: '2.0', id: initId, method: 'ui/initialize', params: { appInfo: { name: 'OpenWork legacy sharing result', version: '1.0.0' }, appCapabilities: {}, protocolVersion: '2026-01-26' } });
}());
</script></body></html>`

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
