import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describeGatewayAccess } from "../app/(den)/dashboard/_components/inference-provider-request";
import { orderCatalog, providerTagline } from "../app/(den)/dashboard/_components/inference-provider-picker-screen";
import {
  getCustomLlmProvidersRoute,
  getGatewayProviderRoute,
  getGatewayProvidersRoute,
  getGatewayUsageRoute,
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
    expect(getGatewayUsageRoute("acme")).toBe(`${base}/usage`);
    expect(getGatewayUsageRoute("acme", "spending")).toBe(`${base}/usage#spending`);
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
  test("leads with a flat header, one policy row, provider rows, and two link rows", () => {
    expect(list).not.toContain("DashboardHeaderActions");
    expect(list).not.toContain("DashboardPageTemplate");
    expect(list).toMatch(/Providers[\s\S]*gateway-provider-create/);
    expect(list).toContain("<GatewayWhoCanUseModels");
    expect(list).toContain("describeGatewayAccess");
    expect(list).toContain('data-testid="gateway-provider-create"');
    expect(list).toContain('data-testid="gateway-provider-open"');
    expect(list).toContain('data-testid="gateway-usage-link"');
    expect(list).toContain('data-testid="gateway-spending-link"');
    expect(list).toContain("Move them to AI Gateway");
    expect(list).not.toContain("<GatewayUsageSection");
    expect(read("dashboard", "_components", "gateway-usage-screen.tsx")).toContain("<GatewayUsageLimitsSection");
  });

  test("the policy sheet and the BYOK page save the same desktop policy", () => {
    expect(policy).toContain('testId="gateway-model-access-managed"');
    expect(policy).toContain("Applies to every member, on Desktop and the web.");
    expect(policy).toContain("Free starter model (Auto)");
    expect(policy).toContain("Takes effect next time members open OpenWork");
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
    expect(picker).toContain("Start here");
    expect(picker).toContain("Another provider");
    expect(picker).toContain("getNewGatewayProviderRoute(orgSlug, item.id)");
    expect(orderCatalog([{ id: "zeta", name: "Zeta" }, { id: "anthropic", name: "Anthropic" }, { id: "openrouter", name: "OpenRouter" }]).map((entry) => entry.id)).toEqual(["openrouter", "anthropic", "zeta"]);
    expect(providerTagline({ id: "anthropic", modelCount: 9 })).toBe("Claude models");
    expect(providerTagline({ id: "unknown", modelCount: 1 })).toBe("1 model");
    for (const heading of ["Key", "Who can use it", "Models"]) expect(editor).toContain(`>${heading}</h2>`);
    expect(editor).toContain("Everyone in the organization");
    expect(editor).toContain('data-testid="gateway-access-add-person"');
    expect(editor).toContain('data-testid="gateway-access-add-team"');
    expect(editor).toContain('testId="gateway-models-pick"');
    expect(editor).toContain('data-testid="gateway-models-select-all"');
    expect(editor).toContain('data-testid="gateway-models-clear"');
    expect(editor).toContain("if (!provider) setModelIds([]);");
    expect(editor).toContain('data-testid="gateway-provider-api-key"');
    expect(editor).toContain("Replace key");
    expect(editor).not.toContain("<ProviderAccessPicker");
    expect(editor).not.toContain("<GatewayModelUniverse");
  });

  test("create posts one body; edit rewrites group, set, and grants through the matrix routes", () => {
    expect(editor).toContain("buildInferenceProviderRequestBody(formInput)");
    expect(editor).toContain('resource: "model-groups"');
    expect(editor).toContain('resource: "credential-sets"');
    expect(editor).toContain('resource: "access-grants"');
    expect(editor).toContain("deleteGatewayResource");
    expect(editor).toContain("Paste a key before sharing these models.");
    expect(editor).toContain("modelIds: allowAllModels ? [] : modelIds");
    expect(editor).toContain("open={confirmDelete && !reauthDialogOpen}");
  });

  test("member sign-in is gated to Google Vertex and collects the org OAuth client", () => {
    expect(editor).toContain("supportsMemberCredentialMode(providerId)");
    expect(editor).toContain('data-testid="gateway-oauth-client-id"');
    expect(editor).toContain('data-testid="gateway-oauth-client-secret"');
    expect(editor).toContain("Saved — enter a replacement to change it");
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
