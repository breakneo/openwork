import assert from "node:assert/strict"
import { after, test } from "node:test"
import { randomUUID } from "node:crypto"
import { eq, and, inArray } from "drizzle-orm"
import { createDenTypeId } from "@openwork-ee/utils/typeid"
import { createDenDb } from "../src/client"
import {
  createGatewayUsageLimits,
  GatewayUsageError,
  type GatewayUsageScope,
} from "../src/gateway-usage-limits"
import {
  AuthUserTable,
  MemberTable,
  OrganizationTable,
  TeamTable,
  TeamMemberTable,
  GatewayRequestLogTable,
  GatewayUsageRollupTable,
  GatewayUsageBucketTable,
  GatewayUsageEventTable,
  GatewayUsageChargeTable,
  GatewayUsageAssignmentTable,
  GatewayUsageLimitTable,
  GatewayUsageResetTable,
  GatewayUsageSubjectTable,
} from "../src/schema"
import {
  gatewayUsageStatusSchema,
  type GatewayUsagePolicyWrite,
} from "@openwork/types/den/gateway-usage-limits"
import { isGatewayUsageDeadlock } from "../src/gateway-usage-errors"

const url = process.env.DEN_USAGE_TEST_DATABASE_URL
const enabled = !!url
if (
  url &&
  (!["127.0.0.1", "localhost"].includes(new URL(url).hostname) ||
    !new URL(url).pathname.startsWith("/usage_limits_test"))
)
  throw new Error("Use a disposable loopback usage_limits_test database only.")
const connection = url ? createDenDb({ databaseUrl: url, mode: "mysql" }) : null
after(async () => {
  if (connection && "end" in connection.client) await connection.client.end()
})
async function fixture() {
  assert.ok(connection)
  const { db } = connection
  let now = new Date("2026-09-15T12:00:00Z")
  const service = createGatewayUsageLimits(db, () => now)
  const organizationId = createDenTypeId("organization")
  await db
    .insert(OrganizationTable)
    .values({ id: organizationId, name: "Usage test", slug: randomUUID() })
  async function addMember(role = "member"): Promise<GatewayUsageScope> {
    const userId = createDenTypeId("user")
    const memberId = createDenTypeId("member")
    await db
      .insert(AuthUserTable)
      .values({ id: userId, name: "Test member", email: `${userId}@example.test` })
    await db.insert(MemberTable).values({ id: memberId, userId, organizationId, role })
    return { organizationId, memberId }
  }
  const admin = await addMember("owner")
  const member = await addMember()
  const body: GatewayUsagePolicyWrite = {
    name: "Standard",
    hardLimit: true,
    allowRequestReset: true,
    limits: [
      { timeframe: "day", costUsd: "1" },
      { timeframe: "week", costUsd: "2" },
      { timeframe: "month", costUsd: "3" },
    ],
  }
  async function assigned(input = body, target = member) {
    const policy = await service.savePolicy(admin, input)
    await service.assign(admin, policy.id, { memberId: target.memberId })
    return policy
  }
  function raw(
    cost: number | null,
    target = member,
    requestId = randomUUID().replaceAll("-", ""),
  ): typeof GatewayRequestLogTable.$inferInsert {
    return {
      id: createDenTypeId("inferenceRequestLog"),
      organization_id: target.organizationId,
      org_membership_id: target.memberId,
      openwork_request_id: requestId,
      route: "org_provider",
      protocol: "openai_chat",
      upstream_provider_id: "openai",
      upstream_host: "api.example.test",
      upstream_path: "/chat/completions",
      method: "POST",
      stream: false,
      started_at: now,
      completed_at: now,
      outcome: "ok",
      usage_source: "json",
      cost_micro_usd: cost,
      metadata: { cost_source: cost === null ? "unknown" : "upstream" },
    }
  }
  return {
    db,
    service,
    admin,
    member,
    body,
    assigned,
    raw,
    addMember,
    setTime(value: string) {
      now = new Date(value)
    },
  }
}
const dbTest = (name: string, fn: () => Promise<void>) => test(name, { skip: !enabled }, fn)

