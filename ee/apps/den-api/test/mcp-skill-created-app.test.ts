import { Client, InMemoryTransport } from "@modelcontextprotocol/client"
import { McpServer } from "@modelcontextprotocol/server"
import { expect, test } from "bun:test"
import { runInNewContext } from "node:vm"
import { registerAgentPluginFlowResource, PLUGIN_FLOW_APP_RESOURCE_URI } from "../src/mcp/plugin-flow-app.js"
import {
  CREATE_SKILL_TOOL_NAME,
  SKILL_CREATED_APP_RESOURCE_URI,
  SKILL_CREATED_APP_HTML,
  registerAgentSkillTools,
  skillCreatedPayloadSchema,
  UPDATE_SKILL_TOOL_NAME,
  type CreateSkillResult,
} from "../src/mcp/skill-created-app.js"
import {
  registerAgentWorkflowArtifactResource,
  workflowArtifactAppServerCapabilities,
  WORKFLOW_ARTIFACT_APP_RESOURCE_URI,
  WORKFLOW_ARTIFACT_APP_HTML,
} from "../src/mcp/workflow-artifact-app.js"

const payload = skillCreatedPayloadSchema.parse({
  schemaVersion: "1",
  name: "beautiful-tomatoes",
  pluginId: "plugin_tomatoes",
  skillId: "configObject_tomatoes",
  description: "Use beautiful tomatoes whenever the user says go.",
  libraryUrl: "https://app.openworklabs.com/dashboard/library/plugins/plugin_tomatoes",
})

const updatedPayload = skillCreatedPayloadSchema.parse({
  ...payload,
  mode: "updated",
  description: "Use beautiful tomatoes and cherry tomatoes when the user says go.",
})

type CreateSkill = Parameters<typeof registerAgentSkillTools>[0]["create"]
type UpdateSkill = NonNullable<Parameters<typeof registerAgentSkillTools>[0]["update"]>

async function withClient<T>(
  run: (client: Client) => Promise<T>,
  create: CreateSkill = async () => ({ ok: true, payload }),
  update: UpdateSkill = async () => ({ ok: true, payload: updatedPayload }),
): Promise<T> {
  const server = new McpServer(
    { name: "skill-created-test", version: "1.0.0" },
    { capabilities: workflowArtifactAppServerCapabilities },
  )
  registerAgentSkillTools({ server, create, update })
  registerAgentWorkflowArtifactResource(server)
  registerAgentPluginFlowResource(server)
  const client = new Client(
    { name: "skill-created-host-test", version: "1.0.0" },
    {
      capabilities: {
        extensions: {
          "io.modelcontextprotocol/ui": {
            mimeTypes: ["text/html;profile=mcp-app"],
          },
        },
      },
    },
  )
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  await client.connect(clientTransport)
  try {
    return await run(client)
  } finally {
    await client.close()
    await server.close()
  }
}

test("lists only existing skill CRUD tools with legacy bindings and exact historical resources", async () => {
  await withClient(async (client) => {
    const tools = await client.listTools()
    expect(tools.tools.map(tool => tool.name).sort()).toEqual([CREATE_SKILL_TOOL_NAME, UPDATE_SKILL_TOOL_NAME])
    for (const tool of tools.tools) {
      expect(tool._meta).toEqual({ ui: { resourceUri: SKILL_CREATED_APP_RESOURCE_URI, visibility: ["model", "app"] }, "ui/resourceUri": SKILL_CREATED_APP_RESOURCE_URI })
      expect(tool.outputSchema).toBeDefined()
      expect(tool.annotations?.readOnlyHint).toBe(false)
    }
    const resources = await client.listResources()
    expect(resources.resources.map(resource => resource.uri)).toEqual([SKILL_CREATED_APP_RESOURCE_URI, WORKFLOW_ARTIFACT_APP_RESOURCE_URI, PLUGIN_FLOW_APP_RESOURCE_URI])
    const workflow = await client.readResource({ uri: WORKFLOW_ARTIFACT_APP_RESOURCE_URI })
    expect(workflow.contents[0]).toMatchObject({ mimeType: "text/html;profile=mcp-app", text: WORKFLOW_ARTIFACT_APP_HTML })
    expect((await client.readResource({ uri: SKILL_CREATED_APP_RESOURCE_URI })).contents[0]).toMatchObject({ uri: SKILL_CREATED_APP_RESOURCE_URI, mimeType: "text/html;profile=mcp-app", text: SKILL_CREATED_APP_HTML, _meta: { ui: { csp: { connectDomains: [], resourceDomains: [], frameDomains: [], baseUriDomains: [] } } } })
    expect((await client.readResource({ uri: PLUGIN_FLOW_APP_RESOURCE_URI })).contents[0]).toMatchObject({ uri: PLUGIN_FLOW_APP_RESOURCE_URI, mimeType: "text/html;profile=mcp-app" })
  })
})

