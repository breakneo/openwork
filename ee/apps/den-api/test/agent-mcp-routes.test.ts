import { afterEach, beforeAll, describe, expect, mock, spyOn, test } from "bun:test"
import { Hono } from "hono"

mock.module("../src/auth.js", () => ({
  auth: {},
  DEN_MCP_OPAQUE_ACCESS_TOKEN_PREFIX: "ow_mcp_at_",
  DEN_MCP_FIRST_PARTY_CLIENT_ID: "openwork-desktop",
  DEN_MCP_FIRST_PARTY_RESOURCES: ["http://127.0.0.1:8790/mcp", "http://127.0.0.1:8790/mcp/agent", "http://127.0.0.1:8790/mcp/admin"],
  DEN_MCP_GRANT_ID_CLAIM: "https://openworklabs.com/grant_id",
  DEN_MCP_ORG_ID_CLAIM: "https://openworklabs.com/org_id",
  DEN_MCP_OAUTH_RESOURCE: "http://127.0.0.1:8790/mcp/agent",
  DEN_MCP_RESOURCE: "http://127.0.0.1:8790/mcp",
  DEN_MCP_RESOURCE_CLAIM: "https://openworklabs.com/resource",
  DEN_MCP_RESOURCES: ["http://127.0.0.1:8790/mcp"],
  DEN_MCP_TOKEN_USE_CLAIM: "https://openworklabs.com/token_use",
}))

function seedRequiredEnv() {
  process.env.DATABASE_URL = process.env.DATABASE_URL ?? "mysql://root:password@127.0.0.1:3306/openwork_test"
  process.env.DEN_DB_ENCRYPTION_KEY = process.env.DEN_DB_ENCRYPTION_KEY ?? "x".repeat(32)
  process.env.BETTER_AUTH_SECRET = process.env.BETTER_AUTH_SECRET ?? "y".repeat(32)
  process.env.BETTER_AUTH_URL = process.env.BETTER_AUTH_URL ?? "http://127.0.0.1:8790"
  process.env.DEN_API_PUBLIC_URL = process.env.DEN_API_PUBLIC_URL ?? "http://127.0.0.1:8790"
}

let registerAgentMcpRoutes: typeof import("../src/mcp/agent.js")["registerAgentMcpRoutes"]
let mcpAuth: typeof import("../src/mcp/auth.js")
let mcpCatalog: typeof import("../src/mcp/index.js")
let externalCapabilities: typeof import("../src/mcp/external-capabilities.js")
let database: typeof import("../src/db.js")

beforeAll(async () => {
  seedRequiredEnv()
  registerAgentMcpRoutes = (await import("../src/mcp/agent.js")).registerAgentMcpRoutes
  mcpAuth = await import("../src/mcp/auth.js")
  mcpCatalog = await import("../src/mcp/index.js")
  externalCapabilities = await import("../src/mcp/external-capabilities.js")
  database = await import("../src/db.js")
})

afterEach(() => mock.restore())

function buildApp() {
  const app = new Hono<{ Variables: { requestId: string } }>()
  app.use("*", async (c, next) => {
    c.set("requestId", "req_agent_route")
    await next()
  })
  registerAgentMcpRoutes(app)
  return app
}

const ORIGIN = "http://127.0.0.1:8790"
const initializedNotification = { jsonrpc: "2.0", method: "notifications/initialized" }

function acknowledgmentFixture() {
  const authenticate = spyOn(mcpAuth, "verifyMcpRequest").mockResolvedValue({
    userId: "usr_fixture",
    organizationId: "org_fixture",
    scopes: new Set(["mcp:read"]),
    payload: {},
  })
  const catalog = spyOn(mcpCatalog, "getCatalog").mockRejectedValue(new Error("Unexpected catalog preparation"))
  const member = spyOn(externalCapabilities, "resolveMcpMemberIdentity").mockRejectedValue(new Error("Unexpected member preparation"))
  const select = spyOn(database.db, "select").mockImplementation(() => {
    throw new Error("Unexpected organization query")
  })
  const app = buildApp()
  // Normal requests deliberately hit the throwing catalog sentinel below.
  app.onError(() => new Response("Catalog preparation reached", { status: 500 }))
  return {
    authenticate,
    catalog,
    request(body: unknown = initializedNotification, headers: Record<string, string> = {}) {
      return app.request(`${ORIGIN}/mcp/agent`, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers },
        body: JSON.stringify(body),
      })
    },
    expectNoPreparation() {
      expect(authenticate).toHaveBeenCalledTimes(1)
      expect(catalog).not.toHaveBeenCalled()
      expect(member).not.toHaveBeenCalled()
      expect(select).not.toHaveBeenCalled()
    },
  }
}

