import { afterAll, expect, test } from "bun:test"
import { randomUUID } from "node:crypto"
import { Hono } from "hono"
import { z } from "zod"
import { createDenTypeId } from "@openwork-ee/utils/typeid"
import {
  AuthSessionTable,
  AuthUserTable,
  MemberTable,
  OrganizationTable,
  TeamTable,
  TeamMemberTable,
  GatewayRequestLogTable,
  GatewayUsagePolicyTable,
  GatewayUsageLimitTable,
  GatewayUsageAssignmentTable,
  GatewayUsageSubjectTable,
  GatewayUsageBucketTable,
  GatewayUsageEventTable,
  GatewayUsageChargeTable,
  GatewayUsageResetTable,
  GatewayUsageQuarantineTable,
  GatewayUsageAuditTable,
} from "@openwork-ee/den-db/schema"
import { createGatewayUsageLimits } from "@openwork-ee/den-db/gateway-usage-limits"
import { eq, or } from "@openwork-ee/den-db/drizzle"
import type { OrgRouteVariables } from "../src/routes/org/shared.js"

const url = process.env.DEN_USAGE_TEST_DATABASE_URL
if (
  !url ||
  !["127.0.0.1", "localhost"].includes(new URL(url).hostname) ||
  !new URL(url).pathname.startsWith("/usage_limits_test")
) {
  throw new Error(
    "Set DEN_USAGE_TEST_DATABASE_URL to a disposable loopback usage_limits_test database.",
  )
}
process.env.DATABASE_URL = url
process.env.DATABASE_REDIS_URL = ""
process.env.LINEAR_API_KEY = ""
process.env.LINEAR_COMPLIANCE_TEAM_ID = ""
process.env.STRIPE_SECRET_KEY = ""
process.env.OPENWORK_DEV_MODE = "1"
process.env.DEN_ORG_MODE = "multi_org"
process.env.DEN_DB_ENCRYPTION_KEY = "usage-test-key-not-a-secret-32-characters"
process.env.BETTER_AUTH_SECRET = "usage-test-auth-not-a-secret-32-characters"
process.env.BETTER_AUTH_URL = "http://localhost:8790"
process.env.DEN_BASE_URL = "http://localhost:3005"
process.env.GATEWAY_ENABLED = "true"
process.env.GATEWAY_PROXY_BASE_URL = "http://localhost:8791"
process.env.GATEWAY_PUBLIC_BASE_URL = "https://gateway.example.test"

const { db, client } = await import("../src/db.js")
const { sessionMiddleware } = await import("../src/session.js")
const { registerOrgGatewayUsageLimitRoutes } = await import(
  "../src/routes/org/gateway-usage-limits.js"
)
const { registerOrgTeamRoutes } = await import("../src/routes/org/teams.js")
const { registerDeleteOrganizationRoutes } = await import(
  "../src/routes/org/delete-organization.js"
)
const { createRequestAccessLogMiddleware } = await import("../src/observability/hono.js")
const { createAppLogger } = await import("../src/observability/logger.js")
const accessLogs: string[] = []
const service = createGatewayUsageLimits(db)
const app = new Hono<{ Variables: OrgRouteVariables }>()
app.use(
  "*",
  createRequestAccessLogMiddleware(createAppLogger({ write: (line) => accessLogs.push(line) })),
)
app.use("*", sessionMiddleware)
registerOrgGatewayUsageLimitRoutes(app)
registerOrgTeamRoutes(app)
registerDeleteOrganizationRoutes(app)
afterAll(async () => {
  if ("end" in client) await client.end()
})

