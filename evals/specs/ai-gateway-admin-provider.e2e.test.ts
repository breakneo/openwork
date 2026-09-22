import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { aiGatewayAdmin } from "../worlds/ai-gateway-admin.ts";

const test = spec.world(aiGatewayAdmin, {
  resources: { surfaces: ["web"], services: ["den"] },
  needs: { placement: "local" },
  timeout: 600_000,
});

function providers(body: unknown): Array<Record<string, unknown>> {
  const list = body && typeof body === "object" && "inferenceProviders" in body ? body.inferenceProviders : [];
  return Array.isArray(list) ? list.filter((entry): entry is Record<string, unknown> => typeof entry === "object" && entry !== null) : [];
}

test("an owner limits the org to models they provide, adds an Anthropic key for everyone, and a teammate cannot administer it", async ({
  world, user, probe, step, evidence,
}) => {
  const owner = user.on(world.web);
  const teammate = user.on(world.memberWeb);
  const manageable = "/v1/inference-providers?scope=manageable";

  await step("before: the owner opens AI Gateway and it is empty", async () => {
    await owner.see({ role: "heading", label: "AI Gateway" }, { timeoutMs: 90_000 });
    await owner.see({ testId: "gateway-providers-empty" });
    await owner.see({ text: "Any model, including ones people add themselves" });
    const before = await probe.api(world.den.admin, manageable);
    evidence.recordAssertionEvidence("no providers yet", `GET ${manageable} → ${before.response.status}, ${providers(before.body).length} providers`, providers(before.body).length === 0);
    await owner.screenshot();
  });

  await step("the owner switches the org to only the models they provide", async () => {
    await owner.click({ testId: "gateway-model-policy-open" });
    await owner.click({ testId: "gateway-model-access-managed" });
    await owner.click({ testId: "gateway-model-policy-save" });
    await owner.see({ text: "Only models you add here" }, { timeoutMs: 30_000 });
    const policies = await probe.api(world.den.admin, "/v1/desktop-policies");
    const text = JSON.stringify(policies.body);
    evidence.recordAssertionEvidence("default desktop policy blocks personal providers", `GET /v1/desktop-policies → ${policies.response.status}; allowCustomProviders:false present: ${text.includes('"allowCustomProviders":false')}`, text.includes('"allowCustomProviders":false'));
    await owner.screenshot();
  });

  await step("the owner picks Anthropic from the catalog", async () => {
    await owner.click({ testId: "gateway-provider-create" });
    await owner.see({ role: "heading", label: "Add a provider" }, { timeoutMs: 30_000 });
    await owner.click({ testId: "gateway-provider-pick-anthropic" });
    await owner.see({ testId: "gateway-provider-api-key" }, { timeoutMs: 30_000 });
    await owner.screenshot();
  });

  await step("after: one key, everyone, all models becomes a provider row shared with the whole org", async () => {
    await owner.type({ testId: "gateway-provider-name" }, "Anthropic for the company", { replace: true });
    await owner.type({ testId: "gateway-provider-api-key" }, "sk-ant-eval-not-a-real-key");
    await owner.click({ testId: "gateway-provider-save" });
    await owner.see({ role: "heading", label: "Anthropic for the company" }, { timeoutMs: 60_000 });
    await owner.click({ role: "link", label: "Back to AI Gateway" });
    await owner.see({ testId: "gateway-provider-open" }, { timeoutMs: 30_000 });
    await owner.see({ text: /Everyone in/ });
    const after = await probe.api(world.den.admin, manageable);
    const saved = providers(after.body).find((entry) => entry.name === "Anthropic for the company");
    const grants = Array.isArray(saved?.accessGrants) ? saved.accessGrants : [];
    const orgWide = grants.some((grant) => typeof grant === "object" && grant !== null && JSON.stringify(grant).includes('"type":"organization"'));
    evidence.recordAssertionEvidence("provider saved with an org-wide grant and no secret in the response", `${grants.length} grant(s), organization audience: ${orgWide}; response contains the key: ${after.text.includes("sk-ant-eval")}`, orgWide && !after.text.includes("sk-ant-eval"));
    expect(orgWide).toBe(true);
    expect(after.text).not.toContain("sk-ant-eval");
    await owner.screenshot();
  });

  await step("a teammate has no AI Gateway page and cannot list providers as an admin", async () => {
    await teammate.see({ testId: "den-org-sidebar" }, { timeoutMs: 90_000 });
    await teammate.notSee({ role: "link", label: /AI Gateway/ });
    await teammate.navigate(`${world.den.ref.webUrl}/dashboard/gateway-providers`);
    await teammate.notSee({ testId: "gateway-provider-create" }, { timeoutMs: 30_000 });
    const denied = await probe.api(world.teammate, manageable);
    evidence.recordAssertionEvidence("teammate is refused the admin list", `GET ${manageable} as teammate → ${denied.response.status}`, denied.response.status === 403);
    expect(denied.response.status).toBe(403);
    await teammate.screenshot();
  });
});
