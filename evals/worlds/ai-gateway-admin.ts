import type { Seed } from "@openwork/env";
import { queryDenDatabase } from "@openwork/env";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(record: Record<string, unknown> | null, key: string): string {
  const value = record?.[key];
  return typeof value === "string" ? value : "";
}

export async function aiGatewayAdmin(seed: Seed) {
  const den = await seed.den({
    env: {
      GATEWAY_ENABLED: "true",
      NODE_ENV: "test",
      OPENWORK_DEV_MODE: "1",
      DEN_ORG_MODE: "multi_org",
    },
    org: {
      name: `AI Gateway ${Date.now()}`,
      admin: { name: "Gateway Admin" },
      members: { teammate: { name: "Gateway Teammate" } },
    },
  });
  const teammate = den.members.teammate;
  if (!teammate) throw new Error("The isolated Den did not provision a teammate.");
  const context = await seed.api(den.admin, "/v1/org");
  const organization = isRecord(context.body) && isRecord(context.body.organization) ? context.body.organization : null;
  const orgId = text(organization, "id");
  const databaseUrl = den.database?.url;
  if (!orgId || !databaseUrl) throw new Error("The isolated Den did not return an organization id and database.");
  await queryDenDatabase(
    databaseUrl,
    "UPDATE organization SET metadata = JSON_SET(COALESCE(metadata, '{}'), '$.capabilities', COALESCE(JSON_EXTRACT(metadata, '$.capabilities'), JSON_OBJECT()), '$.capabilities.gatewayDashboard', JSON_EXTRACT('true', '$')) WHERE id = ?",
    [orgId],
  );
  const after = await seed.api(den.admin, "/v1/org");
  const capabilities = isRecord(after.body) && isRecord(after.body.capabilities) ? after.body.capabilities : null;
  if (capabilities?.gatewayDashboard !== true) {
    throw new Error("The organization did not receive the AI Gateway dashboard capability.");
  }
  const web = await seed.web({
    den,
    signedInAs: den.admin,
    startPath: "/dashboard/gateway-providers",
    headless: true,
    viewport: { width: 1440, height: 1100 },
  });
  const memberWeb = await seed.web({
    den,
    signedInAs: teammate,
    startPath: "/dashboard",
    headless: true,
    viewport: { width: 1440, height: 1100 },
  });
  return { den, web, memberWeb, teammate, orgId };
}