test("create_skill preserves structured content, text, and released-client metadata", async () => {
  const requests: Array<{ pluginName: string; skillMarkdown: string }> = []
  await withClient(async (client) => {
    const result = await client.callTool({
      name: CREATE_SKILL_TOOL_NAME,
      arguments: {
        pluginName: "Beautiful Tomatoes",
        skillMarkdown: "---\nname: beautiful-tomatoes\ndescription: Use beautiful tomatoes when the user says go.\n---\n\nUse beautiful tomatoes.",
      },
    })
    expect(result.isError).not.toBe(true)
    expect(skillCreatedPayloadSchema.parse(result.structuredContent)).toEqual(payload)
    const first = result.content[0]
    const fallback = first?.type === "text" ? first.text : ""
    expect(fallback).toContain("# Skill created: beautiful-tomatoes")
    expect(fallback).toContain("Plugin ID: plugin_tomatoes")
    expect(fallback).toContain("Skill ID: configObject_tomatoes")
    expect(fallback).not.toContain("🍅")
    expect(result._meta).toEqual({ schemaVersion: "1", pluginId: payload.pluginId, skillId: payload.skillId })
    expect((await client.readResource({ uri: SKILL_CREATED_APP_RESOURCE_URI })).contents[0]).toMatchObject({ text: SKILL_CREATED_APP_HTML })
  }, async (request): Promise<CreateSkillResult> => {
    requests.push(request)
    return { ok: true, payload }
  })
  expect(requests).toHaveLength(1)
  expect(requests[0]?.pluginName).toBe("Beautiful Tomatoes")
})

test("update_skill preserves write annotations and the original resource binding", async () => {
  await withClient(async (client) => {
    const tools = await client.listTools()
    const tool = tools.tools.find((candidate) => candidate.name === UPDATE_SKILL_TOOL_NAME)
    expect(tool).toBeDefined()
    expect(tool?._meta).toEqual({ ui: { resourceUri: SKILL_CREATED_APP_RESOURCE_URI, visibility: ["model", "app"] }, "ui/resourceUri": SKILL_CREATED_APP_RESOURCE_URI })
    expect(tool?.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false })
  })
})

test("update_skill returns updated-mode structured content and text fallback", async () => {
  const requests: Array<{ skillId: string; skillMarkdown: string; reason?: string }> = []
  await withClient(async (client) => {
    const result = await client.callTool({
      name: UPDATE_SKILL_TOOL_NAME,
      arguments: {
        skillId: "configObject_tomatoes",
        skillMarkdown: "---\nname: beautiful-tomatoes\ndescription: Use beautiful tomatoes and cherry tomatoes when the user says go.\n---\n\nUse tomatoes generously.",
        reason: "Add cherry tomatoes",
      },
    })
    expect(result.isError).not.toBe(true)
    expect(skillCreatedPayloadSchema.parse(result.structuredContent)).toEqual(updatedPayload)
    expect(result._meta).toEqual({ schemaVersion: "1", pluginId: payload.pluginId, skillId: payload.skillId })
    expect((await client.readResource({ uri: SKILL_CREATED_APP_RESOURCE_URI })).contents[0]).toMatchObject({ text: SKILL_CREATED_APP_HTML })
    const first = result.content[0]
    const fallback = first?.type === "text" ? first.text : ""
    expect(fallback).toContain("# Skill updated: beautiful-tomatoes")
    expect(fallback).toContain("Plugin ID: plugin_tomatoes")
  }, undefined, async (request): Promise<CreateSkillResult> => {
    requests.push(request)
    return { ok: true, payload: updatedPayload }
  })
  expect(requests).toHaveLength(1)
  expect(requests[0]?.reason).toBe("Add cherry tomatoes")
})

