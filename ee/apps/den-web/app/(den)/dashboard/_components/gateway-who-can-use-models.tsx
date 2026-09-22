"use client";

import { useEffect, useState } from "react";
import { Dialog } from "@base-ui/react/dialog";
import { DenButton } from "../../_components/ui/button";
import { DenList, DenListRow } from "../../_components/ui/list-row";
import { DenNotice } from "../../_components/ui/notice";
import { DenOptionCard } from "../../_components/ui/option-card";
import { useOrgDashboard } from "../_providers/org-dashboard-provider";
import { useOrgDesktopPolicies } from "./desktop-policy-data";
import { readModelAccessState, saveModelAccess, type ModelAccessMode } from "./model-access-policy";

export function GatewayWhoCanUseModels() {
  const { orgId, runReauthableAction, reauthDialogOpen } = useOrgDashboard();
  const { desktopPolicies, busy, error: policiesError, reloadPolicies } = useOrgDesktopPolicies(orgId);
  const state = readModelAccessState(desktopPolicies);
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<ModelAccessMode>(state.mode);
  const [adminException, setAdminException] = useState(state.adminException);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setMode(state.mode);
    setAdminException(state.adminException);
  }, [state.mode, state.adminException]);

  const disabled = busy || saving || !state.defaultPolicy;

  async function save() {
    setError(null);
    setSaving(true);
    try {
      await runReauthableAction("save-model-access", async () => {
        await saveModelAccess(state, { mode, adminException, zenAllowed: state.zenAllowed });
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
          meta={busy ? "Loading…" : state.mode === "managed" ? "Only models you add here" : "Any model, including ones people add themselves"}
          action={
            <DenButton size="sm" variant="secondary" data-testid="gateway-model-policy-open" disabled={busy} onClick={() => setOpen(true)}>
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
          setError(null);
        }}
      >
        <Dialog.Portal>
          <Dialog.Backdrop className="fixed inset-0 z-50 bg-gray-950/45" />
          <Dialog.Popup className="fixed left-1/2 top-1/2 z-50 max-h-[calc(100dvh-2rem)] w-[calc(100%-2rem)] max-w-lg -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-[28px] border border-gray-200 bg-white p-6 outline-none">
            <Dialog.Title className="text-xl font-semibold text-gray-950">Who can use models</Dialog.Title>
            {policiesError ? <DenNotice className="mt-4" tone="error" message={policiesError} /> : null}
            {error ? <DenNotice className="mt-4" tone="error" message={error} /> : null}
            <div className="mt-6 grid gap-3">
              <DenOptionCard
                type="radio"
                name="gateway-model-access-mode"
                testId="gateway-model-access-managed"
                title="Only models you provide"
                description="People cannot add their own keys."
                checked={mode === "managed"}
                disabled={disabled}
                onChange={() => setMode("managed")}
              />
              <DenOptionCard
                type="radio"
                name="gateway-model-access-mode"
                testId="gateway-model-access-open"
                title="Any model"
                description="People may add their own providers alongside yours."
                checked={mode === "open"}
                disabled={disabled}
                onChange={() => setMode("open")}
              />
              {mode === "managed" ? (
                <DenOptionCard
                  type="checkbox"
                  testId="gateway-model-access-admin-exception"
                  title="Admins may still add their own providers"
                  checked={adminException}
                  disabled={disabled}
                  onChange={setAdminException}
                />
              ) : null}
            </div>
            <div className="mt-6 flex flex-wrap justify-end gap-3">
              <Dialog.Close disabled={saving} className="text-sm text-gray-500">
                Cancel
              </Dialog.Close>
              <DenButton data-testid="gateway-model-policy-save" loading={saving} disabled={disabled} onClick={() => void save()}>
                Save
              </DenButton>
            </div>
          </Dialog.Popup>
        </Dialog.Portal>
      </Dialog.Root>
    </>
  );
}
