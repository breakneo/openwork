import type { CallToolResult, McpServer } from "@modelcontextprotocol/server"
import {
  skillCreatedPayloadSchema,
  type SkillCreatedPayload,
} from "@openwork/types/skill-created-app"
import { z } from "zod"
import { RESOURCE_MIME_TYPE, registerAppResource, registerAppTool } from "./mcp-app-v2.js"

export { skillCreatedPayloadSchema } from "@openwork/types/skill-created-app"

export const SKILL_CREATED_APP_RESOURCE_URI = "ui://openwork/skill-created/v1/view.html"
export const SKILL_CREATED_APP_HTML = String.raw`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Skill result</title>
<style>:root{color-scheme:light dark;font-family:var(--font-sans,system-ui,sans-serif);color:var(--color-text-primary,inherit);background:transparent}body{margin:0;padding:16px;font-size:13px;line-height:1.5}p{margin:0;white-space:pre-wrap;overflow-wrap:anywhere}</style></head>
<body><p id="result" role="status">No skill result received.</p><script>
(function () {
  'use strict';
  var initId = 'openwork-skill-created:init';
  var output = document.getElementById('result');
  function record(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
  function text(value, max) { return typeof value === 'string' && value.trim().length > 0 && value.trim().length <= max; }
  function url(value) {
    if (value === null) return true;
    if (typeof value !== 'string') return false;
    try { new URL(value); return true; } catch { return false; }
  }
  function valid(value) {
    return record(value) && value.schemaVersion === '1'
      && (value.mode === undefined || value.mode === 'created' || value.mode === 'updated')
      && text(value.name, 255) && text(value.pluginId, 160) && text(value.skillId, 160)
      && text(value.description, 2000) && url(value.libraryUrl);
  }
  function post(message) { window.parent.postMessage(message, '*'); }
  function render(result) {
    output.textContent = 'No skill result received.';
    if (!record(result) || result.isError === true) return;
    var payload = result.structuredContent;
    if (!valid(payload) && Array.isArray(result.content)) {
      for (var item of result.content) {
        if (!record(item) || item.type !== 'text' || typeof item.text !== 'string') continue;
        try { var candidate = JSON.parse(item.text); if (valid(candidate)) { payload = candidate; break; } } catch {}
      }
    }
    if (!valid(payload)) return;
    var lines = ['Skill ' + (payload.mode === 'updated' ? 'updated: ' : 'created: ') + payload.name, payload.description, 'Plugin: ' + payload.pluginId, 'Skill: ' + payload.skillId];
    if (payload.libraryUrl !== null) lines.push('Library: ' + payload.libraryUrl);
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
  post({ jsonrpc: '2.0', id: initId, method: 'ui/initialize', params: { appInfo: { name: 'OpenWork legacy skill result', version: '1.0.0' }, appCapabilities: {}, protocolVersion: '2026-01-26' } });
}());
</script></body></html>`

export const CREATE_SKILL_TOOL_NAME = "create_skill"
export const UPDATE_SKILL_TOOL_NAME = "update_skill"

export type CreateSkillResult =
  | { ok: true; payload: SkillCreatedPayload }
  | { ok: false; error: string; message: string }

export function skillCreatedTextFallback(payload: SkillCreatedPayload): string {
  return [
    `# Skill ${payload.mode === "updated" ? "updated" : "created"}: ${payload.name}`,
    payload.description,
    `Plugin ID: ${payload.pluginId}`,
    `Skill ID: ${payload.skillId}`,
    payload.libraryUrl ? `Library: ${payload.libraryUrl}` : null,
  ].filter((line): line is string => line !== null).join("\n")
}

function skillSavedToolResult(result: CreateSkillResult): CallToolResult {
  if (!result.ok) {
    return {
      isError: true,
      content: [{
        type: "text",
        text: JSON.stringify({ error: result.error, message: result.message }),
      }],
    }
  }
  const payload = skillCreatedPayloadSchema.parse(result.payload)
  return {
    content: [{ type: "text", text: skillCreatedTextFallback(payload) }],
    structuredContent: payload,
    _meta: { schemaVersion: payload.schemaVersion, pluginId: payload.pluginId, skillId: payload.skillId },
  }
}

export function registerAgentSkillCreatedResource(server: McpServer) {
  const meta = { ui: { csp: { connectDomains: [], resourceDomains: [], frameDomains: [], baseUriDomains: [] }, prefersBorder: true } }
  registerAppResource(server, "OpenWork Skill Created", SKILL_CREATED_APP_RESOURCE_URI, {
    description: "Read-only legacy skill creation and update result renderer.",
    _meta: meta,
  }, async () => ({ contents: [{ uri: SKILL_CREATED_APP_RESOURCE_URI, mimeType: RESOURCE_MIME_TYPE, text: SKILL_CREATED_APP_HTML, _meta: meta }] }))
}

export function registerAgentSkillTools(input: {
  server: McpServer
  create: (request: { pluginName: string; skillMarkdown: string }) => Promise<CreateSkillResult>
  update?: (request: { skillId: string; skillMarkdown: string; reason?: string }) => Promise<CreateSkillResult>
}) {
  registerAgentSkillCreatedResource(input.server)
  registerAppTool(
    input.server,
    CREATE_SKILL_TOOL_NAME,
    {
      title: "Create skill",
      description: [
        "Create one private OpenWork Cloud skill in a new Plugin.",
        "Pass a complete SKILL.md with valid frontmatter and instructions.",
        "The skill is immediately available to its creator; this does not publish it to a Marketplace or share it.",
        "Returns the saved skill details and a text confirmation.",
      ].join(" "),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
      inputSchema: z.object({
        pluginName: z.string().trim().min(1).max(255).describe("Display name for the new Plugin."),
        skillMarkdown: z.string().trim().min(1).max(1_048_576).describe("Complete SKILL.md source, including frontmatter and instructions."),
      }),
      outputSchema: skillCreatedPayloadSchema,
      _meta: { ui: { resourceUri: SKILL_CREATED_APP_RESOURCE_URI, visibility: ["model", "app"] } },
    },
    async ({ pluginName, skillMarkdown }) => skillSavedToolResult(await input.create({ pluginName, skillMarkdown })),
  )
  if (!input.update) return
  const update = input.update
  registerAppTool(
    input.server,
    UPDATE_SKILL_TOOL_NAME,
    {
      title: "Update skill",
      description: [
        "Update one existing OpenWork Cloud skill by creating a new immutable version, without creating a duplicate Plugin.",
        "Pass the skill's config object id and the complete replacement SKILL.md.",
        "Returns the saved skill details and a text confirmation.",
      ].join(" "),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
      inputSchema: z.object({
        skillId: z.string().trim().min(1).max(160).describe("The existing skill's config object id (cob_…)."),
        skillMarkdown: z.string().trim().min(1).max(1_048_576).describe("Complete replacement SKILL.md source, including frontmatter and instructions."),
        reason: z.string().trim().min(1).max(255).optional().describe("Optional short reason recorded on the new version."),
      }),
      outputSchema: skillCreatedPayloadSchema,
      _meta: { ui: { resourceUri: SKILL_CREATED_APP_RESOURCE_URI, visibility: ["model", "app"] } },
    },
    async ({ skillId, skillMarkdown, reason }) => skillSavedToolResult(await update({ skillId, skillMarkdown, reason })),
  )
}
