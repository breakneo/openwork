"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { AlertDialog } from "@base-ui/react/alert-dialog";
import type { GatewayAccessGrantWrite } from "@openwork/types/den/gateway";
import { DenButton, buttonVariants } from "../../_components/ui/button";
import { DenInput } from "../../_components/ui/input";
import { DenNotice } from "../../_components/ui/notice";
import { DenOptionCard } from "../../_components/ui/option-card";
import { DenStickyActionBar } from "../../_components/ui/sticky-action-bar";
import { DenTextarea } from "../../_components/ui/textarea";
import { getGatewayProviderRoute, getGatewayProvidersRoute } from "../../_lib/den-org";
import { useOrgDashboard } from "../_providers/org-dashboard-provider";
import {
  deleteGatewayResource,
  deleteInferenceProvider,
  saveGatewayResource,
  saveInferenceProvider,
  useInferenceProvider,
} from "./inference-provider-data";
import { GatewayModelUniverse } from "./inference-provider-model-universe";
import {
  accessFromGrants,
  buildInferenceProviderRequestBody,
  getRequiredSettingKeys,
  getSettingLabel,
  isGoogleVertexNpm,
  isSupportedGatewayNpm,
  supportsMemberCredentialMode,
} from "./inference-provider-request";
import {
  getProviderEnvNames,
  getProviderNpmPackage,
  requestLlmProviderCatalogDetail,
  type DenModelsDevProviderDetail,
} from "./llm-provider-data";
import { normalizeAzureResourceNameInput } from "./llm-provider-guided";
import { ProviderAccessPicker, type ProviderAccessValue } from "./llm-provider-pickers";

