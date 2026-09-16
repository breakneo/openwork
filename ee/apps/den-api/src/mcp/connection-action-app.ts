import type { McpServer } from "@modelcontextprotocol/server"
import type { McpUiToolMeta } from "@modelcontextprotocol/ext-apps"
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js"
import { z } from "zod"
import { normalizeDenTypeId } from "@openwork-ee/utils/typeid"
import { connectionActionAppResourceUri, connectionActionIntentSchema, connectionActionPayloadSchema } from "@openwork/types/connection-action-app"
import { getExternalMcpConnection } from "../capability-sources/external-mcp-connections.js"
import { probeExternalConnectionStatus } from "./external-capabilities.js"
import { connectedConnectionActionPayload, connectionActionPayloadFromStatus, connectionActionTextFallback } from "./connection-action.js"
import { openworkYourConnectionsUrl } from "./connection-navigation.js"
import { RESOURCE_MIME_TYPE, registerAppResource, registerAppTool } from "./mcp-app-v2.js"

const inputSchema = z.object({ connectionId: z.string().trim().min(1).max(160) }).strict()
const intentInputSchema = inputSchema.extend({ action: z.enum(["authenticate", "skip"]) })
type Context = Omit<Parameters<typeof probeExternalConnectionStatus>[0], "connectionId">

export async function connectionActionToolResult(context: Context, input: z.infer<typeof inputSchema>, action?: "authenticate" | "skip"): Promise<CallToolResult> {
  const probe = await probeExternalConnectionStatus({ ...context, connectionId: input.connectionId })
  if (!probe.ok) return { isError: true, content: [{ type: "text", text: probe.message }] }
  const connection = probe.connected
    ? connectedConnectionActionPayload({ connectionId: probe.connection.id, connectionName: probe.connection.name })
    : connectionActionPayloadFromStatus(probe.status)
  if (action === "authenticate") {
    const source = await getExternalMcpConnection({
      organizationId: normalizeDenTypeId("organization", context.organizationId),
      connectionId: normalizeDenTypeId("externalMcpConnection", input.connectionId),
    })
    if (!source || source.authType !== "oauth" || source.credentialMode !== "per_member"
      || source.oauthIssuerReviewRequiredAt || (!probe.connected && (connection.actor !== "member"
        || !["connect", "reconnect"].includes(connection.action?.type ?? "")))) {
      return { isError: true, content: [{ type: "text", text: "This connection requires setup outside this App." }] }
    }
  }
  if (action) {
    const intent = connectionActionIntentSchema.parse({ schemaVersion: "1", kind: "connection_action_intent", action, connection })
    return { content: [{ type: "text", text: JSON.stringify(intent) }], structuredContent: intent }
  }
  return { content: [{ type: "text", text: connectionActionTextFallback(connection) }], structuredContent: connection }
}