dbTest(
  "team allowances are per member; overlaps deduplicate; auth and cross-org targets are rejected",
  async () => {
    const f = await fixture()
    const second = await f.addMember()
    const foreign = await fixture()
    const teamId = createDenTypeId("team")
    await f.db
      .insert(TeamTable)
      .values({ id: teamId, organizationId: f.admin.organizationId, name: randomUUID() })
    await f.db.insert(TeamMemberTable).values(
      [f.member, second].map((member) => ({
        id: createDenTypeId("teamMember"),
        teamId,
        orgMembershipId: member.memberId,
      })),
    )
    const policy = await f.service.savePolicy(f.admin, f.body)
    await f.service.assign(f.admin, policy.id, { teamId })
    await f.service.assign(f.admin, policy.id, { memberId: f.member.memberId })
    await f.service.assign(f.admin, policy.id, { memberId: f.member.memberId })
    await f.service.record(f.raw(1_100_000))
    assert.equal((await f.service.getStatus(f.member)).state, "blocked")
    assert.equal((await f.service.getStatus(second)).buckets[0].usedMicroUsd, 0)
    assert.equal((await f.service.getStatus(f.member)).buckets.length, 3)
    await assert.rejects(
      f.service.listPolicies(f.member),
      (error) => error instanceof GatewayUsageError && error.status === 403,
    )
    await assert.rejects(
      f.service.getStatus(f.member, second.memberId),
      (error) => error instanceof GatewayUsageError && error.status === 403,
    )
    await assert.rejects(
      f.service.assign(f.admin, policy.id, { memberId: foreign.member.memberId }),
      (error) => error instanceof GatewayUsageError && error.status === 404,
    )
    await assert.rejects(
      f.service.getStatus(f.admin, foreign.member.memberId),
      (error) => error instanceof GatewayUsageError && error.status === 404,
    )
    await assert.rejects(
      f.service.savePolicy(f.admin, f.body, foreign.admin.organizationId, 1),
      (error) => error instanceof GatewayUsageError && error.status === 404,
    )
    assert.equal((await f.service.listPolicies(f.admin)).policies[0].assignments.length, 2)
  },
)
dbTest("member search rechecks admin authority and excludes removed and foreign identities", async () => {
  const f = await fixture()
  const foreign = await fixture()
  await assert.rejects(
    f.service.members(f.member),
    (error) => error instanceof GatewayUsageError && error.status === 403,
  )
  await assert.rejects(
    f.service.members({ ...f.admin, organizationId: foreign.admin.organizationId }),
    (error) => error instanceof GatewayUsageError && error.status === 404,
  )
  await f.db
    .update(MemberTable)
    .set({ removedAt: new Date() })
    .where(eq(MemberTable.id, f.member.memberId))
  assert.deepEqual(
    (await f.service.members(f.admin, "Test member")).members.map((member) => member.id),
    [f.admin.memberId],
  )
  await f.db.update(MemberTable).set({ role: "member" }).where(eq(MemberTable.id, f.admin.memberId))
  await assert.rejects(
    f.service.members(f.admin),
    (error) => error instanceof GatewayUsageError && error.status === 403,
  )
  await f.db
    .update(MemberTable)
    .set({ role: "owner", removedAt: new Date() })
    .where(eq(MemberTable.id, f.admin.memberId))
  await assert.rejects(
    f.service.members(f.admin),
    (error) => error instanceof GatewayUsageError && error.status === 404,
  )
})
dbTest(
  "known current-window raw and hourly history is included exactly once with explicit coverage",
  async () => {
    const f = await fixture()
    const historical = f.raw(200_000)
    await f.db.insert(GatewayRequestLogTable).values(historical)
    await f.db.insert(GatewayUsageRollupTable).values({
      id: createDenTypeId("inferenceUsageRollup"),
      organization_id: f.member.organizationId,
      org_membership_id: f.member.memberId,
      granularity: "hour",
      bucket_start: new Date("2026-09-15T08:00:00Z"),
      dimension_key: randomUUID(),
      route: "org_provider",
      protocol: "openai_chat",
      upstream_provider_id: "openai",
      cost_micro_usd: 300_000,
      request_count: 2,
      cost_count: 1,
    })
    await f.assigned()
    const first = await f.service.getStatus(f.member)
    assert.equal(first.buckets[0].usedMicroUsd, 500_000)
    assert.deepEqual(first.coverage, { complete: false, unpricedRequests: 1 })
    assert.deepEqual(await f.service.getStatus(f.member), first)
    await f.service.record({ ...historical, cost_micro_usd: 900_000 })
    const [retained] = await f.db
      .select()
      .from(GatewayRequestLogTable)
      .where(eq(GatewayRequestLogTable.id, historical.id))
    assert.equal(retained.cost_micro_usd, 200_000)
    assert.deepEqual(await f.service.getStatus(f.member), first)
    const policy = (await f.service.listPolicies(f.admin)).policies[0]
    await f.service.unassign(f.admin, policy.id, policy.assignments[0].id)
    assert.equal((await f.service.getStatus(f.member)).state, "unlimited")
    await f.service.assign(f.admin, policy.id, { memberId: f.member.memberId })
    assert.equal((await f.service.getStatus(f.member)).buckets[0].usedMicroUsd, 500_000)
  },
)
dbTest(
  "admission before reset settles old day; duplicate settlement survives raw deletion and policy edits",
  async () => {
    const f = await fixture()
    await f.assigned()
    f.setTime("2026-09-15T04:59:59.999Z")
    const row = f.raw(700_000)
    const admitted = await f.service.admit(f.member, row.openwork_request_id, true)
    assert.equal(admitted.admitted, true)
    const dayId = admitted.usage.buckets[0].id
    f.setTime("2026-09-15T05:00:00Z")
    assert.equal((await f.service.getStatus(f.member)).buckets[0].usedMicroUsd, 0)
    await Promise.all([f.service.record(row), f.service.record(row)])
    await f.db.delete(GatewayRequestLogTable).where(eq(GatewayRequestLogTable.id, row.id))
    await f.service.record({ ...row, cost_micro_usd: 9_000_000 })
    const [old] = await f.db
      .select()
      .from(GatewayUsageBucketTable)
      .where(eq(GatewayUsageBucketTable.id, dayId))
    assert.equal(old.usedMicroUsd, 700_000)
    const status = await f.service.getStatus(f.member)
    assert.equal(status.buckets[0].usedMicroUsd, 0)
    assert.equal(status.buckets[1].usedMicroUsd, 700_000)
    const charges = await f.db
      .select()
      .from(GatewayUsageChargeTable)
      .where(eq(GatewayUsageChargeTable.eventId, row.openwork_request_id))
    assert.equal(charges.length, 3)
  },
)
dbTest(
  "simultaneous admission is settled-spend based; soft and unlimited paths allow unaccountable requests",
  async () => {
    const f = await fixture()
    await f.assigned()
    const a = f.raw(700_000),
      b = f.raw(700_000)
    const admitted = await Promise.all([
      f.service.admit(f.member, a.openwork_request_id, true),
      f.service.admit(f.member, b.openwork_request_id, true),
    ])
    assert.ok(admitted.every((item) => item.admitted))
    await Promise.all([f.service.record(a), f.service.record(b)])
    assert.equal((await f.service.admit(f.member, randomUUID(), true)).admitted, false)
    const soft = await f.service.savePolicy(f.admin, {
      ...f.body,
      hardLimit: false,
      limits: [
        { timeframe: "day", costUsd: "10" },
        { timeframe: "week", costUsd: "10" },
        { timeframe: "month", costUsd: "10" },
      ],
    })
    await f.service.assign(f.admin, soft.id, { memberId: f.member.memberId })
    assert.equal((await f.service.admit(f.member, randomUUID(), false)).admitted, true)
    const unlimited = await f.addMember()
    assert.equal((await f.service.admit(unlimited, randomUUID(), false)).admitted, true)
  },
)
dbTest(
  "passthrough hard admission is accounting unavailable; unknown and partial observations remain explicit",
  async () => {
    const f = await fixture()
    await f.assigned()
    const blocked = await f.service.admit(f.member, randomUUID(), false)
    assert.equal(blocked.accountingUnavailable, true)
    assert.equal(blocked.usage.state, "within_limit")
    await f.service.record(f.raw(null))
    await f.service.record({ ...f.raw(300_000), outcome: "client_aborted" })
    const status = await f.service.getStatus(f.member)
    assert.equal(status.buckets[0].usedMicroUsd, 300_000)
    assert.deepEqual(status.coverage, { complete: false, unpricedRequests: 1 })
  },
)
dbTest(
  "concurrent submission/review is idempotent; approval adds ceil(base/4) once without clearing spend",
  async () => {
    const f = await fixture()
    await f.assigned({ ...f.body, limits: [{ timeframe: "day", costUsd: "0.000005" }] })
    await f.service.record(f.raw(5))
    const before = (await f.service.getStatus(f.member)).buckets[0]
    const requests = await Promise.all([
      f.service.submitReset(f.member, before.id, "Testing"),
      f.service.submitReset(f.member, before.id, "Testing"),
    ])
    assert.equal(requests[0].id, requests[1].id)
    const reviews = await Promise.all([
      f.service.reviewReset(f.admin, requests[0].id, "approved"),
      f.service.reviewReset(f.admin, requests[0].id, "approved"),
    ])
    assert.deepEqual(reviews[0], reviews[1])
    const after = (await f.service.getStatus(f.member)).buckets[0]
    assert.equal(after.allowanceMicroUsd, 7)
    assert.equal(after.extensionMicroUsd, 2)
    assert.equal(after.usedMicroUsd, 5)
    assert.equal(after.resetAt, before.resetAt)
    await f.service.record(f.raw(10))
    assert.equal((await f.service.getStatus(f.member)).buckets[0].canRequestReset, false)
    await assert.rejects(f.service.submitReset(f.member, before.id, "Again"))
  },
)
dbTest(
  "policy revisions expire requests; edits preserve consumption and approvals cannot be minted twice",
  async () => {
    const f = await fixture()
    const policy = await f.assigned()
    await f.service.record(f.raw(1_000_000))
    const day = (await f.service.getStatus(f.member)).buckets[0]
    const request = await f.service.submitReset(f.member, day.id, "Testing")
    const updated = await f.service.savePolicy(
      f.admin,
      { ...f.body, name: "Revised" },
      policy.id,
      1,
    )
    await assert.rejects(
      f.service.savePolicy(f.admin, f.body, policy.id, 1),
      (error) => error instanceof GatewayUsageError && error.status === 409,
    )
    assert.equal((await f.service.reviewReset(f.admin, request.id, "approved")).status, "expired")
    assert.equal((await f.service.getStatus(f.member)).buckets[0].usedMicroUsd, 1_000_000)
    const next = await f.service.submitReset(f.member, day.id, "New policy")
    await f.service.reviewReset(f.admin, next.id, "approved")
    await f.service.savePolicy(f.admin, f.body, policy.id, updated.revision)
    const rebased = (await f.service.getStatus(f.member)).buckets[0]
    assert.equal(rebased.extensionMicroUsd, 0)
    assert.equal(rebased.canRequestReset, false)
  },
)
dbTest(
  "removed members and elapsed windows expire requests; foreign admins and member reviewers are denied",
  async () => {
    const f = await fixture()
    const other = await fixture()
    await f.assigned()
    await f.service.record(f.raw(1_000_000))
    const day = (await f.service.getStatus(f.member)).buckets[0]
    const request = await f.service.submitReset(f.member, day.id, "Testing")
    await assert.rejects(
      f.service.reviewReset(other.admin, request.id, "approved"),
      (error) => error instanceof GatewayUsageError && error.status === 404,
    )
    await assert.rejects(
      f.service.reviewReset(f.member, request.id, "approved"),
      (error) => error instanceof GatewayUsageError && error.status === 403,
    )
    f.setTime(day.resetAt)
    assert.equal((await f.service.reviewReset(f.admin, request.id, "approved")).status, "expired")
    assert.equal((await f.service.getStatus(f.member)).buckets[0].extensionMicroUsd, 0)
    await f.service.record(f.raw(1_000_000))
    const current = (await f.service.getStatus(f.member)).buckets[0]
    const next = await f.service.submitReset(f.member, current.id, "Testing")
    await f.db
      .update(MemberTable)
      .set({ removedAt: new Date() })
      .where(eq(MemberTable.id, f.member.memberId))
    assert.equal((await f.service.reviewReset(f.admin, next.id, "approved")).status, "expired")
  },
)
dbTest(
  "denial races return the original decision; zero allowance cannot request a useless extension",
  async () => {
    const f = await fixture()
    await f.assigned({ ...f.body, limits: [{ timeframe: "day", costUsd: "0" }] })
    const day = (await f.service.getStatus(f.member)).buckets[0]
    assert.equal(day.canRequestReset, false)
    assert.equal((await f.service.admit(f.member, randomUUID(), true)).admitted, false)
    await assert.rejects(f.service.submitReset(f.member, day.id, "Testing"))
    const p = (await f.service.listPolicies(f.admin)).policies[0]
    await f.service.savePolicy(
      f.admin,
      { ...f.body, limits: [{ timeframe: "day", costUsd: "1" }] },
      p.id,
      p.revision,
    )
    await f.service.record(f.raw(1_000_000))
    const req = await f.service.submitReset(f.member, day.id, "Testing")
    const results = await Promise.all([
      f.service.reviewReset(f.admin, req.id, "denied"),
      f.service.reviewReset(f.admin, req.id, "approved"),
    ])
    assert.equal(results[0].status, results[1].status)
    const view = (await f.service.getStatus(f.member)).buckets[0]
    assert.equal(view.extensionMicroUsd, results[0].status === "approved" ? 250_000 : 0)
  },
)
dbTest(
  "soft exhaustion admits requests; one approval cannot unblock other exhausted windows",
  async () => {
    const f = await fixture()
    await f.assigned({
      ...f.body,
      limits: [
        { timeframe: "day", costUsd: "1" },
        { timeframe: "week", costUsd: "1" },
        { timeframe: "month", costUsd: "1" },
      ],
    })
    await f.service.record(f.raw(1_000_000))
    const original = await f.service.getStatus(f.member)
    for (const [index, bucket] of original.buckets.entries()) {
      const req = await f.service.submitReset(f.member, bucket.id, "Test each window")
      await f.service.reviewReset(f.admin, req.id, "approved")
      assert.equal(
        (await f.service.getStatus(f.member)).state,
        index === 2 ? "within_limit" : "blocked",
      )
    }
    const soft = await f.addMember()
    await f.assigned(
      { ...f.body, hardLimit: false, limits: [{ timeframe: "day", costUsd: "1" }] },
      soft,
    )
    await f.service.record(f.raw(2_000_000, soft))
    assert.equal((await f.service.getStatus(soft)).state, "over_limit")
    assert.equal((await f.service.admit(soft, randomUUID(), true)).admitted, true)
  },
)
dbTest(
  "initial backfill racing finalization cannot double-charge; team departure invalidates a pending review",
  async () => {
    const f = await fixture()
    const teamId = createDenTypeId("team")
    await f.db
      .insert(TeamTable)
      .values({ id: teamId, organizationId: f.admin.organizationId, name: randomUUID() })
    const teamMembership = createDenTypeId("teamMember")
    await f.db
      .insert(TeamMemberTable)
      .values({ id: teamMembership, teamId, orgMembershipId: f.member.memberId })
    const policy = await f.service.savePolicy(f.admin, f.body)
    await f.service.assign(f.admin, policy.id, { teamId })
    const row = f.raw(1_000_000)
    await f.db
      .insert(GatewayRequestLogTable)
      .values({ ...row, cost_micro_usd: null, completed_at: null })
    await Promise.all([f.service.getStatus(f.member), f.service.record(row)])
    const day = (await f.service.getStatus(f.member)).buckets[0]
    assert.equal(day.usedMicroUsd, 1_000_000)
    const req = await f.service.submitReset(f.member, day.id, "Team request")
    await f.db.delete(TeamMemberTable).where(eq(TeamMemberTable.id, teamMembership))
    assert.equal((await f.service.reviewReset(f.admin, req.id, "approved")).status, "expired")
    assert.equal((await f.service.getStatus(f.member)).state, "unlimited")
  },
)
dbTest(
  "pending obligations survive raw retention and can settle late without recreating raw rows",
  async () => {
    const f = await fixture()
    await f.assigned()
    const row = f.raw(1_000_000)
    await f.db
      .insert(GatewayRequestLogTable)
      .values({ ...row, completed_at: null, cost_micro_usd: null })
    await f.service.admit(f.member, row.openwork_request_id, true)
    await f.db.delete(GatewayRequestLogTable).where(eq(GatewayRequestLogTable.id, row.id))
    const incomplete = await f.service.getStatus(f.member)
    assert.deepEqual(incomplete.coverage, { complete: false, unpricedRequests: 1 })
    assert.equal(incomplete.buckets[0].usedMicroUsd, 0)
    await f.service.record(row)
    assert.equal((await f.service.getStatus(f.member)).buckets[0].usedMicroUsd, 1_000_000)
    assert.equal(
      (
        await f.db
          .select()
          .from(GatewayRequestLogTable)
          .where(eq(GatewayRequestLogTable.id, row.id))
      ).length,
      0,
    )
  },
)
dbTest(
  "unsafe aggregate settlement rolls back the event and retains the pending obligation",
  async () => {
    const f = await fixture()
    await f.assigned()
    const first = f.raw(Number.MAX_SAFE_INTEGER)
    const second = f.raw(1)
    await f.service.admit(f.member, first.openwork_request_id, true)
    await f.service.admit(f.member, second.openwork_request_id, true)
    await f.service.record(first)
    await assert.rejects(f.service.record(second))
    const [event] = await f.db
      .select()
      .from(GatewayUsageEventTable)
      .where(eq(GatewayUsageEventTable.id, second.openwork_request_id))
    assert.equal(event.finalized, false)
    assert.equal(event.costMicroUsd, null)
    assert.equal(
      (await f.service.getStatus(f.member)).buckets[0].usedMicroUsd,
      Number.MAX_SAFE_INTEGER,
    )
  },
)
dbTest(
  "database constraints reject invalid target pairs, duplicate timeframes and unsafe amounts",
  async () => {
    const f = await fixture()
    const p = await f.assigned()
    await assert.rejects(
      f.db.insert(GatewayUsageAssignmentTable).values({
        id: randomUUID(),
        organizationId: f.admin.organizationId,
        policyId: p.id,
        createdAt: new Date(),
      }),
    )
    await assert.rejects(
      f.db
        .insert(GatewayUsageLimitTable)
        .values({ policyId: p.id, timeframe: "day", costLimitMicroUsd: 1 }),
    )
    await assert.rejects(
      f.db
        .update(GatewayUsageLimitTable)
        .set({ costLimitMicroUsd: -1 })
        .where(
          and(
            eq(GatewayUsageLimitTable.policyId, p.id),
            eq(GatewayUsageLimitTable.timeframe, "day"),
          ),
        ),
    )
    assert.equal(
      (
        await f.db
          .select()
          .from(GatewayUsageEventTable)
          .where(eq(GatewayUsageEventTable.memberId, f.member.memberId))
      ).length,
      0,
    )
  },
)

