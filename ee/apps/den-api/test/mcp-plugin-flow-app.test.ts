import { afterAll, beforeAll, expect, mock, test } from "bun:test"
import { createDenTypeId } from "@openwork-ee/utils/typeid"
import { pluginFlowPayloadSchema } from "@openwork/types/plugin-flow-app"
import { Hono } from "hono"
import { readFile } from "node:fs/promises"
import { z } from "zod"
import type { CapabilityRegistryContext } from "../src/mcp/capability-registry.js"
import type { McpToolOperation } from "../src/mcp/catalog.js"

mock.module("../src/auth.js", () => ({
  auth: {},
  DEN_MCP_OPAQUE_ACCESS_TOKEN_PREFIX: "ow_mcp_at_",
  DEN_MCP_FIRST_PARTY_CLIENT_ID: "openwork-desktop",
  DEN_MCP_FIRST_PARTY_RESOURCES: ["http://127.0.0.1:8790/mcp/agent"],
  DEN_MCP_GRANT_ID_CLAIM: "https://openworklabs.com/grant_id",
  DEN_MCP_ORG_ID_CLAIM: "https://openworklabs.com/org_id",
  DEN_MCP_OAUTH_RESOURCE: "http://127.0.0.1:8790/mcp/agent",
  DEN_MCP_RESOURCE: "http://127.0.0.1:8790/mcp",
  DEN_MCP_RESOURCE_CLAIM: "https://openworklabs.com/resource",
  DEN_MCP_RESOURCES: ["http://127.0.0.1:8790/mcp"],
  DEN_MCP_TOKEN_USE_CLAIM: "https://openworklabs.com/token_use",
}))
afterAll(() => mock.restore())

let executeCapability: typeof import("../src/mcp/capability-registry.js")["executeCapability"]

beforeAll(async () => {
  process.env.DATABASE_URL ??= "mysql://root:password@127.0.0.1:3306/openwork_test"
  process.env.DEN_DB_ENCRYPTION_KEY ??= "x".repeat(32)
  process.env.BETTER_AUTH_SECRET ??= "y".repeat(32)
  process.env.BETTER_AUTH_URL ??= "http://127.0.0.1:8790"
  process.env.DEN_API_PUBLIC_URL ??= "http://127.0.0.1:8790"
  executeCapability = (await import("../src/mcp/capability-registry.js")).executeCapability
})

function context(app: Hono, operation: McpToolOperation): CapabilityRegistryContext {
  const organizationId = createDenTypeId("organization")
  return {
    app,
    env: undefined,
    catalog: [operation],
    principal: {
      userId: createDenTypeId("user"),
      organizationId,
      scopes: new Set(["mcp:read", "mcp:write"]),
      payload: {},
    },
    organizationId,
    member: { orgMembershipId: createDenTypeId("member"), teamIds: [] },
    redirectUriBase: "http://127.0.0.1:8790",
    generatedArtifactViewsEnabled: false,
    externalMcpConnectionsEnabled: false,
    remoteSessionsEnabled: false,
    resolvePlatformAdmin: async () => false,
    resolveNamespaceContext: async () => ({
      nativeProviderEntries: [],
      externalMcpConnections: [],
      codemodeNativeProviderEntries: [],
      codemodeExternalMcpConnections: [],
      namespaces: { native: new Map(), externalMcp: new Map() },
    }),
  }
}

const sharingOperations = [
  { name: "postMarketplacesPlugins", path: "/v1/marketplaces/{marketplaceId}/plugins", params: { marketplaceId: "mkt_fixture" }, body: { pluginId: "plg_fixture" } },
  { name: "postPluginsAccess", path: "/v1/plugins/{pluginId}/access", params: { pluginId: "plg_fixture" }, body: { orgMembershipId: "om_fixture", role: "viewer" } },
  { name: "postPluginsAccess", path: "/v1/plugins/{pluginId}/access", params: { pluginId: "plg_fixture" }, body: { teamId: "tem_fixture", role: "editor" } },
  { name: "postPluginsAccess", path: "/v1/plugins/{pluginId}/access", params: { pluginId: "plg_fixture" }, body: { orgWide: true, role: "viewer" } },
  { name: "postMarketplacesAccess", path: "/v1/marketplaces/{marketplaceId}/access", params: { marketplaceId: "mkt_fixture" }, body: { teamId: "tem_fixture", role: "manager" } },
  { name: "postPlugins", path: "/v1/plugins", params: {}, body: { name: "Fixture" } },
]

test.each(sharingOperations)("$name preserves the ordinary write response without a confirmation App", async (fixture) => {
  const app = new Hono()
  const requests: Array<{ path: string; body: unknown }> = []
  let forbidden = false
  const response = { id: "grant_fixture", stored: fixture.body }
  app.post("*", async (c) => {
    requests.push({ path: c.req.path, body: await c.req.json() })
    return forbidden ? c.json({ error: "forbidden" }, 403) : c.json(response, 201)
  })
  const operation: McpToolOperation = { name: fixture.name, method: "POST", path: fixture.path, operation: {}, inputSchema: z.object({}) }
  const ctx = context(app, operation)
  const input = { name: fixture.name, path: JSON.stringify(fixture.params), body: JSON.stringify(fixture.body) }
  const result = await executeCapability(ctx, input)
  expect(result).toEqual({ isError: false, content: [{ type: "text", text: JSON.stringify(response, null, 2) }] })
  expect(result._meta).toBeUndefined()
  expect(result.structuredContent).toBeUndefined()
  expect(requests).toEqual([{
    path: fixture.path.replace(/\{[^}]+\}/g, () => Object.values(fixture.params)[0] ?? ""),
    body: fixture.body,
  }])

  forbidden = true
  const failure = await executeCapability(ctx, input)
  expect(failure).toEqual({ isError: true, content: [{ type: "text", text: JSON.stringify({ error: "forbidden" }, null, 2) }] })
  ctx.principal.scopes.delete("mcp:write")
  const denied = await executeCapability(ctx, input)
  expect(denied.isError).toBe(true)
  expect(JSON.stringify(denied.content)).toContain("insufficient_mcp_scope")
  expect(denied._meta).toBeUndefined()
  expect(requests).toHaveLength(2)
})

test("agent registration has no plugin confirmation tool, resource, or result attachment", async () => {
  const agent = await readFile(new URL("../src/mcp/agent.ts", import.meta.url), "utf8")
  const registry = await readFile(new URL("../src/mcp/capability-registry.ts", import.meta.url), "utf8")
  expect(agent).not.toContain("registerAgentPluginFlow")
  expect(agent).not.toContain("plugin-flow-app")
  expect(agent).not.toContain('"plugin_flow"')
  expect(registry).not.toContain("attachPluginFlowCard")
  expect(registry).not.toContain("plugin-flow-app")
})

test("historical confirmation payloads remain parseable without a resource implementation", () => {
  const modes: Array<z.infer<typeof pluginFlowPayloadSchema>["mode"]> = ["marketplace_plugin_added", "plugin_access_granted", "marketplace_access_granted"]
  for (const mode of modes) {
    expect(pluginFlowPayloadSchema.parse({
      schemaVersion: "1",
      mode,
      pluginId: "plg_fixture",
      marketplaceId: "mkt_fixture",
      recipient: { kind: "member", id: "om_fixture", role: "viewer" },
    }).mode).toBe(mode)
  }
})
