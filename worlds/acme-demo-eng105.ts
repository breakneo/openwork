import { denFetch, signIn } from "../evals/packages/behaviors/src/den.ts";
import type { DenSession } from "../evals/packages/behaviors/src/den.ts";
import { signInDesktopAs } from "../evals/packages/behaviors/src/desktop-boot.ts";
import { resolvePlace } from "../evals/packages/env/src/place.ts";
import type { Place } from "../evals/packages/env/src/place.ts";
import { hold } from "../packages/world/src/hold.ts";
import { output, secret } from "../packages/world/src/outputs.ts";
import { bootAcmeDemo } from "./acme-demo.ts";
import type { AcmeDemoWorld } from "./acme-demo.ts";

export interface RegistrationReceipt {
  key: string;
  phase: "registration" | "superseded-api-key-contract";
  url: string;
  status: number;
  ok: boolean;
  connectionId: string | null;
  /** Exact failure response, with world credentials redacted; never a success payload. */
  errorBody: string | null;
}

export interface AcmeDemoEng105World extends AcmeDemoWorld {
  orgId: string;
  jordanSession: DenSession;
  registrations: RegistrationReceipt[];
}

function field(value: unknown, key: string): string | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const result: unknown = Reflect.get(value, key);
  return typeof result === "string" ? result : null;
}

function required(value: unknown, key: string): string {
  const result = field(value, key);
  if (!result) throw new Error(`ENG105: missing ${key} in public API response`);
  return result;
}

function endpoint(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
    throw new Error("ENG105 MCP URLs must be HTTPS without credentials, query, or fragment");
  }
  return url.href;
}

