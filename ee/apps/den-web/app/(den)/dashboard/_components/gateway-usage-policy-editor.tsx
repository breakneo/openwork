"use client";

import { useId, useState } from "react";
import { Dialog } from "@base-ui/react/dialog";
import { Field } from "@base-ui/react/field";
import { gatewayUsagePolicyWriteSchema, gatewayUsageTimeframeSchema, gatewayUsageTimeframes, type GatewayUsageLimitPolicy, type GatewayUsagePolicyWrite } from "@openwork/types/den/gateway-usage-limits";
import { DenButton, buttonVariants } from "../../_components/ui/button";
import { DenCombobox } from "../../_components/ui/combobox";
import { DenInput } from "../../_components/ui/input";
import { DenNotice } from "../../_components/ui/notice";
import { DenSwitch } from "../../_components/ui/switch";
import { editGatewayPolicy, GatewayLimitsWriteUncertainError, newGatewayPolicy, useGatewayLimitsMutation, useGatewayPolicies } from "./gateway-usage-limits-data";

export const timeframeLabels = { day: "1 day", week: "1 week", month: "1 month" };

export function GatewayUsagePolicyEditor({ orgId, policy, onClose }: { orgId: string; policy?: GatewayUsageLimitPolicy; onClose: () => void }) {
  const [draft, setDraft] = useState<GatewayUsagePolicyWrite>(() => policy ? editGatewayPolicy(policy) : newGatewayPolicy());
  const [revision, setRevision] = useState(policy?.revision);
  const [submitted, setSubmitted] = useState(false);
  const mutation = useGatewayLimitsMutation(orgId);
  const policies = useGatewayPolicies(orgId);
  const id = useId();
  const validation = gatewayUsagePolicyWriteSchema.safeParse(draft);
  const issues = submitted && !validation.success ? validation.error.issues : [];
  const latest = policies.data?.policies.find((item) => item.id === policy?.id);
  const changed = Boolean(policy && (!latest || latest.revision !== revision || latest.archivedAt));
  const canReload = policy && latest && !latest.archivedAt && !policies.isError && !policies.isFetching;
  const saveBlocked = mutation.isPending || changed || policies.isError || policies.isFetching || mutation.error instanceof GatewayLimitsWriteUncertainError;

  function changeLimit(index: number, value: Partial<GatewayUsagePolicyWrite["limits"][number]>) {
    setDraft((current) => ({ ...current, limits: current.limits.map((limit, i) => i === index ? { ...limit, ...value } : limit) }));
  }

  return <Dialog.Root open onOpenChange={(open) => { if (!open && !mutation.isPending) onClose(); }}>
    <Dialog.Portal>
      <Dialog.Backdrop className="fixed inset-0 z-50 bg-black/30" />
      <Dialog.Popup className="fixed left-1/2 top-1/2 z-50 flex max-h-[90dvh] w-[min(640px,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 flex-col gap-5 overflow-y-auto rounded-2xl border border-[var(--ow-line)] bg-[var(--dls-surface)] p-6 shadow-xl">
        <Dialog.Title className="text-lg font-semibold">{policy ? "Edit usage limit policy" : "Create usage limit policy"}</Dialog.Title>
        <Dialog.Description className="text-sm text-[var(--ow-muted)]">Estimated USD per person. Daily resets at 05:00 UTC; weekly on Monday; monthly on day 1. Editing a policy does not clear consumption.</Dialog.Description>
        <form noValidate className="flex flex-col gap-5" onSubmit={(event) => {
          event.preventDefault();
          setSubmitted(true);
          if (!validation.success || saveBlocked) return;
          mutation.mutate({ type: "save", body: validation.data, ...(policy && revision ? { policy: { id: policy.id, revision } } : {}) }, { onSuccess: onClose });
        }}>
          <fieldset disabled={mutation.isPending} className="flex min-w-0 flex-col gap-5">
            <legend className="sr-only">Policy settings</legend>
            <Field.Root className="flex flex-col gap-2" invalid={issues.some((issue) => issue.path[0] === "name")}>
              <Field.Label htmlFor={`${id}-name`} className="text-sm font-medium">Policy name</Field.Label>
              <DenInput id={`${id}-name`} value={draft.name} maxLength={120} aria-invalid={issues.some((issue) => issue.path[0] === "name")} aria-describedby={`${id}-name-error`} onChange={(event) => setDraft({ ...draft, name: event.target.value })} />
              <span id={`${id}-name-error`} className="text-sm text-[var(--ow-danger)]">{issues.find((issue) => issue.path[0] === "name")?.message}</span>
            </Field.Root>
            <div className="flex items-center justify-between gap-4"><span>Hard limit</span><DenSwitch aria-label="Hard limit" checked={draft.hardLimit} onChange={(hardLimit) => setDraft({ ...draft, hardLimit })} /></div>
            <p className="text-sm text-[var(--ow-muted)]">Hard limits block further requests after exhaustion. Soft limits only warn. In-flight requests may exceed the allowance; estimates are not an invoice ceiling.</p>
            <div className="flex items-center justify-between gap-4"><span>Allow request reset</span><DenSwitch aria-label="Allow request reset" checked={draft.allowRequestReset} onChange={(allowRequestReset) => setDraft({ ...draft, allowRequestReset })} /></div>
            <fieldset className="flex min-w-0 flex-col gap-3">
              <legend className="mb-3 text-sm font-semibold">Limits</legend>
              {draft.limits.map((limit, index) => <div key={index} className="flex flex-col gap-2 rounded-lg border border-[var(--ow-line)] p-3">
                <div className="flex flex-wrap items-end gap-3">
                  <div className="min-w-40 flex-1"><DenCombobox ariaLabel={`Timeframe ${index + 1}`} value={limit.timeframe} options={gatewayUsageTimeframes.map((timeframe) => ({ value: timeframe, label: timeframeLabels[timeframe] }))} onChange={(value) => changeLimit(index, { timeframe: gatewayUsageTimeframeSchema.parse(value) })} /></div>
                  <Field.Root className="flex min-w-40 flex-1 flex-col gap-2" invalid={issues.some((issue) => issue.path[1] === index)}>
                    <Field.Label htmlFor={`${id}-amount-${index}`} className="text-sm">Estimated USD allowance</Field.Label>
                    <DenInput id={`${id}-amount-${index}`} aria-label={`USD allowance ${index + 1}`} inputMode="decimal" value={limit.costUsd} maxLength={32} aria-invalid={issues.some((issue) => issue.path[1] === index)} aria-describedby={`${id}-amount-error-${index}`} onChange={(event) => changeLimit(index, { costUsd: event.target.value })} />
                  </Field.Root>
                  <DenButton variant="ghost" aria-label={`Remove limit ${index + 1}`} disabled={draft.limits.length === 1} onClick={() => setDraft({ ...draft, limits: draft.limits.filter((_, i) => i !== index) })}>Remove</DenButton>
                </div>
                <p id={`${id}-amount-error-${index}`} className="text-sm text-[var(--ow-danger)]">{issues.find((issue) => issue.path[1] === index)?.message}</p>
              </div>)}
              {issues.filter((issue) => issue.path[0] === "limits" && issue.path.length === 1).map((issue) => <p key={issue.message} role="alert" className="text-sm text-[var(--ow-danger)]">{issue.message}</p>)}
              <DenButton variant="secondary" disabled={draft.limits.length >= 3} onClick={() => {
                const timeframe = gatewayUsageTimeframes.find((value) => !draft.limits.some((limit) => limit.timeframe === value));
                if (timeframe) setDraft({ ...draft, limits: [...draft.limits, { timeframe, costUsd: "" }] });
              }}>Add limit</DenButton>
            </fieldset>
            <p className="text-sm text-[var(--ow-muted)]">Enter a nonnegative decimal with at most six decimal places. Zero is allowed: a zero hard allowance blocks immediately and cannot receive a useful 25% extension.</p>
          </fieldset>
          {mutation.error ? <DenNotice tone="error" message={mutation.error.message} /> : null}
          {policy && changed ? <DenNotice tone="error" message="This policy changed or was archived. Your edits have not been overwritten. Load the latest revision before saving, or close this editor." /> : null}
          {policies.isError ? <><DenNotice tone="error" message="Could not verify the latest policy revision. Refresh policies before saving." /><DenButton variant="secondary" disabled={policies.isFetching} onClick={() => void policies.refetch()}>Retry policy verification</DenButton></> : null}
          {canReload && (changed || mutation.isError) ? <DenButton variant="secondary" onClick={() => { setDraft(editGatewayPolicy(latest)); setRevision(latest.revision); mutation.reset(); setSubmitted(false); }}>Load latest revision (discard edits)</DenButton> : null}
          <div className="flex flex-wrap justify-end gap-3">
            <Dialog.Close disabled={mutation.isPending} className={buttonVariants({ variant: "secondary" })}>Cancel</Dialog.Close>
            <DenButton type="submit" loading={mutation.isPending} disabled={saveBlocked}>Save policy</DenButton>
          </div>
        </form>
      </Dialog.Popup>
    </Dialog.Portal>
  </Dialog.Root>;
}
