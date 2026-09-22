"use client";

import Link from "next/link";
import { Plus } from "lucide-react";
import { DashboardPageTemplate } from "../../_components/ui/dashboard-page-template";
import { DenBadge } from "../../_components/ui/badge";
import { DenBrandMark } from "../../_components/ui/brand-mark";
import { buttonVariants } from "../../_components/ui/button";
import { DenList, DenListRow } from "../../_components/ui/list-row";
import { DenNotice } from "../../_components/ui/notice";
import { getGatewayProviderRoute, getNewGatewayProviderRoute } from "../../_lib/den-org";
import { useOrgDashboard } from "../_providers/org-dashboard-provider";
import { GatewayUsageSection } from "./gateway-usage-section";
import { GatewayWhoCanUseModels } from "./gateway-who-can-use-models";
import { useOrgInferenceProviders } from "./inference-provider-data";
import {
  GATEWAY_PAGE_DESCRIPTION,
  describeGatewayAccess,
  getCredentialStatusLabel,
  getCredentialStatusTone,
  type DenInferenceProvider,
} from "./inference-provider-request";
import { getProviderDocUrl, getProviderIconSlug } from "./llm-provider-data";

function GatewayProviderRow({ provider, orgSlug }: { provider: DenInferenceProvider; orgSlug: string | null }) {
  const { orgContext } = useOrgDashboard();
  const access = describeGatewayAccess(provider, {
    organization: orgContext?.organization.name ?? null,
    teamName: (teamId) => orgContext?.teams.find((team) => team.id === teamId)?.name,
    memberName: (memberId) => orgContext?.members.find((member) => member.id === memberId)?.user.name,
  });

  return (
    <DenListRow
      href={getGatewayProviderRoute(orgSlug, provider.id)}
      ariaLabel={`Open ${provider.name}`}
      dataAttributes={{ "data-testid": "gateway-provider-open" }}
      leading={
        <DenBrandMark
          name={provider.providerId}
          simpleIconSlug={getProviderIconSlug(provider.providerId)}
          serviceUrl={getProviderDocUrl(provider.providerConfig)}
          className="h-9 w-9 shrink-0 rounded-xl"
          imageClassName="h-4 w-4"
        />
      }
      title={provider.name}
      chips={
        <DenBadge tone={getCredentialStatusTone(provider)}>
          {getCredentialStatusLabel(provider)}
        </DenBadge>
      }
      meta={access}
      action={
        <span className="text-[13px] text-gray-500">
          {provider.status === "disabled" ? "Off" : "Manage"}
        </span>
      }
    />
  );
}

export function InferenceProvidersScreen() {
  const { orgId, orgSlug } = useOrgDashboard();
  const { inferenceProviders, busy, error } = useOrgInferenceProviders(orgId);

  return (
    <DashboardPageTemplate
      title="AI Gateway"
      description={GATEWAY_PAGE_DESCRIPTION}
      colors={["#F1F5FF", "#1D4ED8", "#60A5FA", "#A7F3D0"]}
    >
      <GatewayWhoCanUseModels />

      <section aria-labelledby="gateway-providers-heading">
        <div className="mb-4 flex items-center justify-between gap-3">
          <h2 id="gateway-providers-heading" className="text-lg font-semibold tracking-tight text-gray-950">
            Providers
          </h2>
          <Link
            href={getNewGatewayProviderRoute(orgSlug)}
            data-testid="gateway-provider-create"
            className={buttonVariants({ variant: "primary" })}
          >
            <Plus className="h-4 w-4" aria-hidden="true" />
            Add a provider
          </Link>
        </div>

        {error ? <DenNotice message={error} tone="error" className="mb-6" /> : null}

        {busy ? (
          <div className="rounded-2xl border border-gray-100 bg-white px-6 py-10 text-[15px] text-gray-500">
            Loading providers…
          </div>
        ) : inferenceProviders.length === 0 ? (
          <div
            data-testid="gateway-providers-empty"
            className="rounded-2xl border border-gray-100 bg-white px-6 py-12 text-center"
          >
            <p className="text-[16px] font-medium tracking-[-0.03em] text-gray-900">No providers yet</p>
            <p className="mx-auto mt-3 max-w-[480px] text-[14px] leading-7 text-gray-500">
              Add a key from Anthropic, OpenAI, OpenRouter, or another catalog provider. Then choose who can use its models.
            </p>
            <Link
              href={getNewGatewayProviderRoute(orgSlug)}
              className={buttonVariants({ variant: "primary", className: "mt-6" })}
            >
              Add a provider
            </Link>
          </div>
        ) : (
          <DenList>
            {inferenceProviders.map((provider) => (
              <GatewayProviderRow key={provider.id} provider={provider} orgSlug={orgSlug} />
            ))}
          </DenList>
        )}
      </section>

      {orgId ? (
        <section aria-labelledby="gateway-usage-heading" className="mt-10">
          <h2 id="gateway-usage-heading" className="mb-4 text-sm font-medium text-gray-500">
            Usage and spending
          </h2>
          <GatewayUsageSection key={orgId} orgId={orgId} />
        </section>
      ) : null}
    </DashboardPageTemplate>
  );
}

export function InferenceCredentialStatusBadge({
  provider,
}: {
  provider: Pick<DenInferenceProvider, "credentialMode" | "credentialStatus">;
}) {
  return <DenBadge tone={getCredentialStatusTone(provider)}>{getCredentialStatusLabel(provider)}</DenBadge>;
}
