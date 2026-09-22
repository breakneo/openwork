import { allocateFreePort } from "@openwork/cdp";
import { queryDenDatabase, type Seed } from "@openwork/env";

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected a Den response object");
  return Object.fromEntries(Object.entries(value));
}

/**
 * An owner and a teammate in one org with the AI Gateway dashboard turned on.
 * No gateway proxy runs: the journey is the Den admin form, so the proxy URLs
 * only satisfy den-api's GATEWAY_ENABLED boot check and point at a closed port.
 */
export async function aiGatewayAdmin(seed: Seed) {
  const gatewayUrl = `http://127.0.0.1:${await allocateFreePort()}`;
  const den = await seed.den({
    web: true,
    env: {
      NODE_ENV: "test", OPENWORK_DEV_MODE: "1", DB_MODE: "mysql", DEN_ORG_MODE: "multi_org",
      GATEWAY_ENABLED: "true", GATEWAY_PROXY_BASE_URL: gatewayUrl, GATEWAY_PUBLIC_BASE_URL: gatewayUrl,
      PROVISIONER_MODE: "stub", RESEND_API_KEY: "", STRIPE_SECRET_KEY: "", SENTRY_DSN: "",
    },
    org: {
      name: "Acme Studio",
      admin: { name: "Gateway Owner", email: "gateway-owner@example.test" },
      members: { teammate: { name: "Gateway Teammate", email: "gateway-teammate@example.test" } },
    },
  });
  const teammate = den.members.teammate;
  const databaseUrl = den.database?.url;
  if (!teammate || !databaseUrl) throw new Error("Expected a teammate session and a testkit scratch database");
  const org = record((await seed.api(den.admin, "/v1/org")).body);
  const orgId = String(record(org.organization).id);
  await queryDenDatabase(
    databaseUrl,
    "UPDATE organization SET metadata = JSON_SET(COALESCE(metadata, '{}'), '$.capabilities', COALESCE(JSON_EXTRACT(metadata, '$.capabilities'), JSON_OBJECT()), '$.capabilities.gatewayDashboard', JSON_EXTRACT('true', '$')) WHERE id = ?",
    [orgId],
  );
  if (record(record((await seed.api(den.admin, "/v1/org")).body).capabilities).gatewayDashboard !== true) {
    throw new Error("The org did not receive the AI Gateway dashboard capability");
  }
  const viewport = { width: 1440, height: 1100 };
  const web = await seed.web({ den, signedInAs: den.admin, startPath: "/dashboard/gateway-providers", headless: true, viewport });
  const memberWeb = await seed.web({ den, signedInAs: teammate, startPath: "/dashboard", headless: true, viewport });
  return { den, web, memberWeb, teammate, orgId };
}
