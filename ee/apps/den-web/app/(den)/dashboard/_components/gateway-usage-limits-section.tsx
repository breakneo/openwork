"use client";

import { useDeferredValue, useState } from "react";
import { AlertDialog } from "@base-ui/react/alert-dialog";
import { LockKeyhole } from "lucide-react";
import type { GatewayUsageLimitPolicy, GatewayUsageStatus } from "@openwork/types/den/gateway-usage-limits";
import { DenBadge } from "../../_components/ui/badge";
import { DenButton, buttonVariants } from "../../_components/ui/button";
import { DenCard } from "../../_components/ui/card";
import { DenCombobox } from "../../_components/ui/combobox";
import { DenInput } from "../../_components/ui/input";
import { DenNotice } from "../../_components/ui/notice";
import { DenTable } from "../../_components/ui/table";
import type { DenOrgMember, DenOrgTeam } from "../../_lib/den-org";
import { formatLimitMoney, useGatewayAssignments, useGatewayLimitsMutation, useGatewayMembers, useGatewayMemberUsage, useGatewayPolicies, type GatewayUsageMember } from "./gateway-usage-limits-data";
import { GatewayUsagePolicyEditor, timeframeLabels } from "./gateway-usage-policy-editor";

type Directory = { teams: DenOrgTeam[]; members: DenOrgMember[] };

export function GatewayLimitsQueryFeedback({ query, label }: { query: { isPending: boolean; isError: boolean; error: Error | null; refetch: () => unknown }; label: string }) {
  if (query.isError) return <div className="flex flex-col gap-3" role="alert"><DenNotice tone="error" message={query.error?.message ?? `Could not load ${label}.`} /><DenButton variant="secondary" onClick={() => void query.refetch()}>Retry {label}</DenButton></div>;
  if (query.isPending) return <p role="status" className="text-sm text-[var(--ow-muted)]">Loading {label}…</p>;
  return null;
}

export function GatewayLimitTimestamp({ value }: { value: string }) {
  return <time dateTime={value} title={value}>{new Date(value).toLocaleString("en-US", { timeZone: "UTC", dateStyle: "medium", timeStyle: "short", hour12: false })} UTC</time>;
}

function MemberSearch({ orgId, label, onSelect, disabled = false }: { orgId: string; label: string; onSelect: (member: GatewayUsageMember) => void; disabled?: boolean }) {
  const [query, setQuery] = useState("");
  const deferredQuery = useDeferredValue(query);
  const results = useGatewayMembers(orgId, deferredQuery);
  return <div className="flex flex-col gap-3">
    <DenInput type="search" aria-label={label} placeholder="Search people by name or email" maxLength={200} value={query} disabled={disabled} onChange={(event) => setQuery(event.target.value)} />
    <GatewayLimitsQueryFeedback query={results} label="people" />
    {!results.isError && results.data ? <ul aria-label={`${label} results`} className="flex max-h-52 flex-col gap-2 overflow-y-auto">
      {results.data.members.map((member) => <li key={member.id}><DenButton variant="secondary" disabled={disabled || results.isFetching || deferredQuery !== query} onClick={() => onSelect(member)}>{member.name} ({member.email})</DenButton></li>)}
      {!results.data.members.length ? <li className="text-sm text-[var(--ow-muted)]">No people match this search.</li> : null}
    </ul> : null}
  </div>;
}

function assignmentLabel(assignment: GatewayUsageLimitPolicy["assignments"][number], directory: Directory) {
  if (assignment.teamId) return `Team: ${directory.teams.find((team) => team.id === assignment.teamId)?.name ?? assignment.teamId}`;
  const member = directory.members.find((person) => person.id === assignment.memberId);
  return member ? `${member.user.name} (${member.user.email})` : `Person: ${assignment.memberId}`;
}