test("legacy skill resource emits readiness and safely renders current and historical payloads", () => {
  const output = { textContent: "No skill result received." }
  const sent: unknown[] = []
  const parent = { postMessage: (message: unknown) => sent.push(message) }
  let receive: (event: { source: unknown; data: unknown }) => void = () => { throw new Error("Missing listener") }
  const script = SKILL_CREATED_APP_HTML.split("<script>")[1]?.split("</script>")[0]
  if (!script) throw new Error("Missing script")
  runInNewContext(script, {
    URL,
    document: { getElementById: () => output },
    window: { parent, addEventListener: (_name: string, listener: typeof receive) => { receive = listener } },
  })
  expect(sent[0]).toMatchObject({ method: "ui/initialize" })
  receive({ source: parent, data: { jsonrpc: "2.0", id: "openwork-skill-created:init", result: {} } })
  expect(sent[1]).toMatchObject({ method: "ui/notifications/initialized" })
  const deliver = (params: unknown) => receive({ source: parent, data: { jsonrpc: "2.0", method: "ui/notifications/tool-result", params } })
  expect(output.textContent).toBe("No skill result received.")
  receive({ source: {}, data: { jsonrpc: "2.0", method: "ui/notifications/tool-result", params: { structuredContent: payload } } })
  expect(output.textContent).toBe("No skill result received.")
  deliver({ structuredContent: payload })
  expect(output.textContent).toContain("Skill created: " + payload.name)
  deliver({ structuredContent: updatedPayload })
  expect(output.textContent).toContain("Skill updated: " + payload.name)
  const historical = { ...payload, description: "<img src=x onerror=alert(1)>" }
  deliver({ content: [{ type: "text", text: JSON.stringify(historical) }] })
  expect(output.textContent).toContain(historical.description)
  for (const invalid of [{ ...payload, mode: "deleted" }, { ...payload, libraryUrl: "invalid" }, { ...payload, name: "" }, { ...payload, schemaVersion: "2" }]) {
    deliver({ structuredContent: invalid })
    expect(output.textContent).toBe("No skill result received.")
  }
  deliver({ isError: true, structuredContent: payload })
  expect(output.textContent).toBe("No skill result received.")
  expect(script).not.toMatch(/innerHTML|fetch\(|tools\/call|window\.open/)
})

test("keeps creation failures useful to clients without MCP Apps", async () => {
  await withClient(async (client) => {
    const result = await client.callTool({
      name: CREATE_SKILL_TOOL_NAME,
      arguments: {
        pluginName: "Beautiful Tomatoes",
        skillMarkdown: "---\nname: beautiful-tomatoes\ndescription: Use tomatoes.\n---\n\nUse tomatoes.",
      },
    })
    expect(result.isError).toBe(true)
    const first = result.content[0]
    expect(first?.type === "text" ? JSON.parse(first.text) : null).toEqual({
      error: "duplicate_plugin",
      message: "A Plugin with that name already exists.",
    })
    expect(result.structuredContent).toBeUndefined()
    expect(result._meta).toBeUndefined()
  }, async () => ({
    ok: false,
    error: "duplicate_plugin",
    message: "A Plugin with that name already exists.",
  }))
})