dbTest(
  "raw-to-rollup history replay is quarantined and cannot charge the summary twice",
  async () => {
    const f = await fixture()
    f.setTime("2026-09-10T06:15:00Z")
    const row = f.raw(700_000)
    await f.db.insert(GatewayRequestLogTable).values(row)
    const { buildRollupRows, createDbRollupRepository } = await import(
      "../../../apps/gateway/src/rollups"
    )
    const repository = createDbRollupRepository(f.db)
    await repository.transaction(async (store) => {
      const start = new Date("2026-09-10T06:00:00Z")
      const batch = await store.aggregateRawHour(start, 1000)
      await store.upsertRollups(buildRollupRows("hour", start, batch.groups))
      await store.deleteRawIds(batch.ids)
    })
    assert.equal(
      (
        await f.db
          .select()
          .from(GatewayRequestLogTable)
          .where(eq(GatewayRequestLogTable.id, row.id))
      ).length,
      0,
    )
    f.setTime("2026-09-15T12:00:00Z")
    await f.assigned()
    const initial = await f.service.getStatus(f.member)
    assert.equal(
      initial.buckets.find((bucket) => bucket.timeframe === "month")?.usedMicroUsd,
      700_000,
    )
    await f.service.record(row)
    await f.service.record({
      ...row,
      started_at: new Date("2026-09-15T13:00:00Z"),
      cost_micro_usd: 900_000,
    })
    const after = await f.service.getStatus(f.member)
    assert.equal(
      after.buckets.find((bucket) => bucket.timeframe === "month")?.usedMicroUsd,
      700_000,
    )
    assert.equal(after.coverage.quarantinedRequests, 1)
    assert.equal(after.coverage.complete, false)
    await assert.rejects(
      f.service.admit(f.member, row.openwork_request_id, true),
      (error) => error instanceof GatewayUsageError && error.code === "request_identity_conflict",
    )
    assert.equal(
      (
        await f.db
          .select()
          .from(GatewayUsageEventTable)
          .where(eq(GatewayUsageEventTable.id, row.openwork_request_id))
      ).length,
      0,
    )
  },
)