function PolicyAssignments({ orgId, policy, directory }: { orgId: string; policy: GatewayUsageLimitPolicy; directory: Directory }) {
  const assignments = useGatewayAssignments(orgId, policy.id);
  const mutation = useGatewayLimitsMutation(orgId);
  const [targetType, setTargetType] = useState("person");
  const [member, setMember] = useState<GatewayUsageMember | null>(null);
  const [teamId, setTeamId] = useState("");
  const targetId = targetType === "person" ? member?.id : teamId;
  const alreadyAssigned = assignments.data?.assignments.some((assignment) => targetType === "person" ? assignment.memberId === targetId : assignment.teamId === targetId);
  const disabled = mutation.isPending || assignments.isFetching || assignments.isError;
  return <div className="flex flex-col gap-4">
    <h3 className="font-semibold">Assignments for {policy.name}</h3>
    <p className="text-sm text-[var(--ow-muted)]">Team policies apply to each person individually. Allowances are never pooled.</p>
    <GatewayLimitsQueryFeedback query={assignments} label="assignments" />
    {!assignments.isError && assignments.data ? <DenTable rows={assignments.data.assignments} getRowKey={(row) => row.id} emptyLabel="No people or teams assigned." columns={[
      { key: "target", header: "Person or team", render: (row) => assignmentLabel(row, directory) },
      { key: "remove", header: "Action", render: (row) => <DenButton variant="ghost" disabled={disabled} aria-label={`Unassign ${assignmentLabel(row, directory)}`} onClick={() => mutation.mutate({ type: "unassign", policyId: policy.id, assignmentId: row.id })}>Unassign</DenButton> },
    ]} /> : null}
    <DenCombobox ariaLabel="Assignment type" value={targetType} options={[{ value: "person", label: "Person" }, { value: "team", label: "Team" }]} onChange={(value) => { setTargetType(value); setMember(null); setTeamId(""); mutation.reset(); }} disabled={disabled} />
    {targetType === "person" ? <><MemberSearch orgId={orgId} label="Find person to assign" onSelect={setMember} disabled={disabled} />{member ? <p role="status" className="text-sm">Selected: {member.name} ({member.email})</p> : null}</> : <DenCombobox ariaLabel="Team to assign" value={teamId} onChange={setTeamId} options={directory.teams.map((team) => ({ value: team.id, label: team.name }))} placeholder="Search and select a team" emptyLabel="No teams match this search." disabled={disabled} />}
    {alreadyAssigned ? <p role="status" className="text-sm text-[var(--ow-muted)]">This target is already assigned.</p> : null}
    {mutation.error ? <DenNotice tone="error" message={mutation.error.message} /> : null}
    <DenButton disabled={disabled || !targetId || alreadyAssigned} loading={mutation.isPending} onClick={() => {
      if (targetType === "person" && member) mutation.mutate({ type: "assign", policyId: policy.id, target: { memberId: member.id } }, { onSuccess: () => setMember(null) });
      else if (teamId) mutation.mutate({ type: "assign", policyId: policy.id, target: { teamId } }, { onSuccess: () => setTeamId("") });
    }}>Assign policy</DenButton>
  </div>;
}