export function connectionActionAppHtml(fallbackUrl: string) {
  return String.raw`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Connection</title><style>:root{color-scheme:light dark;font-family:var(--font-sans,system-ui,sans-serif);color:var(--color-text-primary,CanvasText)}body{margin:0;padding:12px;font-size:13px}main{display:flex;align-items:center;gap:10px;flex-wrap:wrap;min-height:40px}h1{font-size:13px;font-weight:500;flex:1;margin:0}button{font:inherit;padding:6px 12px;border:0;border-radius:999px;background:transparent;color:inherit;cursor:pointer}button:disabled{opacity:.5;cursor:default}#authenticate{background:var(--color-text-primary,CanvasText);color:var(--color-background-primary,Canvas)}#actions{display:flex;gap:8px}#mark{display:flex;align-items:center;justify-content:center;width:24px;height:24px}#mark img{width:20px;height:20px;object-fit:contain}#status:empty{display:none}</style></head><body><main><span id="mark" aria-hidden="true"></span><h1 id="title">Connection</h1><div id="actions"><button id="skip" disabled>Skip</button><button id="authenticate" disabled>Authenticate</button></div></main><p id="status" role="status"></p><script>
(function(){
'use strict';
var native=false, connection=null, busy=false, serial=0, pending={}, fallback=${JSON.stringify(fallbackUrl).replace(/</g, "\\u003c")};
var title=document.getElementById('title'), status=document.getElementById('status'), auth=document.getElementById('authenticate'), skip=document.getElementById('skip');
function record(v){return v!==null&&typeof v==='object'&&!Array.isArray(v);}
function post(v){window.parent.postMessage(v,'*');}
function request(method,params,done){var id='connection:'+ ++serial;pending[id]=done;post({jsonrpc:'2.0',id:id,method:method,params:params});}
function context(c){if(!record(c))return;native=record(c.experimental)&&c.experimental['openwork/connection-actions']===true;if(c.theme==='light'||c.theme==='dark')document.documentElement.style.colorScheme=c.theme;var vars=c.styles&&c.styles.variables;if(record(vars))Object.keys(vars).forEach(function(k){if(k.startsWith('--')&&typeof vars[k]==='string')document.documentElement.style.setProperty(k,vars[k]);});buttons();}
function member(){return connection&&connection.actor==='member'&&connection.action&&['connect','reconnect'].includes(connection.action.type);}
function buttons(){auth.disabled=busy||!connection||connection.state==='connected';skip.disabled=busy||!connection||connection.state==='connected';auth.textContent=native&&member()?'Authenticate':'Open connections';}
function render(r){if(!record(r))return;var c=r.structuredContent;if(record(c))c=c.connectionAction||c.connectionStatus||c;if(!record(c)||c.schemaVersion!=='1'||typeof c.connectionId!=='string'||typeof c.connectionName!=='string'){if(r.isError)status.textContent='Unable to check this connection.';return;}connection=c;title.textContent=c.state==='connected'?c.connectionName+' connected':member()?'Connect '+c.connectionName:c.connectionName+' needs setup';var mark=document.getElementById('mark');mark.textContent=c.connectionName.charAt(0);var slug={slack:'slack',notion:'notion',github:'github',linear:'linear',gmail:'gmail'}[c.connectionName.toLowerCase()];if(slug){var img=document.createElement('img');img.alt='';img.src='https://cdn.simpleicons.org/'+slug;img.onerror=function(){mark.textContent=c.connectionName.charAt(0);};mark.textContent='';mark.appendChild(img);}status.textContent='';buttons();}
function act(action){if(busy||!connection)return;if(!native||!member()){if(action==='skip'){status.textContent='Skipped';auth.disabled=true;skip.disabled=true;return;}request('ui/open-link',{url:fallback+'?connectionId='+encodeURIComponent(connection.connectionId)},function(r){status.textContent=r.error||(r.result&&r.result.isError)?'Unable to open connections.':'Complete setup in connections, then check again.';});return;}busy=true;status.textContent=action==='authenticate'?'Waiting for sign-in…':'Skipping…';buttons();request('tools/call',{name:'connection_action_intent',arguments:{connectionId:connection.connectionId,action:action}},function(r){busy=false;var result=r.result;var data=result&&result.structuredContent;if(r.error||!result||result.isError){status.textContent='Connection action did not complete.';buttons();return;}if(data&&['connected','skipped'].includes(data.outcome)){title.textContent=data.outcome==='connected'?connection.connectionName+' connected':'Skipped '+connection.connectionName;status.textContent='';auth.disabled=true;skip.disabled=true;}else{status.textContent='Connection action did not complete.';buttons();}});}
auth.addEventListener('click',function(){act('authenticate');});skip.addEventListener('click',function(){act('skip');});
window.addEventListener('message',function(e){if(e.source!==window.parent||!record(e.data)||e.data.jsonrpc!=='2.0')return;var m=e.data;if(m.id&&pending[m.id]){var done=pending[m.id];delete pending[m.id];done(m);return;}if(m.method==='ui/notifications/tool-result')render(m.params);if(m.method==='ui/notifications/host-context-changed')context(m.params);if(m.method==='ui/notifications/tool-cancelled'){busy=true;buttons();status.textContent='Cancelled';}if(m.method==='ui/resource-teardown'&&m.id!==undefined)post({jsonrpc:'2.0',id:m.id,result:{}});});
request('ui/initialize',{appInfo:{name:'OpenWork Connection',version:'2.0.0'},appCapabilities:{},protocolVersion:'2026-01-26'},function(r){if(r.result)context(r.result.hostContext);post({jsonrpc:'2.0',method:'ui/notifications/initialized'});});
}());</script></body></html>`
}

export function registerAgentConnectionActionApp(server: McpServer, context: Context) {
  const meta: { ui: McpUiToolMeta } = { ui: { resourceUri: connectionActionAppResourceUri, visibility: ["app"] } }
  const annotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  registerAppTool(server, "connection_action", {
    title: "Connection", description: "App-only authorized live connection status.", inputSchema,
    outputSchema: connectionActionPayloadSchema, annotations, _meta: meta,
  }, async input => connectionActionToolResult(context, input))
  registerAppTool(server, "connection_action_intent", {
    title: "Connection action", description: "App-only validated member intent. Does not start OAuth or modify credentials.",
    inputSchema: intentInputSchema, outputSchema: connectionActionIntentSchema,
    annotations: { ...annotations, readOnlyHint: false, idempotentHint: false }, _meta: meta,
  }, async input => connectionActionToolResult(context, input, input.action))
  const resourceMeta = { ui: { csp: { connectDomains: [], resourceDomains: ["https://cdn.simpleicons.org"], frameDomains: [], baseUriDomains: [] }, prefersBorder: true } }
  const fallback = new URL(openworkYourConnectionsUrl(""))
  fallback.search = ""
  registerAppResource(server, "OpenWork Connection", connectionActionAppResourceUri, { _meta: resourceMeta }, async () => ({
    contents: [{ uri: connectionActionAppResourceUri, mimeType: RESOURCE_MIME_TYPE, text: connectionActionAppHtml(fallback.toString()), _meta: resourceMeta }],
  }))
}