dbTest("a pending raw identity predating the cutover can settle exactly once", async () => {
  const f = await fixture()
  f.setTime("2026-09-15T10:00:00Z")
  const row = f.raw(900_000)
  await f.db
    .insert(GatewayRequestLogTable)
    .values({ ...row, completed_at: null, cost_micro_usd: null })
  f.setTime("2026-09-15T12:00:00Z")
  await f.assigned()
  assert.equal((await f.service.getStatus(f.member)).coverage.unpricedRequests, 1)
  await f.service.record(row)
  await f.service.record(row)
  const status = await f.service.getStatus(f.member)
  assert.equal(status.buckets[0].usedMicroUsd, 900_000)
  assert.equal(status.coverage.quarantinedRequests, undefined)
  const [event] = await f.db
    .select()
    .from(GatewayUsageEventTable)
    .where(eq(GatewayUsageEventTable.id, row.openwork_request_id))
  assert.equal(event.admittedAt.toISOString(), "2026-09-15T10:00:00.000Z")
})

dbTest(
  "compaction racing first initialization preserves one charge regardless of lock winner",
  async () => {
    const f = await fixture()
    f.setTime("2026-09-11T06:15:00Z")
    const row = f.raw(800_000)
    await f.db.insert(GatewayRequestLogTable).values(row)
    f.setTime("2026-09-15T12:00:00Z")
    await f.assigned()
    const { buildRollupRows, createDbRollupRepository } = await import(
      "../../../apps/gateway/src/rollups"
    )
    const repository = createDbRollupRepository(f.db)
    await Promise.all([
      repository.transaction(async (store) => {
        const start = new Date("2026-09-11T06:00:00Z")
        const batch = await store.aggregateRawHour(start, 1000)
        await store.upsertRollups(buildRollupRows("hour", start, batch.groups))
        await store.deleteRawIds(batch.ids)
      }),
      f.service.getStatus(f.member),
    ])
    await f.service.record(row)
    assert.equal(
      (await f.service.getStatus(f.member)).buckets.find((bucket) => bucket.timeframe === "month")
        ?.usedMicroUsd,
      800_000,
    )
  },
)

