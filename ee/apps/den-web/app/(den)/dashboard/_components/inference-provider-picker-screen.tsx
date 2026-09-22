"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { Search } from "lucide-react";
import { DashboardPageTemplate } from "../../_components/ui/dashboard-page-template";
import { DenBrandMark } from "../../_components/ui/brand-mark";
import { DenInput } from "../../_components/ui/input";
import { DenList, DenListRow } from "../../_components/ui/list-row";
import { DenNotice } from "../../_components/ui/notice";
import { getGatewayProvidersRoute, getNewGatewayProviderRoute } from "../../_lib/den-org";
import { useOrgDashboard } from "../_providers/org-dashboard-provider";
import { isSupportedGatewayNpm } from "./inference-provider-request";
import { getProviderIconSlug, requestLlmProviderCatalog, type DenModelsDevProviderSummary } from "./llm-provider-data";

export function InferenceProviderPickerScreen() {
  const { orgId, orgSlug } = useOrgDashboard();
  const [catalog, setCatalog] = useState<DenModelsDevProviderSummary[]>([]);
  const [query, setQuery] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!orgId) return;
    let cancelled = false;
    void requestLlmProviderCatalog(orgId)
      .then((result) => {
        if (!cancelled) setCatalog(result);
      })
      .catch(() => {
        if (!cancelled) setError("Could not load the provider catalog.");
      });
    return () => {
      cancelled = true;
    };
  }, [orgId]);

  const providers = useMemo(() => {
    const supported = catalog.filter((item) => isSupportedGatewayNpm(item.npm));
    const normalized = query.trim().toLowerCase();
    if (!normalized) return supported;
    return supported.filter(
      (item) => item.name.toLowerCase().includes(normalized) || item.id.toLowerCase().includes(normalized),
    );
  }, [catalog, query]);

  return (
    <DashboardPageTemplate
      title="Add a provider"
      description="Where do your models come from?"
      colors={["#F1F5FF", "#1D4ED8", "#60A5FA", "#A7F3D0"]}
    >
      <Link href={getGatewayProvidersRoute(orgSlug)} className="mb-6 inline-block text-sm text-gray-500">
        Back to AI Gateway
      </Link>
      {error ? <DenNotice tone="error" message={error} className="mb-6" /> : null}
      <DenInput
        type="search"
        icon={Search}
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        placeholder="Filter providers"
        data-testid="gateway-provider-catalog-filter"
      />
      <DenList className="mt-4">
        {providers.map((item) => (
          <DenListRow
            key={item.id}
            href={getNewGatewayProviderRoute(orgSlug, item.id)}
            ariaLabel={`Add ${item.name}`}
            dataAttributes={{ "data-testid": `gateway-provider-pick-${item.id}` }}
            leading={
              <DenBrandMark
                name={item.name}
                simpleIconSlug={getProviderIconSlug(item.id)}
                serviceUrl={item.doc}
                className="h-9 w-9 shrink-0 rounded-xl"
                imageClassName="h-4 w-4"
              />
            }
            title={item.name}
            meta={`${item.modelCount} ${item.modelCount === 1 ? "model" : "models"}`}
            action={<span className="text-[13px] text-gray-500">Continue</span>}
          />
        ))}
      </DenList>
      {catalog.length > 0 && providers.length === 0 ? (
        <p className="mt-4 text-sm text-gray-500">No providers match that filter.</p>
      ) : null}
    </DashboardPageTemplate>
  );
}