export function InferenceProviderEditorScreen({
  inferenceProviderId,
  catalogProviderId,
}: {
  inferenceProviderId?: string;
  catalogProviderId?: string;
}) {
  const router = useRouter();
  const { orgId, orgSlug, orgContext, runReauthableAction, reauthDialogOpen } = useOrgDashboard();
  const { provider, busy, error, reload } = useInferenceProvider(orgId, inferenceProviderId ?? null);
  const [detail, setDetail] = useState<DenModelsDevProviderDetail | null>(null);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [providerId, setProviderId] = useState(catalogProviderId ?? "");
  const [name, setName] = useState("");
  const [modelIds, setModelIds] = useState<string[]>([]);
  const [allowAllModels, setAllowAllModels] = useState(true);
  const [settings, setSettings] = useState<Record<string, string>>({});
  const [credentialMode, setCredentialMode] = useState<"org" | "member">("org");
  const [apiKey, setApiKey] = useState("");
  const [apiKeyValues, setApiKeyValues] = useState<Record<string, string>>({});
  const [serviceAccountJson, setServiceAccountJson] = useState("");
  const [oauthClientId, setOauthClientId] = useState("");
  const [oauthClientSecret, setOauthClientSecret] = useState("");
  const [access, setAccess] = useState<ProviderAccessValue>({ allMembers: true, memberIds: [], teamIds: [] });
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const cancelDeleteRef = useRef<HTMLButtonElement | null>(null);
  const initializedProviderId = useRef<string | null>(null);

  useEffect(() => {
    if (catalogProviderId) setProviderId(catalogProviderId);
  }, [catalogProviderId]);

  useEffect(() => {
    if (!provider || initializedProviderId.current === provider.id) return;
    initializedProviderId.current = provider.id;
    setProviderId(provider.providerId);
    setName(provider.name);
    setModelIds(provider.modelIds ?? provider.catalogModels.map((model) => model.id));
    setAllowAllModels(provider.modelIds !== null && provider.modelIds.length === 0);
    setSettings(provider.settings);
    setCredentialMode(provider.credentialMode);
    setOauthClientId(provider.oauthClientId ?? provider.credentialSets[0]?.oauthClientId ?? "");
    setAccess(accessFromGrants(provider.accessGrants));
  }, [provider]);

  useEffect(() => {
    setDetail(null);
    if (!orgId || !providerId) return;
    let cancelled = false;
    setCatalogError(null);
    void requestLlmProviderCatalogDetail(orgId, providerId)
      .then((result) => {
        if (cancelled) return;
        setDetail(result);
        if (!inferenceProviderId) setName((current) => current || result.name);
      })
      .catch(() => {
        if (!cancelled) setCatalogError("Could not load this provider's models. Existing configuration has not changed.");
      });
    return () => {
      cancelled = true;
    };
  }, [orgId, providerId, inferenceProviderId]);

  const npm = detail ? getProviderNpmPackage(detail.config) : null;
  const vertex = isGoogleVertexNpm(npm);
  const envNames = detail ? getProviderEnvNames(detail.config) : [];
  const memberSignInSupported = supportsMemberCredentialMode(providerId);
  const configuredSet = provider?.credentialSets[0] ?? null;
  const formInput = {
    name, providerId, modelIds: allowAllModels ? [] : modelIds, credentialMode, status: "active" as const,
    settings, envNames, apiKey, apiKeyValues, serviceAccountJson, oauthClientId, oauthClientSecret, access,
  };

  /** Edits go through the matrix routes: first group, first set, and one grant per audience. */
  async function syncAccessAndCredential() {
    if (!provider) return;
    const group = provider.modelGroups[0];
    const set = provider.credentialSets[0];
    if (!group || !set) return;
    const groupModels = allowAllModels ? (detail?.models ?? []).map((model) => model.id) : modelIds;
    if (groupModels.length) {
      await saveGatewayResource(provider.id, group.id, {
        resource: "model-groups",
        body: { name: group.name, description: group.description, modelIds: groupModels, status: "active" },
      });
    }
    const { credential, apiKeys, oauthClientId: clientId, oauthClientSecret: clientSecret } = buildInferenceProviderRequestBody(formInput);
    if (credential || apiKeys || credentialMode === "member" || set.credentialMode !== credentialMode) {
      await saveGatewayResource(provider.id, set.id, {
        resource: "credential-sets",
        body: { name: set.name, credentialMode, status: "active", credential, apiKeys, oauthClientId: clientId, oauthClientSecret: clientSecret },
      });
    }
    const desired: GatewayAccessGrantWrite["audience"][] = [
      ...(access.allMembers ? [{ type: "organization" as const }] : []),
      ...[...new Set(access.teamIds)].map((teamId) => ({ type: "team" as const, teamId })),
      ...[...new Set(access.memberIds)].map((memberId) => ({ type: "member" as const, memberId })),
    ];
    const existing = provider.accessGrants.filter((grant) => grant.modelGroupId === group.id && grant.credentialSetId === set.id);
    const same = (a: GatewayAccessGrantWrite["audience"], b: GatewayAccessGrantWrite["audience"]) => JSON.stringify(a) === JSON.stringify(b);
    for (const grant of existing) {
      if (!desired.some((audience) => same(audience, grant.audience))) await deleteGatewayResource(provider.id, "access-grants", grant.id);
    }
    for (const audience of desired) {
      if (!existing.some((grant) => same(grant.audience, audience))) {
        await saveGatewayResource(provider.id, null, { resource: "access-grants", body: { audience, modelGroupId: group.id, credentialSetId: set.id } });
      }
    }
  }

  async function save() {
    setSaveError(null);
    if (!detail || detail.id !== providerId) return setSaveError("Select a provider and wait for its catalog to load.");
    if (!isSupportedGatewayNpm(npm)) return setSaveError("This provider is not supported by AI Gateway.");
    if (!name.trim()) return setSaveError("Give the provider a name.");
    if (!allowAllModels && !modelIds.length) return setSaveError("Select at least one model, or turn on all models.");
    for (const key of getRequiredSettingKeys(npm)) {
      if (!settings[key]?.trim()) return setSaveError(`${getSettingLabel(key)} is required.`);
    }
    const granting = access.allMembers || access.teamIds.length > 0 || access.memberIds.length > 0;
    if (!provider && granting && credentialMode === "org") {
      const hasKey = vertex ? Boolean(serviceAccountJson.trim()) : envNames.length > 1
        ? Object.values(apiKeyValues).some((value) => value.trim())
        : Boolean(apiKey.trim());
      if (!hasKey) return setSaveError("Add a key before sharing these models.");
    }
    if (credentialMode === "member" && (!memberSignInSupported || !oauthClientId.trim() || (!oauthClientSecret.trim() && !configuredSet?.hasOauthClientSecret))) {
      return setSaveError("People sign in needs a Google OAuth client ID and secret.");
    }
    setSaving(true);
    try {
      await runReauthableAction("save-inference-provider", async () => {
        if (!provider) {
          const saved = await saveInferenceProvider({ inferenceProviderId: null, body: buildInferenceProviderRequestBody(formInput) });
          router.push(getGatewayProviderRoute(orgSlug, saved.id));
          router.refresh();
          return;
        }
        await saveInferenceProvider({
          inferenceProviderId: provider.id,
          body: {
            name: name.trim(),
            modelIds: allowAllModels ? [] : modelIds,
            status: "active",
          },
        });
        await syncAccessAndCredential();
        await reload();
        router.push(getGatewayProviderRoute(orgSlug, provider.id));
        router.refresh();
      });
    } catch (cause) {
      setSaveError(cause instanceof Error ? cause.message : "Could not save the provider.");
    } finally {
      setSaving(false);
    }
  }

  async function remove() {
    if (!provider || saving) return;
    setSaving(true);
    setSaveError(null);
    try {
      await runReauthableAction("delete-inference-provider", async () => {
        await deleteInferenceProvider(provider.id);
        setConfirmDelete(false);
        router.push(getGatewayProvidersRoute(orgSlug));
        router.refresh();
      });
    } catch (cause) {
      setSaveError(cause instanceof Error ? cause.message : "Could not delete the provider.");
    } finally {
      setSaving(false);
    }
  }

  if (inferenceProviderId && !provider) {
    return <div className="p-8">{busy ? "Loading provider..." : <DenNotice tone="error" message={error ?? "Provider not found."} />}</div>;
  }

  const backHref = getGatewayProvidersRoute(orgSlug);
  const heading = provider ? provider.name : `Add ${detail?.name ?? "a provider"}`;

  return (
    <div className="mx-auto max-w-[860px] px-6 py-8 md:px-8">
      <Link href={backHref} className="text-sm text-gray-500">
        Back to AI Gateway
      </Link>
      <h1 className="my-6 text-3xl font-semibold">{heading}</h1>
      <p className="mb-8 text-gray-500">
        {provider
          ? "Same form as when you added it. Change the key, who can use it, or the models."
          : "One form: key, who can use these models, and which models."}
      </p>
      {saveError ? <DenNotice tone="error" message={saveError} className="mb-6" /> : null}
      {catalogError ? <DenNotice tone="error" message={catalogError} className="mb-6" /> : null}

      <section className="mb-8 border-b border-gray-200 pb-8">
        <h2 className="mb-5 text-xl font-semibold">Provider</h2>
        <div className="grid gap-6">
          <p className="text-sm text-gray-500">{providerId || "Choose a provider from the catalog."}</p>
          <div className="grid gap-2">
            <label htmlFor="gateway-provider-name">Name</label>
            <DenInput
              id="gateway-provider-name"
              data-testid="gateway-provider-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
          </div>
          {getRequiredSettingKeys(npm).map((key) => (
            <label key={key} className="grid gap-2">
              {getSettingLabel(key)}
              <DenInput
                readOnly={Boolean(provider)}
                value={settings[key] ?? ""}
                onChange={(event) =>
                  setSettings((current) => ({
                    ...current,
                    [key]: key === "resourceName" ? normalizeAzureResourceNameInput(event.target.value) : event.target.value,
                  }))
                }
              />
            </label>
          ))}
        </div>
      </section>

      <section className="mb-8 border-b border-gray-200 pb-8">
        <h2 className="mb-5 text-xl font-semibold">Key</h2>
        {memberSignInSupported ? (
          <div className="mb-6 grid gap-3">
            <DenOptionCard
              type="radio"
              name="gateway-credential-mode"
              testId="gateway-credential-org"
              title="Organization key"
              description="One key for everyone you share this provider with."
              checked={credentialMode === "org"}
              onChange={() => setCredentialMode("org")}
            />
            <DenOptionCard
              type="radio"
              name="gateway-credential-mode"
              testId="gateway-credential-member"
              title="People sign in"
              description="Each person signs in with Google. You add the OAuth client."
              checked={credentialMode === "member"}
              onChange={() => setCredentialMode("member")}
            />
          </div>
        ) : null}
        {credentialMode === "member" ? (
          <div className="grid gap-4">
            <label className="grid gap-2">
              OAuth client ID
              <DenInput
                data-testid="gateway-oauth-client-id"
                value={oauthClientId}
                onChange={(event) => setOauthClientId(event.target.value)}
              />
            </label>
            <label className="grid gap-2">
              OAuth client secret
              <DenInput
                type="password"
                data-testid="gateway-oauth-client-secret"
                value={oauthClientSecret}
                onChange={(event) => setOauthClientSecret(event.target.value)}
                placeholder={configuredSet?.hasOauthClientSecret ? "Saved — enter a replacement to change it" : undefined}
              />
            </label>
            {provider?.oauthCallbackUrl ? (
              <p className="text-sm text-gray-500">
                Add this URL to the allowed redirect URIs in your OAuth client configuration. {provider.oauthCallbackUrl}
              </p>
            ) : null}
          </div>
        ) : vertex ? (
          <label className="grid gap-2">
            Service account JSON
            <DenTextarea
              data-testid="gateway-service-account"
              value={serviceAccountJson}
              onChange={(event) => setServiceAccountJson(event.target.value)}
              placeholder={configuredSet?.configured ? "Saved — paste a replacement to change it" : "Paste the key file"}
            />
          </label>
        ) : envNames.length > 1 ? (
          <div className="grid gap-4">
            {envNames.map((envName) => (
              <label key={envName} className="grid gap-2">
                {envName}
                <DenInput
                  type="password"
                  value={apiKeyValues[envName] ?? ""}
                  onChange={(event) => setApiKeyValues((current) => ({ ...current, [envName]: event.target.value }))}
                />
              </label>
            ))}
          </div>
        ) : (
          <label className="grid gap-2">
            API key
            <DenInput
              type="password"
              data-testid="gateway-provider-api-key"
              value={apiKey}
              onChange={(event) => setApiKey(event.target.value)}
              placeholder={configuredSet?.configured ? "Saved — enter a replacement to change it" : "Paste the key"}
            />
          </label>
        )}
      </section>

      <section className="mb-8 border-b border-gray-200 pb-8">
        <h2 className="mb-5 text-xl font-semibold">Who can use it</h2>
        <ProviderAccessPicker
          orgContext={orgContext}
          value={access}
          onChange={setAccess}
          lockedMemberId={null}
          testIdPrefix="gateway-access"
        />
      </section>

      <section className="mb-8 border-b border-gray-200 pb-8">
        <GatewayModelUniverse
          models={detail?.models ?? null}
          allowAllModels={allowAllModels}
          modelIds={modelIds}
          disabled={saving}
          warning={provider?.catalogWarning}
          onChange={(allowAll, selected) => {
            setAllowAllModels(allowAll);
            setModelIds(selected);
          }}
        />
      </section>

      <DenStickyActionBar
        summary={allowAllModels ? "All models · follows catalog updates" : `${modelIds.length} selected models`}
      >
        <DenButton data-testid="gateway-provider-save" loading={saving} onClick={() => void save()}>
          {provider ? "Save changes" : `Add ${detail?.name ?? "provider"}`}
        </DenButton>
      </DenStickyActionBar>

      {provider ? (
        <div className="mt-8 grid gap-3">
          <AlertDialog.Root
            open={confirmDelete && !reauthDialogOpen}
            onOpenChange={(open) => {
              if (saving) return;
              setConfirmDelete(open);
              if (open) setSaveError(null);
            }}
          >
            <AlertDialog.Trigger disabled={saving} className={buttonVariants({ variant: "destructive", className: "w-fit" })}>
              Remove provider
            </AlertDialog.Trigger>
            <AlertDialog.Portal>
              <AlertDialog.Backdrop className="fixed inset-0 z-50 bg-gray-950/45" />
              <AlertDialog.Popup
                initialFocus={cancelDeleteRef}
                aria-busy={saving}
                className="fixed left-1/2 top-1/2 z-50 w-[calc(100%-2rem)] max-w-md max-h-[calc(100dvh-2rem)] -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-[28px] border border-gray-200 bg-white p-6 outline-none"
              >
                <AlertDialog.Title className="text-xl font-semibold text-gray-950">Remove {provider.name}?</AlertDialog.Title>
                <AlertDialog.Description className="mt-3 text-sm leading-6 text-gray-600">
                  People lose these models. This cannot be undone.
                </AlertDialog.Description>
                {saveError ? <DenNotice className="mt-4" tone="error" message={saveError} /> : null}
                <div className="mt-6 flex flex-wrap justify-end gap-3">
                  <AlertDialog.Close ref={cancelDeleteRef} disabled={saving} className={buttonVariants({ variant: "secondary" })}>
                    Cancel
                  </AlertDialog.Close>
                  <DenButton variant="destructive" loading={saving} onClick={() => void remove()}>
                    Remove provider
                  </DenButton>
                </div>
              </AlertDialog.Popup>
            </AlertDialog.Portal>
          </AlertDialog.Root>
        </div>
      ) : null}
    </div>
  );
}
