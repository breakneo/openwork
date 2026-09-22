"use client";

import { useEffect, useMemo, useState } from "react";
import { Dialog } from "@base-ui/react/dialog";
import { DenButton } from "../../_components/ui/button";
import { DenList, DenListRow } from "../../_components/ui/list-row";
import { DenNotice } from "../../_components/ui/notice";
import { DenOptionCard } from "../../_components/ui/option-card";
import { useOrgDashboard } from "../_providers/org-dashboard-provider";
import {
  createDesktopPolicy,
  updateDesktopPolicy,
  useOrgDesktopPolicies,
  type DenDesktopPolicy,
  type DenDesktopPolicyRole,
} from "./desktop-policy-data";

type ModelAccessMode = "open" | "managed";

const ADMIN_EXCEPTION_POLICY_NAME = "Admins may add providers";
const ADMIN_EXCEPTION_ROLES: DenDesktopPolicyRole[] = ["owner", "admin"];

function getPolicyMemberIds(policy: DenDesktopPolicy) {
  return policy.assignments.flatMap((assignment) => (assignment.orgMemberId ? [assignment.orgMemberId] : []));
}

function getPolicyTeamIds(policy: DenDesktopPolicy) {
  return policy.assignments.flatMap((assignment) => (assignment.teamId ? [assignment.teamId] : []));
}

function getPolicyRoles(policy: DenDesktopPolicy) {
  return policy.roles.length > 0
    ? policy.roles
    : policy.assignments.flatMap((assignment) => (assignment.role ? [assignment.role] : []));
}

