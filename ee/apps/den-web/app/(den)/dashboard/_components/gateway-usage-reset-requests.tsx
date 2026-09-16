"use client";

import { useState } from "react";
import type { GatewayUsageResetPage, GatewayUsageResetRequest } from "@openwork/types/den/gateway-usage-limits";
import { DenBadge } from "../../_components/ui/badge";
import { DenButton } from "../../_components/ui/button";
import { DenCard } from "../../_components/ui/card";
import { DenNotice } from "../../_components/ui/notice";
import { DenTable, type DenTableColumn } from "../../_components/ui/table";
import type { DenOrgMember } from "../../_lib/den-org";
import { formatLimitMoney, useGatewayLimitsMutation, useGatewayResetRequests } from "./gateway-usage-limits-data";
import { GatewayLimitsQueryFeedback, GatewayLimitTimestamp } from "./gateway-usage-limits-section";
import { timeframeLabels } from "./gateway-usage-policy-editor";

function extensionPreview(request: GatewayUsageResetRequest) {
  const extension = Number((BigInt(request.baseAllowanceMicroUsd) + 3n) / 4n);
  return { extension, total: request.baseAllowanceMicroUsd + extension };
}

function ResetRequestPages({ query, view, columns }: {
  query: ReturnType<typeof useGatewayResetRequests>;
  view: GatewayUsageResetPage["view"];
  columns: DenTableColumn<GatewayUsageResetRequest>[];
}) {
  const label = view === "pending" ? "reset requests" : "request history";
  const rows = [...new Map(query.data?.pages.flatMap((page) => page.requests.map((request) => [request.id, request] satisfies [string, GatewayUsageResetRequest]))).values()];
  if (!query.data || (query.isError && !query.isFetchNextPageError)) {
    return <GatewayLimitsQueryFeedback query={{ ...query, refetch: query.restart }} label={label} />;
  }
  return <div className="flex flex-col gap-3" aria-label={view === "pending" ? "Pending reset request pages" : "Reset request history pages"}>
    <p role="status" className="text-sm text-[var(--ow-muted)]">{view === "pending" ? `Pending queue: ${query.data.pages.at(-1)?.pendingCount ?? 0}. ${rows.length} queued requests loaded.` : `${rows.length} history entries loaded.`}</p>
    {view === "pending" ? <p className="text-xs text-[var(--ow-muted)]">Oldest first. The queue count includes requests that may now be ineligible; expired rows cannot be reviewed.</p> : <p className="text-xs text-[var(--ow-muted)]">Newest decisions and elapsed requests first.</p>}
    <DenCard className="overflow-hidden p-0"><DenTable rows={rows} getRowKey={(row) => row.id} emptyLabel={view === "pending" ? "No pending reset requests." : "No reviewed or expired requests yet."} columns={columns} /></DenCard>
    {query.isFetchNextPageError ? <DenNotice tone="error" message={`${query.error?.message ?? "Could not load the next page."} Only previously loaded entries are shown.`} /> : null}
    {query.hasNextPage ? <DenButton variant="secondary" disabled={query.isFetching} loading={query.isFetchingNextPage} onClick={() => void query.fetchNextPage()}>{query.isFetchNextPageError ? "Retry more" : "Load more"} {view === "pending" ? "pending requests" : "history"}</DenButton> : null}
    <p className="text-xs text-[var(--ow-muted)]">Pages are live snapshots. Refresh to start from the first page and check for changes.</p>
  </div>;
}

function ResetRequestHistory({ orgId, columns, members }: { orgId: string; columns: DenTableColumn<GatewayUsageResetRequest>[]; members: DenOrgMember[] }) {
  const history = useGatewayResetRequests(orgId, "history");
  return <section id="gateway-reset-history" className="flex flex-col gap-3" aria-label="Request history">
    <DenButton variant="secondary" disabled={history.isFetching} onClick={() => void history.restart()}>Refresh history</DenButton>
    <ResetRequestPages query={history} view="history" columns={[...columns,
      { key: "status", header: "Decision", render: (request) => <div className="flex flex-col gap-2"><DenBadge tone={request.status === "approved" ? "success" : "neutral"}>{request.status}</DenBadge><span className="text-xs">{request.reviewedBy ? `Reviewer: ${members.find((member) => member.id === request.reviewedBy)?.user.name ?? request.reviewedBy}` : "No reviewer"}</span>{request.reviewedAt ? <GatewayLimitTimestamp value={request.reviewedAt} /> : null}</div> },
    ]} />
  </section>;
}

export function GatewayUsageResetRequests({ orgId, members }: { orgId: string; members: DenOrgMember[] }) {
  return <GatewayResetQueue key={orgId} orgId={orgId} members={members} />;
}