dbTest(
  "assignment transitions invalidate pending resets without reads and spare unrelated members",
  async () => {
    const f = await fixture()
    const other = await f.addMember()
    const p = await f.assigned()
    await f.service.assign(f.admin, p.id, { memberId: other.memberId })
    const assignments = (await f.service.listPolicies(f.admin)).policies[0].assignments
    const ownAssignment = assignments.find(
      (assignment) => assignment.memberId === f.member.memberId,
    )
    assert.ok(ownAssignment)
    await f.service.record(f.raw(1_000_000))
    await f.service.record(f.raw(1_000_000, other))
    const ownDay = (await f.service.getStatus(f.member)).buckets[0]
    const otherDay = (await f.service.getStatus(other)).buckets[0]
    const ownRequest = await f.service.submitReset(f.member, ownDay.id, "Own request")
    const otherRequest = await f.service.submitReset(other, otherDay.id, "Other request")
    await f.service.unassign(f.admin, p.id, ownAssignment.id)
    await f.service.assign(f.admin, p.id, { memberId: f.member.memberId })
    assert.equal(
      (await f.service.reviewReset(f.admin, ownRequest.id, "approved")).status,
      "expired",
    )
    assert.equal(
      (await f.service.reviewReset(f.admin, otherRequest.id, "approved")).status,
      "approved",
    )

    const next = await f.service.submitReset(f.member, ownDay.id, "Next request")
    const higher = await f.service.savePolicy(f.admin, {
      ...f.body,
      limits: [{ timeframe: "day", costUsd: "10" }],
    })
    const assigned = await f.service.assign(f.admin, higher.id, { memberId: f.member.memberId })
    await f.service.unassign(f.admin, higher.id, assigned.assignments[0].id)
    assert.equal((await f.service.reviewReset(f.admin, next.id, "approved")).status, "expired")

    const unchanged = await f.service.submitReset(f.member, ownDay.id, "Idempotent assignment")
    const lower = await f.service.savePolicy(f.admin, {
      ...f.body,
      limits: [{ timeframe: "day", costUsd: "0.5" }],
    })
    await f.service.assign(f.admin, lower.id, { memberId: f.member.memberId })
    await f.service.assign(f.admin, p.id, { memberId: f.member.memberId })
    assert.equal(
      (await f.service.reviewReset(f.admin, unchanged.id, "approved")).status,
      "approved",
    )
  },
)

