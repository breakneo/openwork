import { expect } from "vitest";
import { spec } from "@openwork/testkit";
import { aiGatewayAdmin } from "../worlds/ai-gateway-admin.ts";

const test = spec.world(aiGatewayAdmin, {
  timeout: 600_000,
  resources: { surfaces: ["appWeb"], services: ["den"] },
});

test("an owner adds an Anthropic key, shares it with everyone, and a teammate cannot administer the gateway", async ({
  world,
  user,
  probe,
  step,
}) => {
  const admin = user.on(world.web);
  const teammate = user.on(world.memberWeb);
  const list = await probe.api(world.den.admin, "/v1/inference-providers?scope=manageable");
  expect(list.response.ok).toBe(true);

  await step("before: the owner sees an empty AI Gateway", async () => {
    await admin.see({ role: "heading", label: "AI Gateway" }, { timeoutMs: 90_000 });
    await admin.see({ testId: "gateway-providers-empty" });
    await admin.see({ text: "Your organization's provider keys stay on the server" });
    await admin.screenshot();
  });

  await step("the owner limits the org to only models they provide", async () => {
    await admin.click({ testId: "gateway-model-policy-open" });
    await admin.see({ text: "Only models you provide" });
    await admin.click({ testId: "gateway-model-access-managed" });
    await admin.click({ testId: "gateway-model-policy-save" });
    await admin.see({ text: "Only models you add here" }, { timeoutMs: 30_000 });
    await admin.screenshot();
  });

  await step("the owner picks Anthropic from the catalog", async () => {
    await admin.click({ testId: "gateway-provider-create" });
    await admin.see({ role: "heading", label: "Add a provider" }, { timeoutMs: 30_000 });
    await admin.see({ testId: "gateway-provider-pick-anthropic" });
    await admin.click({ testId: "gateway-provider-pick-anthropic" });
    await admin.see({ testId: "gateway-provider-api-key" }, { timeoutMs: 30_000 });
    await admin.screenshot();
  });

  await step("after: one key, everyone, all models becomes a shared provider", async () => {
    await admin.type({ testId: "gateway-provider-name" }, "Anthropic for the company", { replace: true });
    await admin.type({ testId: "gateway-provider-api-key" }, "sk-ant-eval-not-a-real-key");
    await admin.click({ testId: "gateway-provider-save" });
    await admin.see({ role: "heading", label: "Anthropic for the company" }, { timeoutMs: 60_000 });
    await admin.see({ role: "button", label: "Save changes" });
    await admin.click({ role: "link", label: "Back to AI Gateway" });
    await admin.see({ testId: "gateway-provider-open" }, { timeoutMs: 30_000 });
    await admin.see({ text: "Anthropic for the company" });
    await admin.see({ text: /Everyone/ });
    await admin.screenshot();
  });

  await step("a teammate cannot open AI Gateway", async () => {
    await teammate.see({ testId: "den-org-sidebar" }, { timeoutMs: 90_000 });
    await teammate.notSee({ role: "link", label: /AI Gateway/ });
    await teammate.navigate(`${world.den.ref.webUrl}/dashboard/gateway-providers`);
    await teammate.notSee({ testId: "gateway-provider-create" });
    await teammate.screenshot();
  });
});