export function GatewayWhoCanUseModels() {
  const { orgContext, runReauthableAction, reauthDialogOpen } = useOrgDashboard();
  const { desktopPolicies, busy: policiesBusy, error: policiesError, reloadPolicies } = useOrgDesktopPolicies(
    orgContext?.organization.id ?? null,
  );
  const [open, setOpen] = useState(false);
  const [accessMode, setAccessMode] = useState<ModelAccessMode>("open");
  const [adminExceptionChecked, setAdminExceptionChecked] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const defaultPolicy = useMemo(
    () => desktopPolicies.find((policy) => policy.isDefault) ?? null,
    [desktopPolicies],
  );
  const adminExceptionPolicies = useMemo(
    () => desktopPolicies.filter((policy) => !policy.isDefault && policy.policyName === ADMIN_EXCEPTION_POLICY_NAME),
    [desktopPolicies],
  );

  useEffect(() => {
    const defaultAllowsCustomProviders = defaultPolicy?.policy.allowCustomProviders !== false;
    setAccessMode(defaultAllowsCustomProviders ? "open" : "managed");
    setAdminExceptionChecked(defaultAllowsCustomProviders ? true : adminExceptionPolicies.some((policy) => policy.isEnabled));
  }, [defaultPolicy, adminExceptionPolicies]);

  const rowLabel = accessMode === "managed" ? "Only models you add here" : "Any model, including ones people add themselves";
  const formDisabled = policiesBusy || saving || !defaultPolicy;

  async function updateDefaultPolicy(allowCustomProviders: boolean) {
    if (!defaultPolicy) throw new Error("Default desktop policy not found.");
    await updateDesktopPolicy(defaultPolicy.id, {
      policyName: defaultPolicy.policyName,
      policy: { ...defaultPolicy.policy, allowCustomProviders, allowZenModel: defaultPolicy.policy.allowZenModel },
      priority: 0,
      isEnabled: true,
      memberIds: [],
      teamIds: [],
      roles: [],
    });
  }

  async function disablePolicy(policy: DenDesktopPolicy) {
    if (!policy.isEnabled) return;
    await updateDesktopPolicy(policy.id, {
      policyName: policy.policyName,
      policy: policy.policy,
      priority: policy.priority,
      isEnabled: false,
      memberIds: getPolicyMemberIds(policy),
      teamIds: getPolicyTeamIds(policy),
      roles: getPolicyRoles(policy),
    });
  }

  async function ensureAdminExceptionPolicy() {
    const primaryPolicy = adminExceptionPolicies[0] ?? null;
    if (primaryPolicy) {
      await updateDesktopPolicy(primaryPolicy.id, {
        policyName: ADMIN_EXCEPTION_POLICY_NAME,
        policy: { ...primaryPolicy.policy, allowCustomProviders: true },
        priority: primaryPolicy.priority,
        isEnabled: true,
        memberIds: [],
        teamIds: [],
        roles: ADMIN_EXCEPTION_ROLES,
      });
    } else {
      await createDesktopPolicy({
        policyName: ADMIN_EXCEPTION_POLICY_NAME,
        policy: { allowCustomProviders: true },
        priority: 0,
        isEnabled: true,
        memberIds: [],
        teamIds: [],
        roles: ADMIN_EXCEPTION_ROLES,
      });
    }
    for (const policy of adminExceptionPolicies.slice(1)) await disablePolicy(policy);
  }

  async function save() {
    setError(null);
    if (!defaultPolicy) {
      setError("Default desktop policy not found.");
      return;
    }
    setSaving(true);
    try {
      await runReauthableAction("save-model-access", async () => {
        if (accessMode === "managed") {
          await updateDefaultPolicy(false);
          if (adminExceptionChecked) await ensureAdminExceptionPolicy();
          else for (const policy of adminExceptionPolicies) await disablePolicy(policy);
        } else {
          await updateDefaultPolicy(true);
          for (const policy of adminExceptionPolicies) await disablePolicy(policy);
        }
        await reloadPolicies();
      });
      setOpen(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not save who can use models.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <DenList className="mb-6">
        <DenListRow
          title="Who can use models"
          meta={policiesBusy ? "Loading…" : rowLabel}
          action={
            <DenButton
              size="sm"
              variant="secondary"
              data-testid="gateway-model-policy-open"
              disabled={policiesBusy}
              onClick={() => {
                setError(null);
                setOpen(true);
              }}
            >
              Change
            </DenButton>
          }
        />
      </DenList>

      <Dialog.Root
        open={open && !reauthDialogOpen}
        onOpenChange={(next) => {
          if (saving) return;
          setOpen(next);
          if (!next) setError(null);
        }}
      >
        <Dialog.Portal>
          <Dialog.Backdrop className="fixed inset-0 z-50 bg-gray-950/45" />
          <Dialog.Popup className="fixed left-1/2 top-1/2 z-50 max-h-[calc(100dvh-2rem)] w-[calc(100%-2rem)] max-w-lg -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-[28px] border border-gray-200 bg-white p-6 outline-none">
            <Dialog.Title className="text-xl font-semibold text-gray-950">Who can use models</Dialog.Title>
            <Dialog.Description className="mt-2 text-sm leading-6 text-gray-500">
              Pick only models you provide, or let people still add their own.
            </Dialog.Description>
            {policiesError ? <DenNotice className="mt-4" tone="error" message={policiesError} /> : null}
            {error ? <DenNotice className="mt-4" tone="error" message={error} /> : null}
            <div className="mt-6 grid gap-3">
              <DenOptionCard
                type="radio"
                name="gateway-model-access-mode"
                testId="gateway-model-access-managed"
                title="Only models you provide"
                description="People cannot add their own keys. They only see providers you add here."
                checked={accessMode === "managed"}
                disabled={formDisabled}
                onChange={() => setAccessMode("managed")}
              />
              <DenOptionCard
                type="radio"
                name="gateway-model-access-mode"
                testId="gateway-model-access-open"
                title="Any model"
                description="People may still add their own providers alongside yours."
                checked={accessMode === "open"}
                disabled={formDisabled}
                onChange={() => setAccessMode("open")}
              />
            </div>
            {accessMode === "managed" ? (
              <div className="mt-4">
                <DenOptionCard
                  type="checkbox"
                  testId="gateway-model-access-admin-exception"
                  title="Admins may still add their own providers"
                  checked={adminExceptionChecked}
                  disabled={formDisabled}
                  onChange={setAdminExceptionChecked}
                />
              </div>
            ) : null}
            <div className="mt-6 flex flex-wrap justify-end gap-3">
              <Dialog.Close disabled={saving} className="text-sm text-gray-500">
                Cancel
              </Dialog.Close>
              <DenButton
                data-testid="gateway-model-policy-save"
                loading={saving}
                disabled={formDisabled}
                onClick={() => void save()}
              >
                Save
              </DenButton>
            </div>
          </Dialog.Popup>
        </Dialog.Portal>
      </Dialog.Root>
    </>
  );
}