async function seed(role: string, organizationId = createDenTypeId("organization")) {
  const memberId = createDenTypeId("member")
  const userId = createDenTypeId("user")
  const token = randomUUID()
  await db
    .insert(OrganizationTable)
    .values({ id: organizationId, name: "Auth fixture", slug: randomUUID() })
    .onDuplicateKeyUpdate({ set: { name: "Auth fixture" } })
  await db
    .insert(AuthUserTable)
    .values({ id: userId, name: "Fixture member", email: `${userId}@example.test` })
  await db.insert(MemberTable).values({ id: memberId, userId, organizationId, role })
  await db.insert(AuthSessionTable).values({
    id: createDenTypeId("session"),
    token,
    userId,
    activeOrganizationId: organizationId,
    expiresAt: new Date(Date.now() + 86_400_000),
  })
  return { memberId, userId, organizationId, token }
}
function request(
  token: string | null,
  path: string,
  method = "GET",
  body?: unknown,
  headers: Record<string, string> = {},
) {
  return app.request(path, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      "content-type": "application/json",
      ...headers,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
}
const usageSchema = z.object({
  memberId: z.string(),
  organizationId: z.string(),
  buckets: z.array(z.object({ id: z.string() })),
})
const idSchema = z.object({ id: z.string() })
const resetSchema = z.object({ id: z.string(), status: z.string() })

test("real session and org middleware enforce own identity, role and organization path scope", async () => {
  const owner = await seed("owner")
  const member = await seed("member", owner.organizationId)
  const foreign = await seed("owner")
  expect((await request(null, "/v1/gateway/usage-limits/me")).status).toBe(401)
  expect((await request("invalid-session", "/v1/gateway/usage-limits/me")).status).toBe(401)
  const own = await request(member.token, `/v1/gateway/usage-limits/me?memberId=${owner.memberId}`)
  expect(own.status).toBe(200)
  expect(usageSchema.parse(await own.json()).memberId).toBe(member.memberId)
  expect((await request(member.token, "/v1/gateway/usage-limit-policies")).status).toBe(403)
  expect(
    (await request(member.token, `/v1/gateway/usage-limits/members/${owner.memberId}`)).status,
  ).toBe(403)
  expect(
    (await request(owner.token, `/v1/gateway/usage-limits/members/${foreign.memberId}`)).status,
  ).toBe(404)
  expect(
    (
      await request(member.token, "/v1/gateway/usage-limits/me", "GET", undefined, {
        "X-OpenWork-Org-Id": foreign.organizationId,
      })
    ).status,
  ).toBe(404)
  const inspected = await request(
    owner.token,
    `/v1/gateway/usage-limits/members/${member.memberId}`,
  )
  expect(inspected.status).toBe(200)
  expect(usageSchema.parse(await inspected.json()).memberId).toBe(member.memberId)
})

test("member identity search is private, admin-only, active and organization-scoped with safe access logs", async () => {
  const owner = await seed("owner")
  const admin = await seed("admin", owner.organizationId)
  const member = await seed("member", owner.organizationId)
  const removed = await seed("admin", owner.organizationId)
  const foreign = await seed("owner")
  await db
    .update(MemberTable)
    .set({ removedAt: new Date() })
    .where(eq(MemberTable.id, removed.memberId))
  const path = "/v1/gateway/usage-limits/members"
  const logStart = accessLogs.length
  for (const token of [null, "invalid-session"]) {
    const response = await request(token, `${path}?query=Fixture`)
    expect(response.status).toBe(401)
    expect(await response.json()).toEqual({ error: "unauthorized" })
  }
  const forbidden = await request(member.token, `${path}?query=Fixture`)
  expect(forbidden.status).toBe(403)
  expect(forbidden.headers.get("cache-control")).toBe("private, no-store")
  expect(await forbidden.json()).toMatchObject({ error: "forbidden" })
  for (const token of [owner.token, admin.token]) {
    const response = await request(token, `${path}?query=Fixture`)
    expect(response.status).toBe(200)
    expect(response.headers.get("cache-control")).toBe("private, no-store")
    const result = z
      .object({
        members: z.array(z.object({ id: z.string(), name: z.string(), email: z.string() }).strict()),
      })
      .parse(await response.json())
    expect(result.members.map((item) => item.id).sort()).toEqual(
      [owner.memberId, admin.memberId, member.memberId].sort(),
    )
    expect(result.members.find((item) => item.id === member.memberId)).toEqual({
      id: member.memberId,
      name: "Fixture member",
      email: `${member.userId}@example.test`,
    })
  }
  const email = `${member.userId}@example.test`
  const byEmail = await request(owner.token, `${path}?query=${encodeURIComponent(email)}`)
  expect(await byEmail.json()).toEqual({
    members: [{ id: member.memberId, name: "Fixture member", email }],
  })
  const crossOrg = await request(foreign.token, path, "GET", undefined, {
    "X-OpenWork-Org-Id": owner.organizationId,
  })
  expect(crossOrg.status).toBe(404)
  expect(await crossOrg.json()).toEqual({ error: "organization_not_found" })
  expect(
    await (await request(foreign.token, `${path}?query=${encodeURIComponent(email)}`)).json(),
  ).toEqual({ members: [] })
  const revoked = await request(removed.token, path, "GET", undefined, {
    "X-OpenWork-Org-Id": owner.organizationId,
  })
  expect(revoked.status).toBe(404)
  expect(await revoked.json()).toEqual({ error: "organization_not_found" })
  const logs = accessLogs.slice(logStart)
  expect(logs.length).toBeGreaterThan(0)
  for (const line of logs) {
    expect(JSON.parse(line)).toMatchObject({ http_route: path, message: "request completed" })
    for (const value of [
      "Fixture", "example.test", "query=", owner.token, member.memberId, member.userId,
    ]) {
      expect(line).not.toContain(value)
    }
  }
})

test("member identity search honors only current same-organization team admin grants", async () => {
  const owner = await seed("owner")
  const member = await seed("member", owner.organizationId)
  const foreign = await seed("owner")
  const teamId = createDenTypeId("team")
  const membershipId = createDenTypeId("teamMember")
  const path = "/v1/gateway/usage-limits/members"
  await db.insert(TeamTable).values({
    id: teamId,
    organizationId: foreign.organizationId,
    name: randomUUID(),
    grantsOrganizationAdmin: true,
  })
  await db.insert(TeamMemberTable).values({
    id: membershipId, teamId, orgMembershipId: member.memberId,
  })
  expect((await request(member.token, path)).status).toBe(403)
  await db
    .update(TeamTable)
    .set({ organizationId: owner.organizationId })
    .where(eq(TeamTable.id, teamId))
  const allowed = await request(member.token, path)
  expect(allowed.status).toBe(200)
  expect(allowed.headers.get("cache-control")).toBe("private, no-store")
  const result = z.object({ members: z.array(idSchema) }).parse(await allowed.json())
  expect(result.members.map((item) => item.id).sort())
    .toEqual([owner.memberId, member.memberId].sort())
  await db.delete(TeamMemberTable).where(eq(TeamMemberTable.id, membershipId))
  expect((await request(member.token, path)).status).toBe(403)
})

test("actual team API transactions expire remove/rejoin resets without touching unchanged teammates", async () => {
  const owner = await seed("owner")
  const member = await seed("member", owner.organizationId)
  const other = await seed("member", owner.organizationId)
  const teamResponse = await request(owner.token, "/v1/teams", "POST", {
    name: randomUUID(),
    memberIds: [member.memberId, other.memberId],
  })
  expect(teamResponse.status).toBe(201)
  const team = z.object({ team: idSchema }).parse(await teamResponse.json()).team
  const policyResponse = await request(owner.token, "/v1/gateway/usage-limit-policies", "POST", {
    name: "Team daily",
    hardLimit: true,
    allowRequestReset: true,
    limits: [{ timeframe: "day", costUsd: "1" }],
  })
  expect(policyResponse.status).toBe(200)
  const policy = idSchema.parse(await policyResponse.json())
  expect(
    (
      await request(
        owner.token,
        `/v1/gateway/usage-limit-policies/${policy.id}/assignments`,
        "POST",
        { teamId: team.id },
      )
    ).status,
  ).toBe(200)
  async function spendAndRequest(subject: typeof member) {
    const row = {
      id: createDenTypeId("inferenceRequestLog"),
      organization_id: subject.organizationId,
      org_membership_id: subject.memberId,
      openwork_request_id: randomUUID().replaceAll("-", ""),
      started_at: new Date(),
    }
    await service.admit(
      { organizationId: subject.organizationId, memberId: subject.memberId },
      row.openwork_request_id,
      true,
    )
    await service.record({
      ...row,
      route: "org_provider",
      protocol: "openai_chat",
      upstream_provider_id: "openai",
      upstream_host: "api.example.test",
      upstream_path: "/chat/completions",
      method: "POST",
      stream: false,
      completed_at: new Date(),
      outcome: "ok",
      usage_source: "json",
      cost_micro_usd: 1_000_000,
    })
    const status = usageSchema.parse(
      await (await request(subject.token, "/v1/gateway/usage-limits/me")).json(),
    )
    const submitted = await request(
      subject.token,
      "/v1/gateway/usage-limit-reset-requests",
      "POST",
      { bucketId: status.buckets[0].id, reason: "Team transition test" },
    )
    expect(submitted.status).toBe(200)
    return resetSchema.parse(await submitted.json())
  }
  const pending = await spendAndRequest(member)
  const unaffected = await spendAndRequest(other)
  expect(
    (await request(owner.token, `/v1/teams/${team.id}`, "PATCH", { memberIds: [other.memberId] }))
      .status,
  ).toBe(200)
  expect(
    (
      await request(owner.token, `/v1/teams/${team.id}`, "PATCH", {
        memberIds: [member.memberId, other.memberId],
      })
    ).status,
  ).toBe(200)
  const review = await request(
    owner.token,
    `/v1/gateway/usage-limit-reset-requests/${pending.id}/approve`,
    "POST",
    {},
  )
  expect(review.status).toBe(200)
  expect(resetSchema.parse(await review.json()).status).toBe("expired")
  const unchanged = await request(
    owner.token,
    `/v1/gateway/usage-limit-reset-requests/${unaffected.id}/approve`,
    "POST",
    {},
  )
  expect(unchanged.status).toBe(200)
  expect(resetSchema.parse(await unchanged.json()).status).toBe("approved")
})

test("permanent organization deletion erases every usage table and preserves another organization", async () => {
  const owner = await seed("owner")
  const other = await seed("owner")
  async function populate(subject: typeof owner) {
    const scope = { organizationId: subject.organizationId, memberId: subject.memberId }
    const policy = await service.savePolicy(scope, {
      name: "Erasure policy",
      hardLimit: true,
      allowRequestReset: true,
      limits: [{ timeframe: "day", costUsd: "1" }],
    })
    await service.assign(scope, policy.id, { memberId: subject.memberId })
    const eventId = randomUUID().replaceAll("-", "")
    await service.admit(scope, eventId, true)
    const row: typeof GatewayRequestLogTable.$inferInsert = {
      id: createDenTypeId("inferenceRequestLog"),
      organization_id: scope.organizationId,
      org_membership_id: scope.memberId,
      openwork_request_id: eventId,
      started_at: new Date(),
      completed_at: new Date(),
      route: "org_provider",
      protocol: "openai_chat",
      upstream_provider_id: "openai",
      upstream_host: "fixture.example.test",
      upstream_path: "/chat/completions",
      method: "POST",
      stream: false,
      outcome: "ok",
      usage_source: "json",
      cost_micro_usd: 1_000_000,
      metadata: { cost_source: "upstream", cost_complete: true },
    }
    await service.record(row)
    const bucket = (await service.getStatus(scope)).buckets[0]
    await service.submitReset(scope, bucket.id, "Erasure fixture reason")
    await service.record({
      ...row,
      id: createDenTypeId("inferenceRequestLog"),
      openwork_request_id: randomUUID().replaceAll("-", ""),
      started_at: new Date(Date.now() - 3_600_000),
      cost_micro_usd: 7,
    })
    return {
      organizationId: scope.organizationId,
      policyId: policy.id,
      eventId,
      bucketId: bucket.id,
    }
  }
  const target = await populate(owner)
  const preserved = await populate(other)
  async function snapshot(refs: typeof target) {
    return {
      policy: await db
        .select()
        .from(GatewayUsagePolicyTable)
        .where(eq(GatewayUsagePolicyTable.organizationId, refs.organizationId)),
      entry: await db
        .select()
        .from(GatewayUsageLimitTable)
        .where(eq(GatewayUsageLimitTable.policyId, refs.policyId)),
      assignment: await db
        .select()
        .from(GatewayUsageAssignmentTable)
        .where(eq(GatewayUsageAssignmentTable.organizationId, refs.organizationId)),
      subject: await db
        .select()
        .from(GatewayUsageSubjectTable)
        .where(eq(GatewayUsageSubjectTable.organizationId, refs.organizationId)),
      bucket: await db
        .select()
        .from(GatewayUsageBucketTable)
        .where(eq(GatewayUsageBucketTable.organizationId, refs.organizationId)),
      event: await db
        .select()
        .from(GatewayUsageEventTable)
        .where(eq(GatewayUsageEventTable.organizationId, refs.organizationId)),
      charge: await db
        .select()
        .from(GatewayUsageChargeTable)
        .where(
          or(
            eq(GatewayUsageChargeTable.bucketId, refs.bucketId),
            eq(GatewayUsageChargeTable.eventId, refs.eventId),
            eq(GatewayUsageChargeTable.policyId, refs.policyId),
          ),
        ),
      reset: await db
        .select()
        .from(GatewayUsageResetTable)
        .where(eq(GatewayUsageResetTable.organizationId, refs.organizationId)),
      quarantine: await db
        .select()
        .from(GatewayUsageQuarantineTable)
        .where(eq(GatewayUsageQuarantineTable.organizationId, refs.organizationId)),
      audit: await db
        .select()
        .from(GatewayUsageAuditTable)
        .where(eq(GatewayUsageAuditTable.organizationId, refs.organizationId)),
    }
  }
  const beforeTarget = await snapshot(target)
  const beforeOther = await snapshot(preserved)
  for (const rows of Object.values(beforeTarget)) expect(rows.length).toBeGreaterThan(0)
  for (const rows of Object.values(beforeOther)) expect(rows.length).toBeGreaterThan(0)
  const response = await request(owner.token, "/v1/org", "DELETE")
  expect(response.status).toBe(200)
  for (const rows of Object.values(await snapshot(target))) expect(rows).toEqual([])
  expect(await snapshot(preserved)).toEqual(beforeOther)
  expect(
    (
      await db
        .select()
        .from(OrganizationTable)
        .where(eq(OrganizationTable.id, owner.organizationId))
    ).length,
  ).toBe(0)
  expect((await request(other.token, "/v1/gateway/usage-limits/me")).status).toBe(200)
})