/** Only owns a cold local Acme topology; never attaches to an existing Den/app. */
export async function bootAcmeDemoEng105(
  stack: AsyncDisposableStack,
  place: Place,
): Promise<AcmeDemoEng105World> {
  if (place.kind !== "local") throw new Error("ENG105 demo-org seed requires the local lane");
  if (process.env.OPENWORK_EVAL_DEN_API_URL || process.env.OPENWORK_EVAL_DESKTOP_CDP_URL) {
    throw new Error("ENG105 refuses attached/shared Den or desktop overrides");
  }
  const homeUrl = endpoint(process.env.ENG105_HOME_MCP_URL ?? "https://acme-home-demo.vercel.app/mcp");
  const calendarUrl = endpoint(process.env.ENG105_CALENDAR_MCP_URL ?? "https://personal-calendar-demo-mcp-app.vercel.app/mcp");
  // Demo invitation mail stays in Den's dev outbox; never inherit a mail provider.
  process.env.RESEND_API_KEY = "";
  process.env.SMTP_HOST = "";
  const world = await bootAcmeDemo(stack, place);
  const { den, jordan } = world;
  const auth = { authorization: `Bearer ${den.admin.token}` };
  const org = await denFetch(den.ref, "/v1/org", { headers: auth });
  if (!org.response.ok) throw new Error(`ENG105 organization: HTTP ${org.response.status}`);
  if (typeof org.body !== "object" || org.body === null) throw new Error("ENG105 organization response missing");
  const orgId = required(Reflect.get(org.body, "organization"), "id");
  const headers = { ...auth, "x-openwork-org-id": orgId };

  const email = "jordan.eng105@acme.example";
  const password = "Eng105-Jordan-Demo-Only!";
  const invite = await denFetch(den.ref, "/v1/invitations", {
    method: "POST", headers, body: JSON.stringify({ email, role: "member" }),
  });
  if (!invite.response.ok) throw new Error(`ENG105 invitation: HTTP ${invite.response.status}`);
  const inviteToken = required(invite.body, "inviteToken");
  const signup = await denFetch(den.ref, `/api/auth/sign-up/email?invite=${encodeURIComponent(inviteToken)}`, {
    method: "POST", body: JSON.stringify({ name: "Jordan Demo", email, password, invite: inviteToken }),
  });
  if (!signup.response.ok) throw new Error(`ENG105 invited signup: HTTP ${signup.response.status}`);
  const jordanSession = await signIn(den.ref, { email, password });
  const accept = await denFetch(den.ref, "/v1/orgs/invitations/accept", {
    method: "POST", headers: { authorization: `Bearer ${jordanSession.token}` },
    body: JSON.stringify({ id: inviteToken }),
  });
  if (!accept.response.ok) throw new Error(`ENG105 invitation acceptance: HTTP ${accept.response.status}`);
  den.members.jordan = jordanSession;
  await signInDesktopAs(jordan, den.ref, jordanSession);

  const minted = await denFetch(den.ref, "/v1/api-keys", {
    method: "POST", headers, body: JSON.stringify({ name: "ENG105 world provisioning" }),
  });
  if (!minted.response.ok) throw new Error(`ENG105 admin key: HTTP ${minted.response.status}`);
  const apiKey = required(minted.body, "key");
  const redact = (text: string) => [apiKey, den.admin.token, den.admin.password, jordanSession.token, password, inviteToken]
    .reduce((result, value) => value ? result.replaceAll(value, "[REDACTED]") : result, text);
  const registrations: RegistrationReceipt[] = [];
  const put = async (key: string, url: string, config: Record<string, unknown>, phase: RegistrationReceipt["phase"] = "registration") => {
    // One request per declared config; no uncertain retries or auth substitutions.
    const result = await denFetch(den.ref, `/v1/mcp-connections/by-key/${key}`, {
      method: "PUT", headers: { "x-api-key": apiKey },
      body: JSON.stringify({ url, access: { orgWide: true }, exposeDirectly: false, ...config }),
    });
    const receipt: RegistrationReceipt = {
      key, phase, url, status: result.response.status, ok: result.response.ok,
      connectionId: field(result.body, "id"),
      errorBody: result.response.ok ? null : redact(result.text),
    };
    registrations.push(receipt);
    console.log(`ENG105 registration ${JSON.stringify(receipt)}`);
  };
  await put("eng105-acme-home", homeUrl, { name: "Acme Home", authType: "none", credentialMode: "shared" });
  await put("eng105-world-clocks", "https://world-clocks-six.vercel.app/mcp", { name: "World Clocks", authType: "none", credentialMode: "shared" });
  await put("eng105-personal-calendar", calendarUrl, { name: "Personal Calendar", authType: "apikey", credentialMode: "per_member" }, "superseded-api-key-contract");
  const clientId = process.env.ENG105_CALENDAR_CLIENT_ID;
  if (clientId) {
    await put("eng105-personal-calendar", calendarUrl, {
      name: "Personal Calendar", authType: "oauth", credentialMode: "per_member",
      authorizationServerIssuer: new URL(calendarUrl).origin,
      oauthClient: { clientId, tokenEndpointAuthMethod: "none" },
      requestedScopes: ["calendar:read"],
    });
  } else {
    registrations.push({ key: "eng105-personal-calendar", phase: "registration", url: calendarUrl,
      status: 0, ok: false, connectionId: null,
      errorBody: "Pending calendar worker contract: set ENG105_CALENDAR_CLIENT_ID to the public DCR/client-metadata client ID. No OAuth flow was attempted." });
  }
  return { ...world, orgId, jordanSession, registrations };
}

export async function main(): Promise<void> {
  await using stack = new AsyncDisposableStack();
  const world = await bootAcmeDemoEng105(stack, resolvePlace());
  const { den, alex, jordan, jordanSession, orgId, registrations } = world;
  await hold({
    name: "acme-demo-eng105",
    outputs: {
      denWeb: output(den.ref.webUrl, { group: "URLs" }),
      denApi: output(den.ref.apiUrl, { group: "URLs" }),
      alexCdp: output(alex.handle.cdpUrl, { group: "URLs" }),
      jordanCdp: output(jordan.handle.cdpUrl, { group: "URLs" }),
      alexEmail: output(den.admin.email, { group: "Accounts", note: "Acme org owner, signed in" }),
      alexPassword: secret(den.admin.password, { group: "Accounts" }),
      jordanEmail: output(jordanSession.email, { group: "Accounts", note: "invited member, fresh desktop signed in" }),
      jordanPassword: secret(jordanSession.password, { group: "Accounts" }),
      orgId: output(orgId, { group: "Org" }),
      dashboards: output("enabled", { group: "Org", note: "DEN_DASHBOARDS_ENABLED=true" }),
      registrations: output(JSON.stringify(registrations), { group: "Receipts", note: "Registration is not provider connectivity or UI proof" }),
      calendarConnect: output("Each member clicks Connect in Your Connections; no member credentials seeded", { group: "Next steps" }),
      journey: output("Den Web Dashboard: Add MCP App, then grant Jordan access. Not chat Save as app.", { group: "Next steps" }),
    },
  });
}

if (import.meta.main) await main();
