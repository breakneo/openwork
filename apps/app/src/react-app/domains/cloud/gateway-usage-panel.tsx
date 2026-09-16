import { useId, useState } from "react";
import { Gauge } from "lucide-react";
import type { GatewayUsageBucket, GatewayUsageStatus } from "@openwork/types/den/gateway-usage-limits";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Popover, PopoverContent, PopoverDescription, PopoverHeader, PopoverTitle, PopoverTrigger } from "@/components/ui/popover";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { formatGatewayMoney, gatewayTimeframeLabels } from "./gateway-usage-state";
import { useGatewayUsage } from "./use-gateway-usage";

export function GatewayResetTime({ value }: { value: string }) {
  return <time dateTime={value} title={new Date(value).toUTCString()}>{new Date(value).toLocaleString()} ({new Date(value).toUTCString()})</time>;
}

export function GatewayUsageSummary({ status, onRequest, requestsDisabled = false }: {
  status: GatewayUsageStatus;
  onRequest: (bucket: GatewayUsageBucket) => void;
  requestsDisabled?: boolean;
}) {
  return <div className="flex flex-col gap-3">
    {status.state === "unlimited" ? <div><p className="font-medium">Unlimited</p><p className="text-muted-foreground">No usage limit policy assigned. Provider and service limits still apply.</p></div> : null}
    {!status.coverage.complete ? <Alert><AlertTitle>Incomplete accounting</AlertTitle><AlertDescription>These estimates are incomplete; {status.coverage.unpricedRequests} requests have unresolved cost. Unknown cost is not zero.</AlertDescription></Alert> : null}
    {status.buckets.map((bucket) => <section key={bucket.id} aria-label={`${gatewayTimeframeLabels[bucket.timeframe]} usage`} className="flex flex-col gap-2 rounded-xl border p-3">
      <div className="flex items-center justify-between gap-2"><h3 className="font-medium">{gatewayTimeframeLabels[bucket.timeframe]}</h3><Badge variant="outline">{bucket.hardLimit ? "Hard limit" : "Soft limit"}</Badge></div>
      <p>{formatGatewayMoney(bucket.usedMicroUsd)} used / {formatGatewayMoney(bucket.allowanceMicroUsd)} total</p>
      <p className="text-xs text-muted-foreground">Base {formatGatewayMoney(bucket.baseAllowanceMicroUsd)} · Extension {formatGatewayMoney(bucket.extensionMicroUsd)}</p>
      {bucket.usedMicroUsd >= bucket.allowanceMicroUsd ? <p>{bucket.hardLimit ? "Exhausted" : "Over allowance"} · {formatGatewayMoney(Math.max(0, bucket.usedMicroUsd - bucket.allowanceMicroUsd))} over</p> : null}
      <p className="text-xs text-muted-foreground">Next reset: <GatewayResetTime value={bucket.resetAt} /></p>
      {bucket.resetRequestStatus === "pending" ? <p role="status">Reset request pending</p> : bucket.resetRequestStatus ? <p className="text-xs">Reset request: {bucket.resetRequestStatus}</p> : null}
      {bucket.canRequestReset && bucket.resetRequestStatus !== "pending" ? <Button size="sm" variant="outline" disabled={requestsDisabled} onClick={() => onRequest(bucket)}>Request Reset — {gatewayTimeframeLabels[bucket.timeframe]}</Button> : null}
    </section>)}
    <p className="text-xs text-muted-foreground">Estimated cost, not final invoice spend. In-flight requests can exceed allowances. Windows reset at 05:00 UTC (Monday weekly; day 1 monthly). Each window measures the same usage; do not add them together.</p>
  </div>;
}

export function GatewayResetForm({ bucket, pending, error, onSubmit }: {
  bucket: GatewayUsageBucket; pending: boolean; error: boolean;
  onSubmit: (reason: string) => void;
}) {
  const [reason, setReason] = useState("");
  const id = useId();
  return <form className="flex flex-col gap-4" onSubmit={(event) => {
    event.preventDefault();
    if (!pending && reason.trim() && reason.trim().length <= 2000) onSubmit(reason.trim());
  }}>
    <p>{gatewayTimeframeLabels[bucket.timeframe]}: {formatGatewayMoney(bucket.usedMicroUsd)} used / {formatGatewayMoney(bucket.allowanceMicroUsd)} total. Approval adds 25% of the base allowance once; usage and reset time are unchanged.</p>
    <FieldGroup><Field><FieldLabel htmlFor={id}>Reason (required)</FieldLabel><Textarea id={id} required maxLength={2000} value={reason} onChange={(event) => setReason(event.target.value)} disabled={pending} /></Field></FieldGroup>
    {error ? <p role="alert">The request could not be confirmed. Check the refreshed usage status before trying again.</p> : null}
    <Button type="submit" disabled={pending || !reason.trim() || reason.trim().length > 2000}>{pending ? "Submitting…" : "Submit reset request"}</Button>
  </form>;
}