function GatewayResetQueue({ orgId, members }: { orgId: string; members: DenOrgMember[] }) {
  const requests = useGatewayResetRequests(orgId, "pending");
  const mutation = useGatewayLimitsMutation(orgId);
  const [history, setHistory] = useState(false);
  const contextColumns: DenTableColumn<GatewayUsageResetRequest>[] = [
    { key: "user", header: "User", render: (request) => <div className="flex flex-col gap-1"><span className="font-medium">{request.memberName}</span><span className="text-xs text-[var(--ow-muted)]">{request.memberEmail}</span></div> },
    { key: "reason", header: "Reason", render: (request) => <p className="max-w-sm whitespace-pre-wrap break-words">{request.reason}</p> },
    { key: "bucket", header: "Bucket context", render: (request) => {
      const preview = extensionPreview(request);
      return <div className="flex min-w-60 flex-col gap-2 text-sm">
        <span className="font-medium">{timeframeLabels[request.timeframe]} · {request.policyName}</span>
        {request.status === "expired" ? <DenBadge>Expired / ineligible</DenBadge> : null}
        <span>{formatLimitMoney(request.usedMicroUsd)} used / {formatLimitMoney(request.allowanceMicroUsd)} allowance</span>
        <span>Base: {formatLimitMoney(request.baseAllowanceMicroUsd)}</span>
        <span>Reset: <GatewayLimitTimestamp value={request.resetAt} /></span>
        {request.status === "pending" && Date.parse(request.resetAt) <= Date.now() ? <span className="text-[var(--ow-warning)]">This period ended. Refresh requests to check its current status.</span> : null}
        {request.status === "pending" && request.baseAllowanceMicroUsd === 0 ? <span className="text-[var(--ow-warning)]">A zero base allowance cannot receive a useful percentage extension.</span> : null}
        {request.status === "pending" ? <><span>Approve adds {formatLimitMoney(preview.extension)} → {formatLimitMoney(preview.total)} total</span>{request.usedMicroUsd >= preview.total ? <span className="text-[var(--ow-warning)]">Approval will still leave this bucket exhausted.</span> : null}</> : null}
        <details><summary className="cursor-pointer text-xs text-[var(--ow-muted)]">Request details</summary><div className="flex flex-col gap-1 break-all pt-2 text-xs"><span>Bucket: {request.bucketId}</span><span>Request: {request.id}</span><span>Submitted: <GatewayLimitTimestamp value={request.createdAt} /></span></div></details>
      </div>;
    } },
  ];
  const disabled = mutation.isPending || requests.isFetching || requests.isError;
  return <section aria-labelledby="gateway-reset-requests-heading" className="flex flex-col gap-4">
    <div className="flex flex-wrap items-center justify-between gap-3"><h2 id="gateway-reset-requests-heading" className="text-lg font-semibold">Usage Limit Reset Requests</h2><DenButton variant="secondary" disabled={requests.isFetching} onClick={() => void requests.restart()}>Refresh requests</DenButton></div>
    <p className="text-sm text-[var(--ow-muted)]">Approve 25% adds a one-time extension based on the base allowance (rounded up to micro-USD). Consumption and reset time stay unchanged. Other exhausted buckets may still block requests.</p>
    {mutation.error ? <DenNotice tone="error" message={mutation.error.message} /> : null}
    {mutation.isSuccess && mutation.data && "status" in mutation.data ? <DenNotice tone={mutation.data.status === "expired" ? "warning" : "info"} message={mutation.data.status === "expired" ? "This request expired or its policy changed. No extension was granted by this decision; review the current bucket." : `Request ${mutation.data.status}. Check the queue and history for the latest state.`} /> : null}
    <ResetRequestPages query={requests} view="pending" columns={[...contextColumns,
      { key: "approve", header: "Approve 25%", render: (request) => <DenButton size="sm" disabled={disabled || request.status !== "pending" || request.baseAllowanceMicroUsd === 0 || Date.parse(request.resetAt) <= Date.now()} aria-label={`Approve 25% for ${request.memberName}, ${timeframeLabels[request.timeframe]}`} onClick={() => mutation.mutate({ type: "approve", requestId: request.id })}>Approve 25%</DenButton> },
      { key: "deny", header: "Deny", render: (request) => <DenButton size="sm" variant="secondary" disabled={disabled || request.status !== "pending"} aria-label={`Deny request for ${request.memberName}, ${timeframeLabels[request.timeframe]}`} onClick={() => mutation.mutate({ type: "deny", requestId: request.id })}>Deny</DenButton> },
    ]} />
    <DenButton variant="ghost" aria-expanded={history} aria-controls="gateway-reset-history" onClick={() => setHistory(!history)}>{history ? "Hide" : "Show"} request history</DenButton>
    {history ? <ResetRequestHistory orgId={orgId} columns={contextColumns} members={members} /> : null}
  </section>;
}
