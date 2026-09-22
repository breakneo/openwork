import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { InferenceCredentialStatusBadge } from "../app/(den)/dashboard/_components/inference-providers-screen";
import { GATEWAY_EXPLAINER } from "../app/(den)/dashboard/_components/inference-provider-detail-screen";
import { GATEWAY_PAGE_DESCRIPTION, describeGatewayAccess } from "../app/(den)/dashboard/_components/inference-provider-request";
import { GatewayModelUniverse } from "../app/(den)/dashboard/_components/inference-provider-model-universe";
import {
  getCustomLlmProvidersRoute,
  getEditGatewayProviderRoute,
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
const matrix = read("dashboard", "_components", "inference-provider-matrix.tsx");
const universe = read("dashboard", "_components", "inference-provider-model-universe.tsx");
const usage = read("dashboard", "_components", "gateway-usage-section.tsx");
const llmDetail = read("dashboard", "_components", "llm-provider-detail-screen.tsx");
const llmEditor = read("dashboard", "_components", "llm-provider-editor-screen.tsx");

describe("Gateway providers routes", () => {
  test("live next to custom-llm-providers under the org dashboard", () => {
    const base = getGatewayProvidersRoute("acme");
    expect(base).toBe(getCustomLlmProvidersRoute("acme").replace("custom-llm-providers", "gateway-providers"));
    expect(getNewGatewayProviderRoute("acme")).toBe(`${base}/new`);
    expect(getNewGatewayProviderRoute("acme", "anthropic")).toBe(`${base}/new?provider=anthropic`);
    expect(getGatewayProviderRoute("acme", "infp_1")).toBe(`${base}/infp_1`);
    expect(getEditGatewayProviderRoute("acme", "infp_1")).toBe(`${base}/infp_1/edit`);
  });

  test("route pages exist for list, catalog, form and edit", () => {
    const pages = join(appRoot, "dashboard", "(admin)", "gateway-providers");
    expect(readFileSync(join(pages, "page.tsx"), "utf8")).toContain("InferenceProvidersScreen");
    expect(readFileSync(join(pages, "new", "page.tsx"), "utf8")).toContain("InferenceProviderPickerScreen");
    expect(readFileSync(join(pages, "new", "page.tsx"), "utf8")).toContain("InferenceProviderEditorScreen");
    expect(readFileSync(join(pages, "[inferenceProviderId]", "page.tsx"), "utf8")).toContain("InferenceProviderEditorScreen");
    expect(readFileSync(join(pages, "[inferenceProviderId]", "edit", "page.tsx"), "utf8")).toContain(
      "InferenceProviderEditorScreen",
    );
  });
});

describe("Gateway providers sidebar", () => {
  test("appears first under the admin-gated Models group before legacy BYOK", () => {
    const byok = navigation.indexOf('label: "Bring Your Own Keys (Legacy)"');
    const gateway = navigation.indexOf('label: "AI Gateway", badge: "New"');
    expect(gateway).toBeGreaterThan(-1);
    expect(byok).toBeGreaterThan(gateway);
    expect(navigation).toMatch(/const modelsGroup[\s\S]*access\.isAdmin && orgSlug[\s\S]*label: "AI Gateway"/);
    expect(shell).toContain('return "AI Gateway";');
  });
});

describe("Gateway providers list", () => {
  test("renders credential status labels with the shared badge", () => {
    const ready = renderToStaticMarkup(
      createElement(InferenceCredentialStatusBadge, { provider: { credentialMode: "org", credentialStatus: "ready" } }),
    );
    const missing = renderToStaticMarkup(
      createElement(InferenceCredentialStatusBadge, {
        provider: { credentialMode: "org", credentialStatus: "org_credential_missing" },
      }),
    );
    const member = renderToStaticMarkup(
      createElement(InferenceCredentialStatusBadge, {
        provider: { credentialMode: "member", credentialStatus: "member_auth_required" },
      }),
    );
    expect(ready).toContain("Ready");
    expect(missing).toContain("Org credential missing");
    expect(member).toContain("Members authorize individually");
  });

  test("names who can use models and opens a provider as a row", () => {
    expect(list).toContain("AI Gateway");
    expect(list).toContain("GATEWAY_PAGE_DESCRIPTION");
    expect(list).toContain("<GatewayWhoCanUseModels");
    expect(list).toContain("<DenList");
    expect(list).toContain("describeGatewayAccess");
    expect(list).toContain('data-testid="gateway-provider-create"');
    expect(list).toContain("gateway-provider-open");
    expect(list).toContain("<GatewayUsageSection");
    expect(list).not.toContain("<DenCard");
    expect(read("dashboard", "_components", "inference-provider-data.tsx")).toContain("scope=manageable");
    expect(GATEWAY_PAGE_DESCRIPTION).toContain("provider keys stay on the server");
  });

  test("policy sheet reuses desktop model-access saves", () => {
    expect(policy).toContain("Only models you provide");
    expect(policy).toContain('testId="gateway-model-access-managed"');
    expect(policy).toContain("updateDesktopPolicy");
    expect(policy).toContain("createDesktopPolicy");
  });
});

describe("Gateway provider form", () => {
  test("catalog picker then one form for key, who, and models", () => {
    expect(picker).toContain("Where do your models come from?");
    expect(picker).toContain("getNewGatewayProviderRoute(orgSlug, item.id)");
    expect(editor).toContain("<ProviderAccessPicker");
    expect(editor).toContain("<GatewayModelUniverse");
    expect(editor).toContain("buildInferenceProviderRequestBody");
    expect(editor).toContain('data-testid="gateway-provider-api-key"');
    expect(editor).not.toContain("<GatewayAccessMatrix");
    expect(universe).toContain("<ProviderModelPicker");
    expect(llmEditor).toContain("ProviderAccessPicker");
    expect(llmEditor).toContain("buildCatalogProviderOptions");
  });

  test("create posts legacy credential and audience; edit writes the matrix", () => {
    expect(editor).toContain("buildInferenceProviderRequestBody");
    expect(editor).toContain("saveGatewayResource");
    expect(editor).toContain("deleteGatewayResource");
    expect(editor).toContain("Add a key before sharing these models.");
    expect(editor).toContain("<AlertDialog.Title");
    expect(editor).toContain("initialFocus={cancelDeleteRef}");
    expect(editor).toContain("open={confirmDelete && !reauthDialogOpen}");
    expect(editor).not.toContain("aws_keys");
  });

  test("member sign-in is gated to Google Vertex and collects the org OAuth client", () => {
    expect(editor).toContain("supportsMemberCredentialMode(providerId)");
    expect(editor).toContain("People sign in");
    expect(editor).toContain('data-testid="gateway-oauth-client-id"');
    expect(editor).toContain('data-testid="gateway-oauth-client-secret"');
    expect(editor).toContain("Add this URL to the allowed redirect URIs in your OAuth client configuration.");
    expect(editor).toContain("Saved — enter a replacement to change it");
    expect(matrix).toContain("supportsMemberCredentialMode(provider.providerId)");
  });
});

describe("Gateway access copy", () => {
  test("list row names everyone, a team, or nobody", () => {
    const names = {
      organization: "Acme",
      teamName: (id: string) => (id === "team_design" ? "Design" : undefined),
      memberName: (id: string) => (id === "mem_1" ? "Ada" : undefined),
    };
    expect(describeGatewayAccess({ accessGrants: [], access: null }, names)).toBe("No one has access yet");
    expect(
      describeGatewayAccess(
        { accessGrants: [{ id: "g1", modelGroupId: "mg", credentialSetId: "cs", audience: { type: "organization" } }], access: null },
        names,
      ),
    ).toBe("Everyone in Acme");
    expect(
      describeGatewayAccess(
        { accessGrants: [{ id: "g1", modelGroupId: "mg", credentialSetId: "cs", audience: { type: "team", teamId: "team_design" } }], access: null },
        names,
      ),
    ).toBe("Design");
  });

  test("keeps the matrix explainer for the unused detail helper", () => {
    expect(GATEWAY_EXPLAINER).toBe(
      "Members call this provider with their own AI Gateway key. Access rules select a model group and credential set; upstream credentials never reach their devices.",
    );
  });
});

describe("Gateway model and access defaults", () => {
  test("allow-all is an empty policy, while restricted empty selections are rejected", () => {
    expect(editor).toContain("modelIds: allowAllModels ? [] : modelIds");
    expect(editor).toContain("if (!allowAllModels && !modelIds.length) return setSaveError");
  });

  test.each([true, false])("renders the model universe with allow-all %s", (allowAllModels) => {
    const html = renderToStaticMarkup(createElement(GatewayModelUniverse, {
      models: [{ id: "model-1", name: "Test Model" }], allowAllModels, modelIds: ["model-1"], onChange: () => {},
    }));
    expect(html).toContain("Model universe");
    expect(html).toContain('aria-label="Allow all models"');
    expect(html).toContain(`aria-checked="${allowAllModels}"`);
    if (allowAllModels) expect(html).not.toContain("Test Model");
    else expect(html).toContain("Test Model");
  });
});

describe("Gateway usage", () => {
  test("offers tokens and cost without presenting missing costs as free", () => {
    expect(usage).toContain('onClick={() => setMetric("tokens")}');
    expect(usage).toContain('onClick={() => setMetric("cost")}');
    expect(usage).toContain("Gateway providers only. OpenWork Models not included.");
  });
});

describe("Move to gateway", () => {
  test("BYOK detail exposes the action for catalog providers with a confirm dialog", () => {
    expect(llmDetail).toContain('provider.canManage && provider.source === "models_dev"');
    expect(llmDetail).toContain('data-testid="llm-provider-move-to-gateway"');
    expect(llmDetail).toContain("migrateLlmProviderToGateway(provider.id)");
    expect(llmDetail).toContain("getGatewayProviderRoute(orgSlug, gatewayProvider.id)");
  });
});