dbTest("exact 05UTC and later rollover preserve old extensions and late charges", async () => {
  for (const rollover of ["2026-09-16T05:00:00.000Z", "2026-09-16T05:00:00.001Z"]) {
    const f = await fixture()
    await f.assigned()
    await f.service.record(f.raw(1_000_000))
    const day = (await f.service.getStatus(f.member)).buckets[0]
    const request = await f.service.submitReset(f.member, day.id, "Rollover")
    await f.service.reviewReset(f.admin, request.id, "approved")
    const late = f.raw(100_000)
    await f.service.admit(f.member, late.openwork_request_id, true)
    f.setTime(rollover)
    const current = await f.service.getStatus(f.member)
    assert.notEqual(current.buckets[0].id, day.id)
    assert.equal(current.buckets[0].extensionMicroUsd, 0)
    await f.service.record(late)
    const [historical] = await f.db
      .select()
      .from(GatewayUsageBucketTable)
      .where(eq(GatewayUsageBucketTable.id, day.id))
    assert.equal(historical.extensionMicroUsd, 250_000)
    assert.equal(historical.usedMicroUsd, 1_100_000)
    assert.equal(historical.resetAt.toISOString(), day.resetAt)
  }
})

dbTest(
  "own and admin status expose only current effective direct/team provenance with revision",
  async () => {
    const f = await fixture()
    const other = await f.addMember()
    const teamId = createDenTypeId("team")
    await f.db
      .insert(TeamTable)
      .values({ id: teamId, organizationId: f.admin.organizationId, name: "Usage team" })
    await f.db
      .insert(TeamMemberTable)
      .values({ id: createDenTypeId("teamMember"), teamId, orgMembershipId: f.member.memberId })
    const p = await f.assigned()
    await f.service.assign(f.admin, p.id, { teamId })
    await f.service.assign(f.admin, p.id, { memberId: other.memberId })
    const own = gatewayUsageStatusSchema.parse(await f.service.getStatus(f.member))
    const admin = gatewayUsageStatusSchema.parse(
      await f.service.getStatus(f.admin, f.member.memberId),
    )
    assert.deepEqual(own.buckets, admin.buckets)
    for (const bucket of own.buckets) {
      assert.equal(bucket.policyRevision, p.revision)
      assert.equal(bucket.provenance?.length, 2)
      assert.deepEqual(bucket.provenance?.map((entry) => entry.kind).sort(), ["direct", "team"])
      assert.equal(
        bucket.provenance?.some((entry) => entry.memberId === other.memberId),
        false,
      )
      assert.equal(bucket.provenance?.find((entry) => entry.kind === "team")?.teamId, teamId)
    }
  },
)