function GatewayUsageCoverage({ coverage }: { coverage: GatewayUsageStatus["coverage"] }) {
  const historicalUnknown = coverage.historicalCoverage === "unknown" || coverage.historicalUnknownReason != null;
  const incomplete = !coverage.complete || historicalUnknown || coverage.unpricedRequests > 0
    || (coverage.incompleteRequests ?? 0) > 0 || (coverage.quarantinedRequests ?? 0) > 0;
  const history = !historicalUnknown ? "" : coverage.historicalUnknownReason === "tracking_not_started"
    ? "Usage tracking has not started. Earlier usage is unknown."
    : coverage.historicalUnknownReason === "period_predates_tracking"
      ? "This period includes time before usage tracking started. Earlier usage is unknown."
      : coverage.historicalUnknownReason === "legacy_counter"
        ? "Usage history includes older counters with unknown coverage."
        : "Historical usage coverage is unknown.";
  const details = [
    history,
    coverage.unpricedRequests > 0 ? `${coverage.unpricedRequests} recorded requests have unresolved cost. Unknown cost is not zero.` : "",
    (coverage.incompleteRequests ?? 0) > 0 ? `${coverage.incompleteRequests} recorded requests have incomplete accounting.` : "",
    (coverage.quarantinedRequests ?? 0) > 0 ? `${coverage.quarantinedRequests} unresolved historical requests are quarantined and have not been charged again.` : "",
  ].filter(Boolean).join(" ");
  return <>
    {incomplete ? <DenNotice tone="warning" message={`Accounting is incomplete. ${details}${details ? " " : ""}Known costs are a subtotal, not complete spend.`} />
      : <p className="text-sm text-[var(--ow-muted)]">Accounting coverage complete for recorded requests. All costs are estimates.</p>}
    {coverage.trackingStartedAt ? <p className="text-sm text-[var(--ow-muted)]">Usage tracking started: <GatewayLimitTimestamp value={coverage.trackingStartedAt} /></p> : null}
    {coverage.settlementReady === true ? <p className="text-sm text-[var(--ow-muted)]">No tracked requests are awaiting settlement.</p>
      : typeof coverage.pendingRequests === "number" && coverage.pendingRequests > 0 ? <p role="status" className="text-sm text-[var(--ow-muted)]">{coverage.pendingRequests} tracked requests are awaiting settlement.</p>
        : coverage.pendingRequests === null ? <p className="text-sm text-[var(--ow-muted)]">Pending settlement count is unavailable.</p>
          : coverage.settlementReady === false ? <p role="status" className="text-sm text-[var(--ow-muted)]">Settlement is not yet confirmed.</p> : null}
    {coverage.lastSettlementAt ? <p className="text-sm text-[var(--ow-muted)]">Last settlement: <GatewayLimitTimestamp value={coverage.lastSettlementAt} /></p> : null}
  </>;
}

