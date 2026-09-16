import { and, eq, inArray, isNull } from "drizzle-orm"
import type { createDenDb } from "./client"
import {
  gatewayWinningPolicies,
  type GatewayUsageLimitPolicy,
} from "@openwork/types/den/gateway-usage-limits"
import { MemberTable } from "./schema/org"
import { TeamMemberTable, TeamTable } from "./schema/teams"
import {
  GatewayUsageAssignmentTable,
  GatewayUsageLimitTable,
  GatewayUsagePolicyTable,
  GatewayUsageResetTable,
} from "./schema/gateway-usage-limits"

type Db = ReturnType<typeof createDenDb>["db"]
type Transaction = Parameters<Parameters<Db["transaction"]>[0]>[0]
type OrganizationId = typeof MemberTable.$inferSelect.organizationId

async function pendingEntitlements(tx: Transaction, organizationId: OrganizationId) {
  const requests = await tx
    .select()
    .from(GatewayUsageResetTable)
    .where(
      and(
        eq(GatewayUsageResetTable.organizationId, organizationId),
        eq(GatewayUsageResetTable.status, "pending"),
      ),
    )
    .for("update")
  const signatures = new Map<string, string>()
  if (requests.length === 0) return signatures

  const memberIds = [...new Set(requests.map((request) => request.memberId))]
  const members = await tx
    .select()
    .from(MemberTable)
    .where(and(eq(MemberTable.organizationId, organizationId), inArray(MemberTable.id, memberIds)))
    .for("share")
  const memberships = await tx
    .select({ memberId: TeamMemberTable.orgMembershipId, teamId: TeamTable.id })
    .from(TeamMemberTable)
    .innerJoin(
      TeamTable,
      and(eq(TeamTable.id, TeamMemberTable.teamId), eq(TeamTable.organizationId, organizationId)),
    )
    .where(inArray(TeamMemberTable.orgMembershipId, memberIds))
    .for("share")
  const assignments = await tx
    .select({
      assignment: GatewayUsageAssignmentTable,
      limit: GatewayUsageLimitTable,
      policy: GatewayUsagePolicyTable,
    })
    .from(GatewayUsageAssignmentTable)
    .innerJoin(
      GatewayUsagePolicyTable,
      and(
        eq(GatewayUsagePolicyTable.id, GatewayUsageAssignmentTable.policyId),
        eq(GatewayUsagePolicyTable.organizationId, organizationId),
        isNull(GatewayUsagePolicyTable.archivedAt),
      ),
    )
    .innerJoin(
      GatewayUsageLimitTable,
      eq(GatewayUsageLimitTable.policyId, GatewayUsagePolicyTable.id),
    )
    .where(eq(GatewayUsageAssignmentTable.organizationId, organizationId))
    .for("share")

  for (const request of requests) {
    const member = members.find((member) => member.id === request.memberId)
    const active = member?.userId != null && member.removedAt === null
    const teams = new Set(
      memberships
        .filter((entry) => entry.memberId === request.memberId)
        .map((entry) => entry.teamId),
    )
    const candidates = new Map<string, GatewayUsageLimitPolicy>()
    for (const { assignment, limit, policy } of assignments) {
      if (limit.timeframe !== request.timeframe) continue
      if (
        assignment.memberId !== request.memberId &&
        (assignment.teamId === null || !teams.has(assignment.teamId))
      )
        continue
      let candidate = candidates.get(policy.id)
      if (!candidate) {
        candidate = {
          id: policy.id,
          name: policy.name,
          revision: policy.revision,
          hardLimit: policy.hardLimit,
          allowRequestReset: policy.allowRequestReset,
          limits: [{ timeframe: limit.timeframe, costLimitMicroUsd: limit.costLimitMicroUsd }],
          assignments: [],
        }
        candidates.set(policy.id, candidate)
      }
      candidate.assignments.push({
        id: assignment.id,
        memberId: assignment.memberId,
        teamId: assignment.teamId,
      })
    }
    const winner = gatewayWinningPolicies([...candidates.values()])[0]
    signatures.set(
      request.id,
      JSON.stringify([
        active,
        winner?.policy.id,
        winner?.policy.revision,
        winner?.limit.costLimitMicroUsd,
        winner?.policy.assignments.map((assignment) => assignment.id).sort(),
      ]),
    )
  }
  return signatures
}

export async function withGatewayUsageEntitlementMutation<T>(
  tx: Transaction,
  organizationId: OrganizationId,
  mutation: () => Promise<T>,
): Promise<T> {
  const before = await pendingEntitlements(tx, organizationId)
  const result = await mutation()
  if (before.size === 0) return result

  const after = await pendingEntitlements(tx, organizationId)
  const stale = [...before]
    .filter(([requestId, signature]) => after.get(requestId) !== signature)
    .map(([requestId]) => requestId)
  if (stale.length > 0) {
    await tx
      .update(GatewayUsageResetTable)
      .set({ status: "expired", pendingBucketId: null })
      .where(
        and(
          eq(GatewayUsageResetTable.organizationId, organizationId),
          eq(GatewayUsageResetTable.status, "pending"),
          inArray(GatewayUsageResetTable.id, stale),
        ),
      )
  }
  return result
}
