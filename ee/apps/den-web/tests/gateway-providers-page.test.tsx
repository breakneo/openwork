import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { GATEWAY_PAGE_DESCRIPTION, describeGatewayAccess } from "../app/(den)/dashboard/_components/inference-provider-request";
import { GatewayModelUniverse } from "../app/(den)/dashboard/_components/inference-provider-model-universe";
import {
  getCustomLlmProvidersRoute,
  getGatewayProviderRoute,
  getGatewayProvidersRoute,
  getNewGatewayProviderRoute,
} from "../app/(den)/_lib/den-org";

const appRoot = join(import.meta.dir, "..", "app", "(den)");

function read(...segments: string[]) {
  return readFileSync(join(appRoot, ...segments), "utf8");
}

const shell = read("dashboard", "_components", "org-dashboard-shell.tsx");
const navigation = read("dashboard", "_lib", "dashboard-navigation.ts");
const list = read("dashboard", "_components", "inference-providers-screen.tsx");
const editor = read("dashboard", "_components", "inference-provider-editor-screen.tsx");
const picker = read("dashboard", "_components", "inference-provider-picker-screen.tsx");
const policy = read("dashboard", "_components", "gateway-who-can-use-models.tsx");
const byok = read("dashboard", "_components", "llm-providers-screen.tsx");
const usage = read("dashboard", "_components", "gateway-usage-section.tsx");
const llmDetail = read("dashboard", "_components", "llm-provider-detail-screen.tsx");

describe("Gateway providers routes", () => {
  test("live next to custom-llm-providers under the org dashboard", () => {
    const base = getGatewayProvidersRoute("acme");
    expect(base).toBe(getCustomLlmProvidersRoute("acme").replace("custom-llm-providers", "gateway-providers"));
    expect(getNewGatewayProviderRoute("acme")).toBe(`${base}/new`);
    expect(getNewGatewayProviderRoute("acme", "anthropic")).toBe(`${base}/new?provider=anthropic`);
    expect(getGatewayProviderRoute("acme", "infp_1")).toBe(`${base}/infp_1`);
  });

  test("list, catalog-or-form, and saved-provider pages share the editor", () => {
    const pages = join(appRoot, "dashboard", "(admin)", "gateway-providers");
    expect(readFileSync(join(pages, "page.tsx"), "utf8")).toContain("InferenceProvidersScreen");
    const newPage = readFileSync(join(pages, "new", "page.tsx"), "utf8");
    expect(newPage).toContain("InferenceProviderPickerScreen");
    expect(newPage).toContain("InferenceProviderEditorScreen");
    expect(readFileSync(join(pages, "[inferenceProviderId]", "page.tsx"), "utf8")).toContain("InferenceProviderEditorScreen");
  });
});

describe("Gateway providers sidebar", () => {
  test("appears first under the admin-gated Models group before legacy BYOK", () => {
    const byokIndex = navigation.indexOf('label: "Bring Your Own Keys (Legacy)"');
    const gateway = navigation.indexOf('label: "AI Gateway", badge: "New"');
    expect(gateway).toBeGreaterThan(-1);
    expect(byokIndex).toBeGreaterThan(gateway);
    expect(shell).toContain('return "AI Gateway";');
  });
});

describe("Gateway providers list", () => {
  test("names who can use models and opens a provider as a row", () => {
    expect(GATEWAY_PAGE_DESCRIPTION).toContain("provider keys stay on the server");
    expect(list).toContain("<GatewayWhoCanUseModels");
    expect(list).toContain("describeGatewayAccess");
    expect(list).toContain('data-testid="gateway-provider-create"');
    expect(list).toContain("gateway-provider-open");
    expect(list).toContain("<GatewayUsageSection");
    expect(list).not.toContain("<DenCard");
  });

  test("the policy sheet and the BYOK page save the same desktop policy", () => {
    expect(policy).toContain('testId="gateway-model-access-managed"');
    for (const source of [policy, byok]) {
      expect(source).toContain("readModelAccessState");
      expect(source).toContain("saveModelAccess(");
      expect(source).not.toContain("updateDesktopPolicy");
    }
  });

  test("row copy names everyone, a team, or nobody", () => {
    const names = {
      organization: "Acme",
      teamName: (id: string) => (id === "team_design" ? "Design" : undefined),
      memberName: () => undefined,
    };
    const grant = (audience: { type: "organization" } | { type: "team"; teamId: string }) => ({ id: "g", modelGroupId: "mg", credentialSetId: "cs", audience });
    expect(describeGatewayAccess({ accessGrants: [] }, names)).toBe("No one has access yet");
    expect(describeGatewayAccess({ accessGrants: [grant({ type: "organization" })] }, names)).toBe("Everyone in Acme");
    expect(describeGatewayAccess({ accessGrants: [grant({ type: "team", teamId: "team_design" })] }, names)).toBe("Design");
  });
});

describe("Gateway provider form", () => {
  test("catalog picker then one form for key, who, and models", () => {
    expect(picker).toContain("Where do your models come from?");
    expect(picker).toContain("getNewGatewayProviderRoute(orgSlug, item.id)");
    expect(editor).toContain("<ProviderAccessPicker");
    expect(editor).toContain("<GatewayModelUniverse");
    expect(editor).toContain('data-testid="gateway-provider-api-key"');
  });

  test("create posts one body; edit rewrites group, set, and grants through the matrix routes", () => {
    expect(editor).toContain("buildInferenceProviderRequestBody(formInput)");
    expect(editor).toContain('resource: "model-groups"');
    expect(editor).toContain('resource: "credential-sets"');
    expect(editor).toContain('resource: "access-grants"');
    expect(editor).toContain("deleteGatewayResource");
    expect(editor).toContain("Add a key before sharing these models.");
    expect(editor).toContain("modelIds: allowAllModels ? [] : modelIds");
    expect(editor).toContain("open={confirmDelete && !reauthDialogOpen}");
  });

  test("member sign-in is gated to Google Vertex and collects the org OAuth client", () => {
    expect(editor).toContain("supportsMemberCredentialMode(providerId)");
    expect(editor).toContain('data-testid="gateway-oauth-client-id"');
    expect(editor).toContain('data-testid="gateway-oauth-client-secret"');
    expect(editor).toContain("Saved — enter a replacement to change it");
  });

  test.each([true, false])("renders the model universe with allow-all %s", (allowAllModels) => {
    const html = renderToStaticMarkup(createElement(GatewayModelUniverse, {
      models: [{ id: "model-1", name: "Test Model" }], allowAllModels, modelIds: ["model-1"], onChange: () => {},
    }));
    expect(html).toContain('aria-label="Allow all models"');
    expect(html).toContain(`aria-checked="${allowAllModels}"`);
    expect(html.includes("Test Model")).toBe(!allowAllModels);
  });
});

describe("Gateway usage", () => {
  test("offers tokens and cost without presenting missing costs as free", () => {
    expect(usage).toContain('onClick={() => setMetric("cost")}');
    expect(usage).toContain("Gateway providers only. OpenWork Models not included.");
  });
});

describe("Move to gateway", () => {
  test("BYOK detail exposes the action for catalog providers", () => {
    expect(llmDetail).toContain('data-testid="llm-provider-move-to-gateway"');
    expect(llmDetail).toContain("getGatewayProviderRoute(orgSlug, gatewayProvider.id)");
  });
});
