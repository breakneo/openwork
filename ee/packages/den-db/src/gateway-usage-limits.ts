import { randomUUID } from "node:crypto"
import { and, asc, eq, gt, gte, inArray, isNotNull, isNull, lt, or, sql } from "drizzle-orm"
import {
  gatewaySafeMoney,
  gatewayUsagePeriod,
  gatewayUsageTimeframes,
  gatewayUsdToMicroUsd,
  gatewayWinningPolicies,
  type GatewayUsageLimitPolicy,
  type GatewayUsagePolicyWrite,
  type GatewayUsageResetRequest,
  type GatewayUsageStatus,
  type GatewayUsageProvenance,
  type GatewayUsageResetListOptions,
} from "@openwork/types/den/gateway-usage-limits"
import type { createDenDb } from "./client"
import { withGatewayUsageEntitlementMutation } from "./gateway-usage-entitlements"
import { GatewayUsageError, isGatewayUsageDeadlock } from "./gateway-usage-errors"
import { readGatewayUsageResetPage } from "./gateway-usage-reset-page"
export { GatewayUsageError } from "./gateway-usage-errors"
export { withGatewayUsageEntitlementMutation } from "./gateway-usage-entitlements"
export { deleteGatewayUsageForOrganization } from "./gateway-usage-erasure"
import { AuthUserTable } from "./schema/auth"
import { MemberTable, OrganizationTable } from "./schema/org"
import { TeamMemberTable, TeamTable } from "./schema/teams"
import {
  GatewayRequestLogTable,
  GatewayRollupLockTable,
  GatewayUsageRollupTable,
} from "./schema/inference"
import {
  GatewayUsagePolicyTable as P,
  GatewayUsageLimitTable as L,
  GatewayUsageAssignmentTable as A,
  GatewayUsageSubjectTable as S,
  GatewayUsageBucketTable as B,
  GatewayUsageEventTable as E,
  GatewayUsageChargeTable as C,
  GatewayUsageResetTable as R,
  GatewayUsageAuditTable as H,
  GatewayUsageQuarantineTable as Q,
} from "./schema/gateway-usage-limits"

export type GatewayUsageDb = ReturnType<typeof createDenDb>["db"]
type Tx = Parameters<Parameters<GatewayUsageDb["transaction"]>[0]>[0]
export type GatewayUsageScope = {
  organizationId: typeof MemberTable.$inferSelect.organizationId
  memberId: typeof MemberTable.$inferSelect.id
}
type BucketRow = typeof B.$inferSelect
const fail = (code: string, status: 400 | 403 | 404 | 409 | 503, message: string): never => {
  throw new GatewayUsageError(code, status, message)
}
const scopeWhere = (scope: GatewayUsageScope) =>
  and(eq(E.organizationId, scope.organizationId), eq(E.memberId, scope.memberId))

