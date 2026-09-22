"use client";

import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { getGatewayProvidersRoute } from "../../_lib/den-org";
import { useOrgDashboard } from "../_providers/org-dashboard-provider";
import { GatewayUsageLimitsSection } from "./gateway-usage-limits-section";
import { GatewayUsageSection } from "./gateway-usage-section";

/** Usage and spending limits for AI Gateway providers, reached from the two link rows on the AI Gateway page. */
export function GatewayUsageScreen() {
  const { orgId, orgSlug, orgContext } = useOrgDashboard();
  if (!orgId) return null;
  return (
    <div className="mx-auto max-w-[860px] px-6 py-6">
      <Link href={getGatewayProvidersRoute(orgSlug)} className="inline-flex items-center gap-1.5 text-[12px] text-gray-500 hover:text-gray-900">
        <ArrowLeft className="h-3.5 w-3.5" aria-hidden="true" />
        Back to AI Gateway
      </Link>
      <section id="usage" className="mt-6 scroll-mt-6">
        <GatewayUsageSection key={orgId} orgId={orgId} />
      </section>
      <section id="spending" className="mt-10 scroll-mt-6">
        <GatewayUsageLimitsSection key={`limits:${orgId}`} orgId={orgId} teams={orgContext?.teams ?? []} members={orgContext?.members ?? []} />
      </section>
    </div>
  );
}