dbTest(
  "editing a losing policy across the winner and back expires the original request without reads",
  async () => {
    const f = await fixture()
    const a = await f.assigned({ ...f.body, limits: [{ timeframe: "day", costUsd: "100" }] })
    const b = await f.service.savePolicy(f.admin, {
      ...f.body,
      name: "B",
      limits: [{ timeframe: "day", costUsd: "90" }],
    })
    await f.service.assign(f.admin, b.id, { memberId: f.member.memberId })
    await f.service.record(f.raw(100_000_000))
    const day = (await f.service.getStatus(f.member)).buckets[0]
    assert.equal(day.policyId, a.id)
    const request = await f.service.submitReset(
      f.member,
      day.id,
      "Before a transient policy winner",
    )
    const raised = await f.service.savePolicy(
      f.admin,
      { ...f.body, name: "B", limits: [{ timeframe: "day", costUsd: "200" }] },
      b.id,
      b.revision,
    )
    await f.service.savePolicy(
      f.admin,
      { ...f.body, name: "B", limits: [{ timeframe: "day", costUsd: "90" }] },
      b.id,
      raised.revision,
    )
    assert.equal((await f.service.reviewReset(f.admin, request.id, "approved")).status, "expired")
    const current = (await f.service.getStatus(f.member)).buckets[0]
    assert.equal(current.extensionMicroUsd, 0)
    assert.equal(current.usedMicroUsd, 100_000_000)

    const next = await f.service.submitReset(f.member, day.id, "Before transient edit and archive")
    const edited = await f.service.savePolicy(
      f.admin,
      { ...f.body, name: "B", limits: [{ timeframe: "day", costUsd: "200" }] },
      b.id,
      raised.revision + 1,
    )
    await f.service.archivePolicy(f.admin, b.id, edited.revision)
    assert.equal((await f.service.reviewReset(f.admin, next.id, "approved")).status, "expired")
  },
)

dbTest(
  "twenty cross-org first-use pairs initialize and admit concurrently under MySQL RR",
  async () => {
    for (let repeat = 0; repeat < 20; repeat++) {
      const left = await fixture()
      const right = await fixture()
      await left.assigned()
      await right.assigned()
      const statuses = await Promise.all([
        left.service.getStatus(left.member),
        right.service.getStatus(right.member),
      ])
      assert.ok(statuses.every((status) => status.buckets.length === 3))
      const leftId = randomUUID().replaceAll("-", "")
      const rightId = randomUUID().replaceAll("-", "")
      const admissions = await Promise.all([
        left.service.admit(left.member, leftId, true),
        right.service.admit(right.member, rightId, true),
      ])
      assert.ok(admissions.every((admission) => admission.admitted))
      for (const f of [left, right]) {
        assert.equal(
          (
            await f.db
              .select()
              .from(GatewayUsageSubjectTable)
              .where(eq(GatewayUsageSubjectTable.memberId, f.member.memberId))
          ).length,
          1,
        )
        assert.equal(
          (
            await f.db
              .select()
              .from(GatewayUsageEventTable)
              .where(eq(GatewayUsageEventTable.memberId, f.member.memberId))
          ).length,
          1,
        )
      }
    }
  },
)

test("deadlock retry classification excludes ambiguous transport and lock-timeout failures", () => {
  assert.equal(isGatewayUsageDeadlock({ cause: { code: "ER_LOCK_DEADLOCK", errno: 1213 } }), true)
  assert.equal(isGatewayUsageDeadlock({ code: "ECONNRESET" }), false)
  assert.equal(isGatewayUsageDeadlock({ code: "ER_LOCK_WAIT_TIMEOUT", errno: 1205 }), false)
})