export function createGatewayUsageLimits(db: GatewayUsageDb, clock = () => new Date()) {
  async function locked<T>(
    scope: GatewayUsageScope,
    run: (tx: Tx, now: Date) => Promise<T>,
  ): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await db.transaction(async (tx) => {
          const [organization] = await tx
            .select({ id: OrganizationTable.id })
            .from(OrganizationTable)
            .where(eq(OrganizationTable.id, scope.organizationId))
            .for("update")
          if (!organization) return fail("organization_not_found", 404, "Organization not found.")
          return run(tx, clock())
        })
      } catch (error) {
        if (!isGatewayUsageDeadlock(error) || attempt >= 2) throw error
        await new Promise((resolve) => setTimeout(resolve, 5 * (attempt + 1)))
      }
    }
  }
  async function activeMember(tx: Tx, scope: GatewayUsageScope, admin = false) {
    const [member] = await tx
      .select()
      .from(MemberTable)
      .where(
        and(
          eq(MemberTable.id, scope.memberId),
          eq(MemberTable.organizationId, scope.organizationId),
          isNull(MemberTable.removedAt),
          isNotNull(MemberTable.userId),
        ),
      )
      .for("share")
    if (!member) return fail("member_not_found", 404, "Current organization member not found.")
    if (
      admin &&
      !member.role
        .split(",")
        .some((role) => ["owner", "admin", "super-admin"].includes(role.trim()))
    ) {
      const teams = await tx
        .select({ id: TeamTable.id })
        .from(TeamMemberTable)
        .innerJoin(
          TeamTable,
          and(
            eq(TeamTable.id, TeamMemberTable.teamId),
            eq(TeamTable.organizationId, scope.organizationId),
            eq(TeamTable.grantsOrganizationAdmin, true),
          ),
        )
        .where(eq(TeamMemberTable.orgMembershipId, scope.memberId))
        .for("share")
      if (!teams.length)
        return fail("forbidden", 403, "Only workspace owners and admins can manage usage limits.")
    }
    return member
  }
  async function audit(
    tx: Tx,
    scope: GatewayUsageScope,
    subjectId: string,
    action: string,
    details: Record<string, unknown>,
    now: Date,
  ) {
    await tx.insert(H).values({
      id: randomUUID(),
      organizationId: scope.organizationId,
      actorId: scope.memberId,
      subjectId,
      action,
      details,
      createdAt: now,
    })
  }
  async function policies(
    tx: Tx,
    organizationId: GatewayUsageScope["organizationId"],
  ): Promise<GatewayUsageLimitPolicy[]> {
    const rows = await tx
      .select()
      .from(P)
      .where(eq(P.organizationId, organizationId))
      .orderBy(asc(P.id))
      .for("share")
    if (!rows.length) return []
    const ids = rows.map((row) => row.id)
    const limits = await tx.select().from(L).where(inArray(L.policyId, ids)).for("share")
    const assignments = await tx
      .select()
      .from(A)
      .where(and(eq(A.organizationId, organizationId), inArray(A.policyId, ids)))
      .for("share")
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      hardLimit: row.hardLimit,
      allowRequestReset: row.allowRequestReset,
      revision: row.revision,
      archivedAt: row.archivedAt?.toISOString() ?? null,
      limits: limits
        .filter((limit) => limit.policyId === row.id)
        .map(({ timeframe, costLimitMicroUsd }) => ({
          timeframe,
          costLimitMicroUsd: gatewaySafeMoney(costLimitMicroUsd),
        })),
      assignments: assignments
        .filter((assignment) => assignment.policyId === row.id)
        .map(({ id, memberId, teamId }) => ({ id, memberId, teamId })),
    }))
  }
  async function effective(tx: Tx, scope: GatewayUsageScope) {
    const teams = await tx
      .select({ id: TeamTable.id, name: TeamTable.name })
      .from(TeamMemberTable)
      .innerJoin(
        TeamTable,
        and(
          eq(TeamTable.id, TeamMemberTable.teamId),
          eq(TeamTable.organizationId, scope.organizationId),
        ),
      )
      .where(eq(TeamMemberTable.orgMembershipId, scope.memberId))
      .for("share")
    const names = new Map<string, string>(teams.map((team) => [team.id, team.name]))
    const reachable = (await policies(tx, scope.organizationId))
      .map((policy) => ({
        ...policy,
        assignments: policy.assignments.filter(
          (assignment) =>
            assignment.memberId === scope.memberId ||
            (assignment.teamId !== null && names.has(assignment.teamId)),
        ),
      }))
      .filter((policy) => policy.assignments.length > 0)

    return gatewayWinningPolicies(reachable).map((winner) => ({
      ...winner,
      provenance: winner.policy.assignments
        .map((assignment): GatewayUsageProvenance => {
          if (assignment.memberId === scope.memberId && assignment.teamId === null) {
            return {
              kind: "direct",
              assignmentId: assignment.id,
              memberId: scope.memberId,
              teamId: null,
            }
          }
          const teamName = assignment.teamId === null ? undefined : names.get(assignment.teamId)
          if (
            assignment.memberId !== null ||
            assignment.teamId === null ||
            teamName === undefined
          ) {
            return fail("invalid_provenance", 503, "Effective policy provenance is invalid.")
          }
          return {
            kind: "team",
            assignmentId: assignment.id,
            memberId: null,
            teamId: assignment.teamId,
            teamName,
          }
        })
        .sort((left, right) => left.assignmentId.localeCompare(right.assignmentId)),
    }))
  }
  async function putRawEvent(tx: Tx, row: typeof GatewayRequestLogTable.$inferInsert, now: Date) {
    if (row.route !== "org_provider") return false
    const id = row.openwork_request_id
    const [existing] = await tx.select().from(E).where(eq(E.id, id)).for("update")
    if (
      existing &&
      (existing.organizationId !== row.organization_id ||
        existing.memberId !== row.org_membership_id)
    )
      return fail(
        "request_identity_conflict",
        409,
        "Request identity already belongs to another subject.",
      )
    if (existing?.finalized) return false
    const rejected = row.outcome === "rejected"
    const cost = rejected ? 0 : (row.cost_micro_usd ?? null)
    if (cost !== null) gatewaySafeMoney(cost)
    const finalized = row.completed_at != null
    const complete =
      finalized &&
      (rejected || (row.outcome === "ok" && cost !== null && row.metadata?.cost_complete === true))
    const values = {
      costMicroUsd: cost,
      complete,
      unpricedRequests: cost === null && !rejected ? 1 : 0,
      finalized,
      source: rejected
        ? "not_dispatched"
        : typeof row.metadata?.cost_source === "string"
          ? row.metadata.cost_source
          : "unknown",
      settledAt: finalized ? now : null,
    }
    if (existing) await tx.update(E).set(values).where(eq(E.id, id))
    else
      await tx.insert(E).values({
        id,
        organizationId: row.organization_id,
        memberId: row.org_membership_id,
        admittedAt: row.started_at,
        ...values,
      })
    return true
  }
  async function initialize(tx: Tx, scope: GatewayUsageScope, now: Date) {
    const [subject] = await tx.select().from(S).where(eq(S.memberId, scope.memberId))
    if (subject) {
      if (subject.organizationId !== scope.organizationId)
        return fail("subject_mismatch", 409, "Accounting subject mismatch.")
      return subject
    }
    await tx
      .insert(GatewayRollupLockTable)
      .values({ id: 1 })
      .onDuplicateKeyUpdate({ set: { id: 1 } })
    const [initialized] = await tx
      .select()
      .from(S)
      .where(eq(S.memberId, scope.memberId))
      .for("update")
    if (initialized) {
      if (initialized.organizationId !== scope.organizationId)
        return fail("subject_mismatch", 409, "Accounting subject mismatch.")
      return initialized
    }
    const trackingSince = new Date(
      Math.min(
        ...gatewayUsageTimeframes.map((timeframe) =>
          gatewayUsagePeriod(timeframe, now).start.getTime(),
        ),
      ),
    )
    const raw = await tx
      .select()
      .from(GatewayRequestLogTable)
      .where(
        and(
          eq(GatewayRequestLogTable.organization_id, scope.organizationId),
          eq(GatewayRequestLogTable.org_membership_id, scope.memberId),
          eq(GatewayRequestLogTable.route, "org_provider"),
          gte(GatewayRequestLogTable.started_at, trackingSince),
        ),
      )
      .for("update")
    for (const row of raw) await putRawEvent(tx, row, now)
    const rollups = await tx
      .select()
      .from(GatewayUsageRollupTable)
      .where(
        and(
          eq(GatewayUsageRollupTable.organization_id, scope.organizationId),
          eq(GatewayUsageRollupTable.org_membership_id, scope.memberId),
          eq(GatewayUsageRollupTable.route, "org_provider"),
          gte(GatewayUsageRollupTable.bucket_start, trackingSince),
        ),
      )
      .for("share")
    for (const row of rollups) {
      if (row.granularity !== "hour")
        return fail(
          "history_unavailable",
          503,
          "Calendar history requires hourly accounting coverage.",
        )
      await tx.insert(E).values({
        id: `history:${row.id}`,
        organizationId: scope.organizationId,
        memberId: scope.memberId,
        admittedAt: row.bucket_start,
        costMicroUsd: gatewaySafeMoney(row.cost_micro_usd),
        unpricedRequests:
          row.cost_count === null
            ? row.request_count
            : gatewaySafeMoney(row.request_count - row.cost_count),
        complete: false,
        finalized: true,
        source: "historical_rollup",
        settledAt: now,
      })
    }
    const inserted = {
      memberId: scope.memberId,
      organizationId: scope.organizationId,
      trackingSince,
      initializedAt: now,
    }
    await tx.insert(S).values(inserted)
    return inserted
  }
  async function quarantineHistoricalReplay(
    tx: Tx,
    row: typeof GatewayRequestLogTable.$inferInsert,
    cutover: Date,
    now: Date,
  ) {
    const [quarantined] = await tx
      .select()
      .from(Q)
      .where(eq(Q.id, row.openwork_request_id))
      .for("update")
    if (quarantined) {
      if (
        quarantined.organizationId !== row.organization_id ||
        quarantined.memberId !== row.org_membership_id
      ) {
        return fail(
          "request_identity_conflict",
          409,
          "Quarantined request belongs to another subject.",
        )
      }
      return true
    }
    const [existing] = await tx
      .select({ id: E.id })
      .from(E)
      .where(eq(E.id, row.openwork_request_id))
      .for("update")
    if (existing || row.started_at >= cutover) return false

    const costMicroUsd = row.cost_micro_usd ?? null
    if (costMicroUsd !== null) gatewaySafeMoney(costMicroUsd)
    await tx.insert(Q).values({
      id: row.openwork_request_id,
      organizationId: row.organization_id,
      memberId: row.org_membership_id,
      admittedAt: row.started_at,
      receivedAt: now,
      costMicroUsd,
      reason: "pre_cutover_identity_missing",
    })
    return true
  }

  function eventsWhere(scope: GatewayUsageScope, start: Date, end: Date) {
    return and(scopeWhere(scope), gte(E.admittedAt, start), lt(E.admittedAt, end))
  }
  async function charge(tx: Tx, bucket: BucketRow) {
    const where = eventsWhere(bucket, bucket.startAt, bucket.resetAt)
    const missing = tx
      .select({
        eventId: E.id,
        bucketId: sql<string>`${bucket.id}`.as("bucket_id"),
        amount: sql<number>`coalesce(${E.costMicroUsd}, 0)`.as("amount"),
        policyId: sql<string>`${bucket.policyId}`.as("policy_id"),
        policyRevision: sql<number>`${bucket.policyRevision}`.as("policy_revision"),
      })
      .from(E)
      .leftJoin(C, and(eq(C.eventId, E.id), eq(C.bucketId, bucket.id)))
      .where(and(where, or(isNull(C.eventId), sql`${C.amount} <> coalesce(${E.costMicroUsd}, 0)`)))
    await tx
      .insert(C)
      .select(missing)
      .onDuplicateKeyUpdate({ set: { amount: sql`values(amount)` } })
    const [total] = await tx
      .select({ amount: sql<string>`cast(coalesce(sum(${E.costMicroUsd}), 0) as char)` })
      .from(E)
      .where(where)
    if (!total) return fail("accounting_unavailable", 503, "Accounting totals are unavailable.")
    const usedMicroUsd = gatewaySafeMoney(Number(total.amount))
    if (bucket.usedMicroUsd !== usedMicroUsd)
      await tx.update(B).set({ usedMicroUsd }).where(eq(B.id, bucket.id))
    return { ...bucket, usedMicroUsd }
  }
  async function expire(tx: Tx, bucketId: string) {
    await tx
      .update(R)
      .set({ status: "expired", pendingBucketId: null })
      .where(and(eq(R.bucketId, bucketId), eq(R.status, "pending")))
  }
  async function sync(tx: Tx, scope: GatewayUsageScope, now: Date) {
    const subject = await initialize(tx, scope, now)
    const winners = await effective(tx, scope)
    const buckets: BucketRow[] = []
    const current = await tx
      .select()
      .from(B)
      .where(
        and(
          eq(B.organizationId, scope.organizationId),
          eq(B.memberId, scope.memberId),
          gt(B.resetAt, now),
        ),
      )
      .for("update")
    for (const bucket of current)
      if (!winners.some(({ limit }) => limit.timeframe === bucket.timeframe)) {
        await expire(tx, bucket.id)
        if (bucket.extensionMicroUsd)
          await tx.update(B).set({ extensionMicroUsd: 0 }).where(eq(B.id, bucket.id))
      }
    for (const { policy, limit } of winners) {
      const period = gatewayUsagePeriod(limit.timeframe, now)
      let bucket = current.find(
        (row) =>
          row.timeframe === limit.timeframe && row.startAt.getTime() === period.start.getTime(),
      )
      const entitlement = {
        policyId: policy.id,
        policyName: policy.name,
        policyRevision: policy.revision,
        baseAllowanceMicroUsd: limit.costLimitMicroUsd,
        hardLimit: policy.hardLimit,
        allowRequestReset: policy.allowRequestReset,
      }
      if (!bucket) {
        bucket = {
          id: randomUUID(),
          organizationId: scope.organizationId,
          memberId: scope.memberId,
          timeframe: limit.timeframe,
          startAt: period.start,
          resetAt: period.end,
          extensionMicroUsd: 0,
          extensionUsed: false,
          usedMicroUsd: 0,
          ...entitlement,
        }
        await tx.insert(B).values(bucket)
        await audit(tx, scope, bucket.id, "bucket_created", entitlement, now)
      } else if (bucket.policyId !== policy.id || bucket.policyRevision !== policy.revision) {
        await expire(tx, bucket.id)
        await audit(
          tx,
          scope,
          bucket.id,
          "bucket_rebased",
          {
            previousPolicyId: bucket.policyId,
            previousRevision: bucket.policyRevision,
            previousBase: bucket.baseAllowanceMicroUsd,
            previousExtension: bucket.extensionMicroUsd,
            ...entitlement,
          },
          now,
        )
        bucket = { ...bucket, ...entitlement, extensionMicroUsd: 0 }
        await tx
          .update(B)
          .set({ ...entitlement, extensionMicroUsd: 0 })
          .where(eq(B.id, bucket.id))
      }
      buckets.push(await charge(tx, bucket))
    }
    await tx
      .update(R)
      .set({ status: "expired", pendingBucketId: null })
      .where(
        and(
          eq(R.organizationId, scope.organizationId),
          eq(R.memberId, scope.memberId),
          eq(R.status, "pending"),
          sql`${R.resetAt} <= ${now}`,
        ),
      )
    return { buckets, subject, winners }
  }
  async function status(tx: Tx, scope: GatewayUsageScope, now: Date): Promise<GatewayUsageStatus> {
    await activeMember(tx, scope)
    const { buckets, subject, winners } = await sync(tx, scope, now)
    const requests = await tx
      .select()
      .from(R)
      .where(and(eq(R.organizationId, scope.organizationId), eq(R.memberId, scope.memberId)))
      .orderBy(asc(R.createdAt), asc(R.id))
      .for("share")
    const start = new Date(
      Math.min(
        ...(buckets.length
          ? buckets.map((bucket) => bucket.startAt.getTime())
          : gatewayUsageTimeframes.map((timeframe) =>
              gatewayUsagePeriod(timeframe, now).start.getTime(),
            )),
      ),
    )
    const [coverage] = await tx
      .select({
        incomplete: sql<string>`cast(coalesce(sum(case when ${E.complete} = false then 1 else 0 end), 0) as char)`,
        unpriced: sql<string>`cast(coalesce(sum(${E.unpricedRequests}), 0) as char)`,
      })
      .from(E)
      .where(eventsWhere(scope, start, new Date(now.getTime() + 1)))
    if (!coverage) return fail("accounting_unavailable", 503, "Accounting coverage is unavailable.")
    const [quarantine] = await tx
      .select({ count: sql<string>`cast(count(*) as char)` })
      .from(Q)
      .where(
        and(
          eq(Q.organizationId, scope.organizationId),
          eq(Q.memberId, scope.memberId),
          gte(Q.admittedAt, start),
          lt(Q.admittedAt, new Date(now.getTime() + 1)),
        ),
      )
    if (!quarantine)
      return fail("accounting_unavailable", 503, "Quarantine coverage is unavailable.")
    const quarantinedRequests = gatewaySafeMoney(Number(quarantine.count))
    const views = buckets.map((bucket) => {
      const winner = winners.find(
        ({ policy, limit }) =>
          policy.id === bucket.policyId &&
          policy.revision === bucket.policyRevision &&
          limit.timeframe === bucket.timeframe,
      )
      if (!winner) return fail("invalid_provenance", 503, "Effective bucket policy changed.")
      const request = requests.filter((request) => request.bucketId === bucket.id).at(-1)
      const allowanceMicroUsd = gatewaySafeMoney(
        bucket.baseAllowanceMicroUsd + bucket.extensionMicroUsd,
      )
      return {
        id: bucket.id,
        timeframe: bucket.timeframe,
        policyId: bucket.policyId,
        policyName: bucket.policyName,
        policyRevision: bucket.policyRevision,
        provenance: winner.provenance,
        baseAllowanceMicroUsd: bucket.baseAllowanceMicroUsd,
        extensionMicroUsd: bucket.extensionMicroUsd,
        allowanceMicroUsd,
        usedMicroUsd: bucket.usedMicroUsd,
        remainingMicroUsd: allowanceMicroUsd - bucket.usedMicroUsd,
        resetAt: bucket.resetAt.toISOString(),
        hardLimit: bucket.hardLimit,
        allowRequestReset: bucket.allowRequestReset,
        canRequestReset:
          bucket.allowRequestReset &&
          bucket.baseAllowanceMicroUsd > 0 &&
          !bucket.extensionUsed &&
          bucket.usedMicroUsd >= allowanceMicroUsd &&
          request?.status !== "pending",
        resetRequestStatus: request?.status ?? null,
      }
    })
    return {
      serverTime: now.toISOString(),
      ...scope,
      state: !views.length
        ? "unlimited"
        : views.some(
              (bucket) => bucket.hardLimit && bucket.usedMicroUsd >= bucket.allowanceMicroUsd,
            )
          ? "blocked"
          : views.some((bucket) => bucket.usedMicroUsd >= bucket.allowanceMicroUsd)
            ? "over_limit"
            : "within_limit",
      coverage: {
        complete:
          subject.trackingSince <= start &&
          gatewaySafeMoney(Number(coverage.incomplete)) === 0 &&
          quarantinedRequests === 0,
        unpricedRequests: gatewaySafeMoney(Number(coverage.unpriced)),
        ...(quarantinedRequests > 0 ? { quarantinedRequests } : {}),
      },
      buckets: views,
    }
  }
  async function policyById(tx: Tx, scope: GatewayUsageScope, id: string) {
    const [policy] = await tx
      .select()
      .from(P)
      .where(and(eq(P.id, id), eq(P.organizationId, scope.organizationId)))
      .for("update")
    if (!policy) return fail("policy_not_found", 404, "Policy not found.")
    return policy
  }
  async function policyView(tx: Tx, scope: GatewayUsageScope, id: string) {
    const policy = (await policies(tx, scope.organizationId)).find((policy) => policy.id === id)
    if (!policy) return fail("policy_not_found", 404, "Policy not found.")
    return policy
  }
  async function invalidatePolicyRequests(tx: Tx, policyId: string) {
    await tx
      .update(R)
      .set({ status: "expired", pendingBucketId: null })
      .where(and(eq(R.policyId, policyId), eq(R.status, "pending")))
  }
  async function requestView(
    tx: Tx,
    row: typeof R.$inferSelect,
  ): Promise<GatewayUsageResetRequest> {
    const [user] = await tx
      .select({ name: AuthUserTable.name, email: AuthUserTable.email })
      .from(MemberTable)
      .leftJoin(AuthUserTable, eq(AuthUserTable.id, MemberTable.userId))
      .where(
        and(eq(MemberTable.id, row.memberId), eq(MemberTable.organizationId, row.organizationId)),
      )
    const [bucket] = await tx.select().from(B).where(eq(B.id, row.bucketId))
    return {
      id: row.id,
      memberId: row.memberId,
      memberName: user?.name ?? "Removed member",
      memberEmail: user?.email ?? "",
      bucketId: row.bucketId,
      timeframe: row.timeframe,
      policyName: row.policyName,
      reason: row.reason,
      status: row.status,
      createdAt: row.createdAt.toISOString(),
      reviewedBy: row.reviewedBy,
      reviewedAt: row.reviewedAt?.toISOString() ?? null,
      baseAllowanceMicroUsd: row.baseAllowanceMicroUsd,
      allowanceMicroUsd:
        row.status === "pending" && bucket
          ? gatewaySafeMoney(bucket.baseAllowanceMicroUsd + bucket.extensionMicroUsd)
          : row.allowanceMicroUsd,
      usedMicroUsd: row.status === "pending" && bucket ? bucket.usedMicroUsd : row.usedMicroUsd,
      resetAt: row.resetAt.toISOString(),
    }
  }
  async function refreshRequest(tx: Tx, row: typeof R.$inferSelect, now: Date) {
    if (row.status !== "pending") return row
    const member = await tx
      .select({ id: MemberTable.id })
      .from(MemberTable)
      .where(
        and(
          eq(MemberTable.id, row.memberId),
          eq(MemberTable.organizationId, row.organizationId),
          isNull(MemberTable.removedAt),
          isNotNull(MemberTable.userId),
        ),
      )
      .for("share")
    const buckets = member.length
      ? (await sync(tx, { organizationId: row.organizationId, memberId: row.memberId }, now))
          .buckets
      : []
    const bucket = buckets.find(
      (bucket) =>
        bucket.id === row.bucketId &&
        bucket.policyId === row.policyId &&
        bucket.policyRevision === row.policyRevision &&
        bucket.baseAllowanceMicroUsd === row.baseAllowanceMicroUsd &&
        bucket.allowRequestReset &&
        !bucket.extensionUsed &&
        bucket.resetAt > now,
    )
    if (!bucket) {
      await expire(tx, row.bucketId)
      return { ...row, status: "expired", pendingBucketId: null } satisfies typeof R.$inferSelect
    }
    return row
  }
  return {
    listPolicies(scope: GatewayUsageScope) {
      return locked(scope, async (tx) => {
        await activeMember(tx, scope, true)
        return { policies: await policies(tx, scope.organizationId) }
      })
    },
    savePolicy(
      scope: GatewayUsageScope,
      input: GatewayUsagePolicyWrite,
      id?: string,
      revision?: number,
    ) {
      return locked(scope, (tx, now) =>
        withGatewayUsageEntitlementMutation(tx, scope.organizationId, async () => {
          await activeMember(tx, scope, true)
          const policyId = id ?? randomUUID()
          const previous = id ? await policyById(tx, scope, id) : null
          if (previous && (previous.archivedAt || previous.revision !== revision))
            return fail("policy_revision_conflict", 409, "Policy changed. Reload before editing.")
          const nextRevision = previous ? previous.revision + 1 : 1
          if (nextRevision > 2_147_483_647)
            return fail("policy_revision_overflow", 409, "Policy revision exhausted.")
          const fields = {
            name: input.name,
            hardLimit: input.hardLimit,
            allowRequestReset: input.allowRequestReset,
            revision: nextRevision,
            updatedAt: now,
          }
          if (previous) {
            await tx.update(P).set(fields).where(eq(P.id, policyId))
            await tx.delete(L).where(eq(L.policyId, policyId))
            await invalidatePolicyRequests(tx, policyId)
          } else
            await tx.insert(P).values({
              id: policyId,
              organizationId: scope.organizationId,
              createdAt: now,
              createdBy: scope.memberId,
              ...fields,
            })
          await tx.insert(L).values(
            input.limits.map((limit) => ({
              policyId,
              timeframe: limit.timeframe,
              costLimitMicroUsd: gatewayUsdToMicroUsd(limit.costUsd),
            })),
          )
          await audit(
            tx,
            scope,
            policyId,
            previous ? "policy_updated" : "policy_created",
            { previous, ...fields, limits: input.limits },
            now,
          )
          return policyView(tx, scope, policyId)
        }),
      )
    },
    archivePolicy(scope: GatewayUsageScope, id: string, revision: number) {
      return locked(scope, (tx, now) =>
        withGatewayUsageEntitlementMutation(tx, scope.organizationId, async () => {
          await activeMember(tx, scope, true)
          const policy = await policyById(tx, scope, id)
          if (policy.revision !== revision)
            return fail("policy_revision_conflict", 409, "Policy changed. Reload before archiving.")
          if (!policy.archivedAt) {
            await tx
              .update(P)
              .set({ archivedAt: now, updatedAt: now, revision: revision + 1 })
              .where(eq(P.id, id))
            await invalidatePolicyRequests(tx, id)
            await audit(tx, scope, id, "policy_archived", { revision }, now)
          }
          return policyView(tx, scope, id)
        }),
      )
    },
    assign(
      scope: GatewayUsageScope,
      policyId: string,
      target:
        | { memberId: GatewayUsageScope["memberId"] }
        | { teamId: typeof TeamTable.$inferSelect.id },
    ) {
      return locked(scope, (tx, now) =>
        withGatewayUsageEntitlementMutation(tx, scope.organizationId, async () => {
          await activeMember(tx, scope, true)
          const policy = await policyById(tx, scope, policyId)
          if (policy.archivedAt)
            return fail("policy_archived", 409, "Archived policies cannot be assigned.")
          const memberId = "memberId" in target ? target.memberId : null
          const teamId = "teamId" in target ? target.teamId : null
          if (memberId) await activeMember(tx, { ...scope, memberId })
          if (teamId) {
            const [team] = await tx
              .select()
              .from(TeamTable)
              .where(
                and(eq(TeamTable.id, teamId), eq(TeamTable.organizationId, scope.organizationId)),
              )
              .for("share")
            if (!team) return fail("team_not_found", 404, "Organization team not found.")
          }
          await tx
            .insert(A)
            .values({
              id: randomUUID(),
              policyId,
              organizationId: scope.organizationId,
              memberId,
              teamId,
              createdAt: now,
            })
            .onDuplicateKeyUpdate({ set: { policyId } })
          await audit(tx, scope, policyId, "policy_assigned", target, now)
          return policyView(tx, scope, policyId)
        }),
      )
    },
    unassign(scope: GatewayUsageScope, policyId: string, assignmentId: string) {
      return locked(scope, (tx, now) =>
        withGatewayUsageEntitlementMutation(tx, scope.organizationId, async () => {
          await activeMember(tx, scope, true)
          await policyById(tx, scope, policyId)
          await tx
            .delete(A)
            .where(
              and(
                eq(A.id, assignmentId),
                eq(A.policyId, policyId),
                eq(A.organizationId, scope.organizationId),
              ),
            )
          await audit(tx, scope, policyId, "policy_unassigned", { assignmentId }, now)
          return policyView(tx, scope, policyId)
        }),
      )
    },
    members(scope: GatewayUsageScope, query = "") {
      return locked(scope, async (tx) => {
        await activeMember(tx, scope, true)
        return {
          members: await tx
            .select({ id: MemberTable.id, name: AuthUserTable.name, email: AuthUserTable.email })
            .from(MemberTable)
            .innerJoin(AuthUserTable, eq(AuthUserTable.id, MemberTable.userId))
            .where(
              and(
                eq(MemberTable.organizationId, scope.organizationId),
                isNull(MemberTable.removedAt),
                query
                  ? or(
                      sql`locate(${query}, ${AuthUserTable.name}) > 0`,
                      sql`locate(${query}, ${AuthUserTable.email}) > 0`,
                    )
                  : undefined,
              ),
            )
            .orderBy(asc(AuthUserTable.name), asc(MemberTable.id))
            .limit(100),
        }
      })
    },
    getStatus(scope: GatewayUsageScope, memberId?: GatewayUsageScope["memberId"]) {
      return locked(scope, async (tx, now) => {
        if (memberId !== undefined) await activeMember(tx, scope, true)
        return status(tx, { ...scope, memberId: memberId ?? scope.memberId }, now)
      })
    },
    admit(scope: GatewayUsageScope, requestId: string, accountable: boolean) {
      return locked(scope, async (tx, now) => {
        const usage = await status(tx, scope, now)
        if (usage.state === "blocked")
          return { usage, admitted: false, accountingUnavailable: false }
        if (!accountable && usage.buckets.some((bucket) => bucket.hardLimit))
          return { usage, admitted: false, accountingUnavailable: true }
        const [quarantined] = await tx
          .select({ id: Q.id })
          .from(Q)
          .where(eq(Q.id, requestId))
          .for("update")
        if (quarantined)
          return fail("request_identity_conflict", 409, "Request identity is quarantined.")
        const [event] = await tx.select().from(E).where(eq(E.id, requestId)).for("update")
        if (
          event &&
          (event.organizationId !== scope.organizationId ||
            event.memberId !== scope.memberId ||
            event.finalized ||
            event.source === "pending")
        )
          return fail("request_identity_conflict", 409, "Request identity already admitted.")
        if (event)
          await tx.update(E).set({ admittedAt: now, source: "pending" }).where(eq(E.id, requestId))
        else
          await tx.insert(E).values({ id: requestId, ...scope, admittedAt: now, source: "pending" })
        for (const bucket of usage.buckets) {
          const [stored] = await tx.select().from(B).where(eq(B.id, bucket.id))
          if (!stored) return fail("bucket_missing", 503, "Admission bucket missing.")
          await tx
            .insert(C)
            .values({
              eventId: requestId,
              bucketId: bucket.id,
              amount: 0,
              policyId: stored.policyId,
              policyRevision: stored.policyRevision,
            })
            .onDuplicateKeyUpdate({
              set: { policyId: stored.policyId, policyRevision: stored.policyRevision },
            })
        }
        return { usage, admitted: true, accountingUnavailable: false }
      })
    },
    record(row: typeof GatewayRequestLogTable.$inferInsert) {
      if (row.route !== "org_provider") return Promise.resolve()
      const scope = { organizationId: row.organization_id, memberId: row.org_membership_id }
      return locked(scope, async (tx, now) => {
        const subject = await initialize(tx, scope, now)
        if (await quarantineHistoricalReplay(tx, row, subject.initializedAt, now)) return
        const accepted = await putRawEvent(tx, row, now)
        if (accepted)
          await tx
            .update(GatewayRequestLogTable)
            .set(row)
            .where(eq(GatewayRequestLogTable.id, row.id))
        const [event] = await tx.select().from(E).where(eq(E.id, row.openwork_request_id))
        if (!event) return fail("event_missing", 503, "Settlement event missing.")
        const buckets = await tx
          .select()
          .from(B)
          .where(
            and(
              eq(B.organizationId, scope.organizationId),
              eq(B.memberId, scope.memberId),
              sql`${B.startAt} <= ${event.admittedAt}`,
              sql`${B.resetAt} > ${event.admittedAt}`,
            ),
          )
          .for("update")
        for (const bucket of buckets) await charge(tx, bucket)
      })
    },
    submitReset(scope: GatewayUsageScope, bucketId: string, reason: string) {
      return locked(scope, async (tx, now) => {
        const usage = await status(tx, scope, now)
        const view = usage.buckets.find((bucket) => bucket.id === bucketId)
        if (!view) return fail("bucket_not_found", 404, "Current own bucket not found.")
        const [pending] = await tx
          .select()
          .from(R)
          .where(and(eq(R.bucketId, bucketId), eq(R.status, "pending")))
          .for("update")
        if (pending) return requestView(tx, pending)
        if (!view.canRequestReset)
          return fail("reset_not_allowed", 409, "This bucket is not eligible for an extension.")
        if (!reason.trim() || reason.length > 2000)
          return fail("invalid_reason", 400, "A reason of 1–2000 characters is required.")
        const [bucket] = await tx.select().from(B).where(eq(B.id, bucketId))
        if (!bucket) return fail("bucket_not_found", 404, "Bucket not found.")
        const row: typeof R.$inferSelect = {
          id: randomUUID(),
          ...scope,
          bucketId,
          policyId: bucket.policyId,
          policyRevision: bucket.policyRevision,
          timeframe: bucket.timeframe,
          policyName: bucket.policyName,
          reason: reason.trim(),
          status: "pending",
          pendingBucketId: bucketId,
          baseAllowanceMicroUsd: bucket.baseAllowanceMicroUsd,
          allowanceMicroUsd: view.allowanceMicroUsd,
          usedMicroUsd: bucket.usedMicroUsd,
          resetAt: bucket.resetAt,
          createdAt: now,
          reviewedAt: null,
          reviewedBy: null,
          denialNote: null,
        }
        await tx.insert(R).values(row)
        await audit(tx, scope, row.id, "reset_submitted", { bucketId }, now)
        return requestView(tx, row)
      })
    },
    listResets(scope: GatewayUsageScope, own: boolean, options: GatewayUsageResetListOptions = {}) {
      return db.transaction(async (tx) => {
        await activeMember(tx, scope, !own)
        return readGatewayUsageResetPage(tx, scope, own, options, clock())
      })
    },
    reviewReset(
      scope: GatewayUsageScope,
      id: string,
      decision: "approved" | "denied",
      denialNote?: string,
    ) {
      return locked(scope, async (tx, now) => {
        await activeMember(tx, scope, true)
        const [stored] = await tx
          .select()
          .from(R)
          .where(and(eq(R.id, id), eq(R.organizationId, scope.organizationId)))
          .for("update")
        if (!stored) return fail("reset_not_found", 404, "Increase request not found.")
        const row = await refreshRequest(tx, stored, now)
        if (row.status !== "pending") return requestView(tx, row)
        const [bucket] = await tx.select().from(B).where(eq(B.id, row.bucketId)).for("update")
        if (!bucket) return fail("bucket_not_found", 404, "Bucket not found.")
        const extension =
          decision === "approved"
            ? Math.ceil(bucket.baseAllowanceMicroUsd / 4)
            : bucket.extensionMicroUsd
        const allowanceMicroUsd = gatewaySafeMoney(bucket.baseAllowanceMicroUsd + extension)
        if (decision === "approved")
          await tx
            .update(B)
            .set({ extensionMicroUsd: extension, extensionUsed: true })
            .where(eq(B.id, bucket.id))
        const updated = {
          ...row,
          status: decision,
          pendingBucketId: null,
          reviewedBy: scope.memberId,
          reviewedAt: now,
          allowanceMicroUsd,
          usedMicroUsd: bucket.usedMicroUsd,
          denialNote: denialNote ?? null,
        }
        await tx.update(R).set(updated).where(eq(R.id, id))
        await audit(
          tx,
          scope,
          id,
          `reset_${decision}`,
          {
            bucketId: bucket.id,
            previousAllowance: row.allowanceMicroUsd,
            allowanceMicroUsd,
            usedMicroUsd: bucket.usedMicroUsd,
          },
          now,
        )
        return requestView(tx, updated)
      })
    },
  }
}