export function GatewayMemberUsageDetails({ status, policies, teams }: { status: GatewayUsageStatus; policies: GatewayUsageLimitPolicy[]; teams: DenOrgTeam[] }) {
  const matchingPolicies = policies.filter((policy) => !policy.archivedAt && policy.assignments.some((assignment) => assignment.memberId === status.memberId || teams.some((team) => team.id === assignment.teamId && team.memberIds.includes(status.memberId))));
  return <div className="flex flex-col gap-4">
    <div className="flex flex-wrap items-center gap-3"><DenBadge tone={status.state === "over_limit" ? "warning" : "neutral"} icon={status.state === "blocked" ? LockKeyhole : undefined}>{status.state === "unlimited" ? "Unlimited" : status.state === "blocked" ? "Blocked" : status.state === "over_limit" ? "Over allowance" : "Within allowance"}</DenBadge><span className="text-xs text-[var(--ow-muted)]">Updated <GatewayLimitTimestamp value={status.serverTime} /></span></div>
    {status.state === "unlimited" ? <p>No usage limit policy assigned. Other provider, subscription, and service limits still apply.</p> : null}
    {status.state === "over_limit" ? <DenNotice tone="warning" message="Over the estimated usage allowance. Requests are still allowed under these soft limits." /> : null}
    {status.state === "blocked" ? <DenNotice tone="warning" message="An exhausted hard limit blocks further Gateway requests. All blocking buckets must clear before access is restored." /> : null}
    <GatewayUsageCoverage coverage={status.coverage} />
    {status.buckets.map((bucket) => <section key={bucket.id} aria-label={`${bucket.policyName} - ${timeframeLabels[bucket.timeframe]} usage`} className="flex flex-col gap-3 border-t border-[var(--ow-line)] pt-4">
      <div className="flex flex-wrap items-center gap-3"><h4 className="font-semibold">{bucket.policyName} - {timeframeLabels[bucket.timeframe]}</h4><DenBadge>{bucket.hardLimit ? "Hard limit" : "Soft limit"}</DenBadge></div>
      <p className="text-lg font-medium tabular-nums">{formatLimitMoney(bucket.usedMicroUsd)} used / {formatLimitMoney(bucket.allowanceMicroUsd)} allowance</p>
      <p className="text-sm">{bucket.remainingMicroUsd < 0 ? `${formatLimitMoney(-bucket.remainingMicroUsd)} over allowance` : `${formatLimitMoney(bucket.remainingMicroUsd)} remaining`}</p>
      <dl className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
        <div className="flex gap-1"><dt>Base</dt><dd>{formatLimitMoney(bucket.baseAllowanceMicroUsd)}</dd></div>
        <div className="flex gap-1"><dt>Extension</dt><dd>{formatLimitMoney(bucket.extensionMicroUsd)}</dd></div>
      </dl>
      <p className="text-sm">Next reset: <GatewayLimitTimestamp value={bucket.resetAt} /></p>
      <dl className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
        <div className="flex gap-1"><dt>Increase requests</dt><dd>{bucket.allowRequestReset ? "Allowed" : "Disabled"}</dd></div>
        <div className="flex gap-1"><dt>Request status</dt><dd>{bucket.resetRequestStatus ?? (bucket.canRequestReset ? "Eligible to request an increase" : "Not currently eligible to request an increase")}</dd></div>
      </dl>
      <details className="text-sm"><summary className="cursor-pointer font-medium">Effective policy and assignment context</summary>
        <div className="flex flex-col gap-2 pt-3">
          <p>The highest allowance wins for each timeframe and supplies its hard-limit and increase-request settings. Ties prefer hard limits, then increase permission, then policy ID.</p>
          <section aria-label="Server-selected assignment snapshot" className="flex flex-col gap-2">
            <h5 className="font-medium">Server-selected snapshot</h5>
            <dl className="flex flex-wrap gap-x-4 gap-y-1">
              <div className="flex gap-1"><dt>Policy</dt><dd>{bucket.policyName}</dd></div>
              <div className="flex gap-1"><dt>Revision</dt><dd>{bucket.policyRevision ?? "Unavailable in this snapshot"}</dd></div>
            </dl>
            {bucket.provenance?.length ? <ul className="flex flex-col gap-2">{bucket.provenance.map((source) => <li key={source.assignmentId}>
              {source.kind === "direct" ? "Direct assignment" : `Team: ${source.teamName}`}
            </li>)}</ul> : <p className="text-[var(--ow-muted)]">No assignment provenance supplied for this snapshot.</p>}
          </section>
          <h5 className="font-medium">Current-directory policy comparison</h5>
          <p className="text-[var(--ow-muted)]">These comparison policies and memberships are from the current organization directory, not the server-selected snapshot above.</p>
          <ul className="flex flex-col gap-2">{matchingPolicies.filter((policy) => policy.limits.some((limit) => limit.timeframe === bucket.timeframe)).map((policy) => <li key={policy.id}>
            <dl className="flex flex-wrap gap-x-4 gap-y-1">
              <div className="flex gap-1"><dt>Policy</dt><dd>{policy.name}</dd></div>
              <div className="flex gap-1"><dt>Revision</dt><dd>{policy.revision}</dd></div>
              <div className="flex gap-1"><dt>Allowance</dt><dd>{formatLimitMoney(policy.limits.find((limit) => limit.timeframe === bucket.timeframe)?.costLimitMicroUsd ?? 0)}</dd></div>
              <div className="flex gap-1"><dt>Selection</dt><dd>{policy.id === bucket.policyId ? "Selected policy" : "Not selected"}</dd></div>
              <div className="flex gap-1"><dt>Assignments</dt><dd>{policy.assignments.flatMap((assignment) => {
                if (assignment.memberId === status.memberId) return ["Direct assignment"];
                const team = teams.find((item) => item.id === assignment.teamId && item.memberIds.includes(status.memberId));
                return team ? [`Team: ${team.name}`] : [];
              }).join(", ")}</dd></div>
            </dl>
          </li>)}</ul>
        </div>
      </details>
    </section>)}
  </div>;
}