describe("lightweight initialized acknowledgments", () => {
  test.each([undefined, "2025-03-26", "2025-11-25", "2026-07-28"])(
    "acknowledges protocol %s without catalog, member, or organization preparation",
    async (version) => {
      const fixture = acknowledgmentFixture()
      const res = await fixture.request(initializedNotification, version ? { "mcp-protocol-version": version } : {})
      expect(res.status).toBe(202)
      expect(await res.text()).toBe("")
      expect(res.headers.has("mcp-session-id")).toBe(false)
      fixture.expectNoPreparation()
    },
  )

  test.each([401, 403, 503])("preserves authentication rejection %s", async (status) => {
    const fixture = acknowledgmentFixture()
    fixture.authenticate.mockResolvedValue(new Response("Authentication rejected", { status }))
    const res = await fixture.request()
    expect(res.status).toBe(status)
    expect(await res.text()).toBe("Authentication rejected")
    fixture.expectNoPreparation()
  })

  const transportCases: Array<{ name: string; headers: Record<string, string>; status: number }> = [
    { name: "non-JSON content type", headers: { "content-type": "text/plain" }, status: 415 },
    { name: "legacy Accept missing SSE", headers: { accept: "application/json" }, status: 406 },
    { name: "unsupported protocol", headers: { "mcp-protocol-version": "2027-01-01" }, status: 400 },
    { name: "modern method mismatch", headers: { "mcp-protocol-version": "2026-07-28", "mcp-method": "tools/list" }, status: 400 },
  ]
  test.each(transportCases)("retains transport validation: $name", async ({ headers, status }) => {
    const fixture = acknowledgmentFixture()
    const res = await fixture.request(initializedNotification, headers)
    expect(res.status).toBe(status)
    expect(await res.json()).toHaveProperty("error")
    fixture.expectNoPreparation()
  })

  test.each([
    { body: { ...initializedNotification, jsonrpc: "1.0" } },
    { body: { ...initializedNotification, params: null } },
    { body: { ...initializedNotification, params: [] } },
    { body: { ...initializedNotification, params: { _meta: null } } },
    { body: { ...initializedNotification, id: null } },
    { body: [initializedNotification] },
  ])("rejects malformed notification %# without preparation", async ({ body }) => {
    const fixture = acknowledgmentFixture()
    const res = await fixture.request(body)
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ error: { code: -32600 } })
    fixture.expectNoPreparation()
  })

  test("does not acknowledge an id-bearing initialized request", async () => {
    const fixture = acknowledgmentFixture()
    const res = await fixture.request({ ...initializedNotification, id: 1 })
    expect(res.status).toBe(200)
    expect(res.headers.get("content-type")).toContain("text/event-stream")
    const event = (await res.text()).split("\n").find((line) => line.startsWith("data: "))
    if (!event) throw new Error("Missing JSON-RPC response")
    expect(JSON.parse(event.slice(6))).toMatchObject({ id: 1, error: { code: -32601 } })
    fixture.expectNoPreparation()
  })

  test.each(["initialize", "server/discover", "tools/list", "tools/call", "notifications/cancelled"])(
    "%s retains the normal preparation path",
    async (method) => {
      const fixture = acknowledgmentFixture()
      const res = await fixture.request({ jsonrpc: "2.0", method })
      expect(res.status).toBe(500)
      expect(await res.text()).toBe("Catalog preparation reached")
      expect(fixture.authenticate).toHaveBeenCalledTimes(1)
      expect(fixture.catalog).toHaveBeenCalledTimes(1)
    },
  )
})

describe("agent MCP OAuth protected-resource discovery", () => {
  test("serves exact agent metadata at the path-aware well-known URL", async () => {
    const app = buildApp()
    const res = await app.request(`${ORIGIN}/.well-known/oauth-protected-resource/mcp/agent`)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.resource).toBe(`${ORIGIN}/mcp/agent`)
    expect(body.authorization_servers).toEqual([`${ORIGIN}/api/auth`])
    expect(body.scopes_supported).toEqual(["mcp:read", "mcp:write", "offline_access"])
  })

  test("unauthenticated /mcp/agent returns an RFC 9728 discovery challenge", async () => {
    const app = buildApp()
    const res = await app.request(`${ORIGIN}/mcp/agent`, { method: "POST" })
    expect(res.status).toBe(401)
    const challenge = res.headers.get("www-authenticate") ?? ""
    expect(challenge).toContain(`resource_metadata="${ORIGIN}/.well-known/oauth-protected-resource/mcp/agent"`)
    expect(challenge).toContain(`scope="mcp:read mcp:write offline_access"`)
    const body = await res.json()
    expect(body).toMatchObject({ error: "missing_mcp_token", referenceId: "req_agent_route" })
  })

  test("unauthenticated initialized notifications still require MCP authentication", async () => {
    const res = await buildApp().request(`${ORIGIN}/mcp/agent`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
    })
    expect(res.status).toBe(401)
    expect(await res.json()).toMatchObject({ error: "missing_mcp_token", referenceId: "req_agent_route" })
  })

  test("unauthenticated remote-session capability calls are rejected before dispatch", async () => {
    const app = buildApp()
    for (const capability of [
      { name: "remote-session:create", body: { target: "desktop", prompt: "Inspect the repo" } },
      { name: "remote-session:send", body: { sessionId: "ses_fixture", prompt: "Continue" } },
      { name: "remote-session:read", body: { commandId: "rsc_fixture" } },
    ]) {
      const res = await app.request(`${ORIGIN}/mcp/agent`, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "execute_capability", arguments: capability },
        }),
      })
      expect(res.status).toBe(401)
      expect(await res.json()).toMatchObject({ error: "missing_mcp_token", referenceId: "req_agent_route" })
    }
  })

  test("unauthenticated GET /mcp/agent returns an RFC 9728 discovery challenge", async () => {
    const app = buildApp()
    const res = await app.request(`${ORIGIN}/mcp/agent`, {
      method: "GET",
      headers: { accept: "text/event-stream" },
    })

    expect(res.status).toBe(401)
    const challenge = res.headers.get("www-authenticate") ?? ""
    expect(challenge).toContain(`resource_metadata="${ORIGIN}/.well-known/oauth-protected-resource/mcp/agent"`)
    expect(challenge).toContain(`scope="mcp:read mcp:write offline_access"`)
    const body = await res.json()
    expect(body).toMatchObject({ error: "missing_mcp_token", referenceId: "req_agent_route" })
  })
})