dbTest(
  "reset pages bound history, batch pending views, expose all pending pages and never take the admission lock",
  async () => {
    const f = await fixture()
    const organizationId = f.admin.organizationId
    const now = new Date("2026-09-15T12:00:00Z")
    const startAt = new Date("2026-09-15T05:00:00Z")
    const resetAt = new Date("2026-09-16T05:00:00Z")
    const policy = await f.service.savePolicy(f.admin, {
      ...f.body,
      limits: [{ timeframe: "day", costUsd: "1" }],
    })
    const teamId = createDenTypeId("team")
    const people = Array.from({ length: 55 }, () => ({
      memberId: createDenTypeId("member"),
      userId: createDenTypeId("user"),
      bucketId: randomUUID(),
    }))
    await f.db.insert(AuthUserTable).values(
      people.map((person) => ({
        id: person.userId,
        name: "Queue fixture",
        email: `${person.userId}@example.test`,
      })),
    )
    await f.db
      .insert(MemberTable)
      .values(
        people.map((person) => ({ id: person.memberId, userId: person.userId, organizationId })),
      )
    await f.db.insert(TeamTable).values({ id: teamId, organizationId, name: "Queue members" })
    await f.db.insert(TeamMemberTable).values(
      people.map((person) => ({
        id: createDenTypeId("teamMember"),
        teamId,
        orgMembershipId: person.memberId,
      })),
    )
    await f.service.assign(f.admin, policy.id, { teamId })
    await f.db.insert(GatewayUsageSubjectTable).values(
      people.map((person) => ({
        memberId: person.memberId,
        organizationId,
        trackingSince: new Date("2026-09-01T05:00:00Z"),
        initializedAt: now,
      })),
    )
    await f.db.insert(GatewayUsageBucketTable).values(
      people.map((person): typeof GatewayUsageBucketTable.$inferInsert => ({
        id: person.bucketId,
        memberId: person.memberId,
        organizationId,
        timeframe: "day",
        startAt,
        resetAt,
        policyId: policy.id,
        policyName: policy.name,
        policyRevision: policy.revision,
        baseAllowanceMicroUsd: 1_000_000,
        extensionMicroUsd: 0,
        usedMicroUsd: 1_000_000,
        extensionUsed: false,
        hardLimit: true,
        allowRequestReset: true,
      })),
    )
    await f.db.insert(GatewayUsageEventTable).values(
      people.map((person) => ({
        id: randomUUID(),
        memberId: person.memberId,
        organizationId,
        admittedAt: now,
        costMicroUsd: 1_000_000,
        complete: true,
        finalized: true,
        unpricedRequests: 0,
        source: "upstream",
        settledAt: now,
      })),
    )
    const makeRequest = (
      person: (typeof people)[number],
      index: number,
      status: "pending" | "denied",
    ): typeof GatewayUsageResetTable.$inferInsert => ({
      id: randomUUID(),
      organizationId,
      memberId: person.memberId,
      bucketId: person.bucketId,
      policyId: policy.id,
      policyRevision: policy.revision,
      timeframe: "day",
      policyName: policy.name,
      reason: "Queue fixture",
      status,
      pendingBucketId: status === "pending" ? person.bucketId : null,
      baseAllowanceMicroUsd: 1_000_000,
      allowanceMicroUsd: 1_000_000,
      usedMicroUsd: 1_000_000,
      resetAt,
      createdAt: new Date(now.getTime() - index * 1000),
    })
    const pending = people.map((person) => makeRequest(person, 0, "pending"))
    const history = Array.from({ length: 600 }, (_, index) =>
      makeRequest(people[0], index + 1, "denied"),
    )
    await f.db.insert(GatewayUsageResetTable).values([...pending, ...history])
    const first = await f.service.listResets(f.admin, false)
    assert.equal(first.view, "pending")
    assert.equal(first.requests.length, 50)
    assert.equal(first.pendingCount, 55)
    assert.equal(first.hasMore, true)
    assert.ok(first.nextCursor)
    assert.ok(
      first.requests.every(
        (request) => request.status === "pending" && request.usedMicroUsd === 1_000_000,
      ),
    )
    const second = await f.service.listResets(f.admin, false, { cursor: first.nextCursor })
    assert.equal(second.requests.length, 5)
    assert.equal(second.hasMore, false)
    assert.equal(second.nextCursor, null)
    assert.deepEqual(
      new Set([...first.requests, ...second.requests].map((request) => request.id)),
      new Set(pending.map((request) => request.id)),
    )
    const own = await f.service.listResets({ organizationId, memberId: people[0].memberId }, true)
    assert.equal(own.pendingCount, 1)
    assert.equal(own.requests.length, 1)
    const historical = await f.service.listResets(f.admin, false, { view: "history", limit: 10 })
    assert.equal(historical.requests.length, 10)
    assert.equal(historical.pendingCount, 55)
    assert.equal(historical.hasMore, true)
    assert.ok(historical.nextCursor)
    assert.ok(historical.requests.every((request) => request.status === "denied"))
    const more = await f.service.listResets(f.admin, false, {
      view: "history",
      limit: 10,
      cursor: historical.nextCursor,
    })
    assert.equal(
      new Set([...historical.requests, ...more.requests].map((request) => request.id)).size,
      20,
    )
    await assert.rejects(
      f.service.listResets(f.admin, false, { view: "history", cursor: first.nextCursor }),
      (error) => error instanceof GatewayUsageError && error.status === 400,
    )
    await assert.rejects(
      f.service.listResets(f.admin, true, { cursor: first.nextCursor }),
      (error) => error instanceof GatewayUsageError && error.status === 400,
    )
    const other = await fixture()
    await assert.rejects(
      other.service.listResets(other.admin, false, { cursor: first.nextCursor }),
      (error) => error instanceof GatewayUsageError && error.status === 400,
    )
    await assert.rejects(f.service.listResets(f.admin, false, { limit: 101 }))

    let signalLocked = () => {}
    let releaseLock = () => {}
    const locked = new Promise<void>((resolve) => {
      signalLocked = resolve
    })
    const released = new Promise<void>((resolve) => {
      releaseLock = resolve
    })
    const holder = f.db.transaction(async (tx) => {
      await tx
        .select({ id: OrganizationTable.id })
        .from(OrganizationTable)
        .where(eq(OrganizationTable.id, organizationId))
        .for("update")
      signalLocked()
      await released
    })
    await locked
    let timeout: ReturnType<typeof setTimeout> | undefined
    try {
      const page = await Promise.race([
        f.service.listResets(f.admin, false, { view: "history", limit: 10 }),
        new Promise<never>((_, reject) => {
          timeout = setTimeout(
            () => reject(new Error("History listing waited for the admission organization lock")),
            2000,
          )
        }),
      ])
      assert.equal(page.requests.length, 10)
    } finally {
      clearTimeout(timeout)
      releaseLock()
      await holder
    }
    assert.equal(
      (
        await f.db
          .select()
          .from(GatewayUsageResetTable)
          .where(
            and(
              eq(GatewayUsageResetTable.organizationId, organizationId),
              eq(GatewayUsageResetTable.status, "denied"),
            ),
          )
      ).length,
      600,
    )
    assert.equal(
      (
        await f.db
          .select()
          .from(GatewayUsageSubjectTable)
          .where(
            inArray(
              GatewayUsageSubjectTable.memberId,
              people.map((person) => person.memberId),
            ),
          )
      ).length,
      55,
    )
  },
)