function MemberInspector({ orgId, policies, teams }: { orgId: string; policies: GatewayUsageLimitPolicy[]; teams: DenOrgTeam[] }) {
  const [selected, setSelected] = useState<GatewayUsageMember | null>(null);
  const usage = useGatewayMemberUsage(orgId, selected?.id ?? "");
  return <DenCard className="flex flex-col gap-4">
    <h3 className="font-semibold">Inspect a person’s effective usage</h3>
    <MemberSearch orgId={orgId} label="Find person to inspect" onSelect={setSelected} />
    {selected ? <section aria-label={`Usage for ${selected.name}`} className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3"><h4 className="font-medium">{selected.name} ({selected.email})</h4><DenButton variant="secondary" disabled={usage.isFetching} onClick={() => void usage.refetch()}>Refresh usage</DenButton></div>
      <GatewayLimitsQueryFeedback query={usage} label="member usage" />
      {!usage.isError && usage.data ? <GatewayMemberUsageDetails status={usage.data} policies={policies} teams={teams} /> : null}
    </section> : <p className="text-sm text-[var(--ow-muted)]">Select a person to see their own buckets, not team-wide usage totals.</p>}
  </DenCard>;
}

export function GatewayUsageLimitsSection({ orgId, teams, members }: { orgId: string } & Directory) {
  const policies = useGatewayPolicies(orgId);
  const mutation = useGatewayLimitsMutation(orgId);
  const [query, setQuery] = useState("");
  const [editor, setEditor] = useState<{ policy?: GatewayUsageLimitPolicy } | null>(null);
  const [assigning, setAssigning] = useState<string | null>(null);
  const [archiving, setArchiving] = useState<GatewayUsageLimitPolicy | null>(null);
  const active = policies.data?.policies.filter((policy) => !policy.archivedAt) ?? [];
  const filtered = active.filter((policy) => policy.name.toLowerCase().includes(query.trim().toLowerCase()));
  const assignmentPolicy = active.find((policy) => policy.id === assigning);
  const latestArchive = active.find((policy) => policy.id === archiving?.id);
  const staleArchive = Boolean(archiving && latestArchive?.revision !== archiving.revision);
  return <section aria-labelledby="gateway-usage-limits-heading" className="flex flex-col gap-5">
    <div className="flex flex-wrap items-center justify-between gap-3"><h2 id="gateway-usage-limits-heading" className="text-lg font-semibold">Usage Limits</h2><div className="flex gap-3">{active.length > 0 ? <DenButton variant="secondary" disabled={policies.isFetching} onClick={() => void policies.refetch()}>Refresh policies</DenButton> : null}<DenButton onClick={() => setEditor({})}>Create policy</DenButton></div></div>
    {active.length > 0 ? <>
      <p className="text-sm text-[var(--ow-muted)]">Estimated USD for organization-provider Gateway traffic. Team policies apply to each person individually, never as a shared pool. Each timeframe applies simultaneously; allowances are not added together.</p>
      <p className="text-sm text-[var(--ow-muted)]">Calendar resets: daily at 05:00 UTC, Monday at 05:00 UTC weekly, and day 1 at 05:00 UTC monthly.</p>
      <DenInput type="search" aria-label="Search usage limit policies" placeholder="Search policies" value={query} onChange={(event) => setQuery(event.target.value)} />
    </> : null}
    <GatewayLimitsQueryFeedback query={policies} label="policies" />
    {!policies.isError && policies.data && active.length === 0 ? <DenCard className="py-10 text-center"><p className="text-sm text-[var(--ow-muted)]">No usage limits configured</p></DenCard> : null}
    {!policies.isError && policies.data && active.length > 0 ? <DenCard className="overflow-hidden p-0"><DenTable rows={filtered} getRowKey={(row) => row.id} emptyLabel="No policies match this search." columns={[
      { key: "name", header: "Policy", render: (policy) => <div className="flex flex-col gap-1"><span className="font-medium">{policy.name}</span><dl className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-[var(--ow-muted)]"><div className="flex gap-1"><dt>Revision</dt><dd>{policy.revision}</dd></div><div className="flex gap-1"><dt>Assignments</dt><dd>{policy.assignments.length}</dd></div></dl></div> },
      { key: "limits", header: "Estimated allowances", render: (policy) => <ul>{policy.limits.map((limit) => <li key={limit.timeframe}>{timeframeLabels[limit.timeframe]}: {formatLimitMoney(limit.costLimitMicroUsd)}</li>)}</ul> },
      { key: "flags", header: "Behavior", render: (policy) => <div className="flex flex-wrap gap-2"><DenBadge>{policy.hardLimit ? "Hard" : "Soft"}</DenBadge><DenBadge>{policy.allowRequestReset ? "Increase requests on" : "Increase requests off"}</DenBadge></div> },
      { key: "actions", header: "Actions", render: (policy) => <div className="flex flex-wrap gap-2"><DenButton size="sm" variant="secondary" disabled={policies.isFetching} aria-label={`Edit ${policy.name}`} onClick={() => setEditor({ policy })}>Edit</DenButton><DenButton size="sm" variant="secondary" disabled={policies.isFetching} aria-label={`Assignments for ${policy.name}`} onClick={() => setAssigning(assigning === policy.id ? null : policy.id)}>Assignments</DenButton><DenButton size="sm" variant="ghost" disabled={policies.isFetching} aria-label={`Archive ${policy.name}`} onClick={() => { mutation.reset(); setArchiving(policy); }}>Archive</DenButton></div> },
    ]} /></DenCard> : null}
    {assignmentPolicy && !policies.isError ? <DenCard><PolicyAssignments key={assignmentPolicy.id} orgId={orgId} policy={assignmentPolicy} directory={{ teams, members }} /></DenCard> : null}
    {!policies.isError && active.length > 0 ? <MemberInspector orgId={orgId} policies={active} teams={teams} /> : null}
    {editor ? <GatewayUsagePolicyEditor orgId={orgId} policy={editor.policy} onClose={() => setEditor(null)} /> : null}
    <AlertDialog.Root open={Boolean(archiving)} onOpenChange={(open) => { if (!open && !mutation.isPending) setArchiving(null); }}>
      <AlertDialog.Portal><AlertDialog.Backdrop className="fixed inset-0 z-50 bg-black/30" /><AlertDialog.Popup className="fixed left-1/2 top-1/2 z-50 flex w-[min(480px,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 flex-col gap-4 rounded-2xl border border-[var(--ow-line)]/60 bg-[var(--dls-surface)] p-6">
        <AlertDialog.Title className="text-lg font-semibold">Archive {archiving?.name}?</AlertDialog.Title><AlertDialog.Description className="text-sm text-[var(--ow-muted)]">This stops the policy from applying to assigned people and teams. Consumption and history are retained; people without other policies become unlimited.</AlertDialog.Description>
        {mutation.error ? <DenNotice tone="error" message={mutation.error.message} /> : null}
        {staleArchive ? <DenNotice tone="error" message="This policy changed. Cancel and review the latest revision before archiving." /> : null}
        <div className="flex justify-end gap-3"><AlertDialog.Close disabled={mutation.isPending} className={buttonVariants({ variant: "secondary" })}>Cancel</AlertDialog.Close><DenButton variant="destructive" loading={mutation.isPending} disabled={staleArchive || policies.isError || policies.isFetching} onClick={() => { if (archiving) mutation.mutate({ type: "archive", policy: archiving }, { onSuccess: () => setArchiving(null) }); }}>Archive policy</DenButton></div>
      </AlertDialog.Popup></AlertDialog.Portal>
    </AlertDialog.Root>
  </section>;
}