function GatewayUsagePanelBody() {
  const usage = useGatewayUsage(true, true);
  const [selectedBucketId, setSelectedBucketId] = useState<string | null>(null);
  const bucket = usage.data?.buckets.find((item) => item.id === selectedBucketId && item.canRequestReset && item.resetRequestStatus !== "pending");
  return <>
    {!usage.authorized ? <p role="status">Sign in and select an organization to view usage limits.</p> : <>
      {usage.query.isPending ? <div role="status" aria-label="Loading usage limits"><Skeleton className="h-20 w-full" /><span>Loading usage limits…</span></div> : null}
      {usage.query.isError ? <Alert variant="destructive"><AlertTitle>Usage unavailable</AlertTitle><AlertDescription>{usage.data ? "Showing the last known estimate. Reset eligibility may have changed." : "Could not load usage. This does not mean unlimited access."}</AlertDescription></Alert> : null}
      {usage.data ? <GatewayUsageSummary status={usage.data} requestsDisabled={usage.query.isError || usage.reset.isPending} onRequest={(item) => { usage.reset.reset(); setSelectedBucketId(item.id); }} /> : null}
      <Button size="sm" variant="outline" disabled={usage.query.isFetching} onClick={() => { void usage.query.refetch(); }}>{usage.query.isFetching ? "Refreshing…" : "Refresh usage"}</Button>
    </>}
    <Dialog open={Boolean(bucket)} onOpenChange={(open) => { if (!open) setSelectedBucketId(null); }}>
      <DialogContent><DialogHeader><DialogTitle>Request Reset</DialogTitle><DialogDescription>Ask your organization administrator for a usage extension.</DialogDescription></DialogHeader>
        {bucket ? <GatewayResetForm key={`${usage.scopeKey}:${bucket.id}`} bucket={bucket} pending={usage.reset.isPending} error={usage.reset.isError} onSubmit={(reason) => usage.reset.mutate({ bucketId: bucket.id, reason }, { onSuccess: () => setSelectedBucketId(null) })} /> : null}
      </DialogContent>
    </Dialog>
  </>;
}

export function GatewayUsageTrigger({ compact = true }: { compact?: boolean }) {
  const [open, setOpen] = useState(false);
  return <Popover open={open} onOpenChange={setOpen}>
    <PopoverTrigger render={<Button variant="ghost" size={compact ? "icon-sm" : "sm"} aria-label="Usage limits" title="Usage limits"><Gauge aria-hidden="true" className="size-4" />{compact ? null : "Usage limits / Request Reset"}</Button>} />
    <PopoverContent side="top" align="end" className="max-h-[min(75vh,640px)] w-96 max-w-[calc(100vw-2rem)] overflow-y-auto">
      <PopoverHeader><PopoverTitle>Usage limits</PopoverTitle><PopoverDescription>Your organization’s AI Gateway estimated cost.</PopoverDescription></PopoverHeader>
      {open ? <GatewayUsagePanelBody /> : null}
    </PopoverContent>
  </Popover>;
}

export function GatewayUsageNotice({ state, status, stale }: {
  state: "blocked" | "over_limit"; status: GatewayUsageStatus; stale: boolean;
}) {
  const buckets = status?.buckets.filter((bucket) => bucket.usedMicroUsd >= bucket.allowanceMicroUsd && (state !== "blocked" || bucket.hardLimit));
  return <Alert className="mx-auto mb-2 max-w-3xl" data-testid="gateway-usage-notice" variant={state === "blocked" ? "destructive" : "default"}>
    <AlertTitle>{state === "blocked" ? "Out of usage" : "Over estimated usage allowance"}</AlertTitle>
    <AlertDescription>
      <p>{state === "blocked" ? "Your organization’s AI Gateway allowance is exhausted. You can keep editing or choose a provider outside this Gateway." : "You’re over your estimated usage allowance. Requests are still allowed."}</p>
      {buckets?.map((bucket) => <p key={bucket.id}>{gatewayTimeframeLabels[bucket.timeframe]} · Next reset: <GatewayResetTime value={bucket.resetAt} /></p>)}
      {stale ? <p role="status">Could not refresh usage. Showing the last known limit; open Usage limits to retry.</p> : null}
      <GatewayUsageTrigger compact={false} />
    </AlertDescription>
  </Alert>;
}
