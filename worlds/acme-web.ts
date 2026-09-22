import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { allocateFreePort } from "../evals/packages/cdp/src/index.ts";
import { launchHeadlessWeb } from "../packages/world/src/headless-web.ts";
import type { HeadlessWebHandle } from "../packages/world/src/headless-web.ts";
import { hold } from "../packages/world/src/hold.ts";
import { output, secret } from "../packages/world/src/outputs.ts";
import type { WorldOutput } from "../packages/world/src/outputs.ts";
import type { Den } from "../evals/packages/env/src/den.ts";
import { resolvePlace } from "../evals/packages/env/src/place.ts";
import { receiptName, resolveStage } from "../packages/world/src/stage.ts";
import { ACME_REPLY, bootAcmeGateway, probeAcmeGatewayDirect, seedAcmeGateway } from "./lib/acme-gateway.ts";
import type { AcmeGatewayStack } from "./lib/acme-gateway.ts";
import { probeAcmeGateway } from "./lib/acme-gateway-probe.ts";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const ACME_WEB_NAME = "acme-web";

export interface AcmeWebWorld {
  den: Den;
  web: HeadlessWebHandle;
  gatewayUrl: string;
  model: Awaited<ReturnType<typeof seedAcmeGateway>>;
  upstream: { key: string; requests(): Promise<{ model: string; authenticated: boolean }[]> };
}

/** Seeded Acme Den + real AI Gateway + isolated web runtime; only the upstream model is fake. Local only: the web runtime is a sibling process. */
export async function bootAcmeWeb(stack: AsyncDisposableStack): Promise<AcmeWebWorld> {
  const place = resolvePlace();
  if (place.kind !== "local") {
    throw new Error("bootAcmeWeb runs co-located (--place local). On Daytona, `pnpm world up acme-web --place daytona` boots Den + AI Gateway without the OpenWork web runtime.");
  }
  const webPort = await allocateFreePort();
  const gateway = await bootAcmeGateway(stack, place, { trustedOrigins: [`http://127.0.0.1:${webPort}`], denEnv: { DEN_DASHBOARDS_ENABLED: "true" } });
  const { den, model, upstream } = gateway;
  const name = `${receiptName(ACME_WEB_NAME, resolveStage(process.env))}-${randomUUID().slice(0, 8)}`;
  const workspace = join(REPO_ROOT, "tmp", "worlds", name, "workspace");
  await mkdir(workspace, { recursive: true });
  const web = await launchHeadlessWeb({
    repoRoot: REPO_ROOT,
    name,
    workspace,
    state: "isolated",
    env: {
      ...process.env,
      OPENWORK_WEB_PORT: String(webPort),
      OPENWORK_DEV_HEADLESS_WEB_DEN_PROXY: "1",
      OPENWORK_DEV_DEN_PROXY_TARGET: den.ref.webUrl,
      VITE_DEN_BASE_URL: den.ref.webUrl,
      VITE_DEN_API_BASE_URL: den.ref.apiUrl,
      VITE_DISABLE_OPENWORK_MODELS: "0",
    },
  });
  stack.adopt(web, (owned) => owned.stop());
  const synced = await fetch(`${web.manifest.openworkUrl}/den-session`, {
    method: "PUT", headers: { "x-openwork-host-token": web.manifest.hostToken, "content-type": "application/json" },
    body: JSON.stringify({ baseUrl: den.ref.apiUrl, token: den.admin.token, orgId: model.orgId }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!synced.ok) throw new Error(`Acme runtime sign-in failed: HTTP ${synced.status}`);
  return { den, web, model, upstream, gatewayUrl: gateway.gatewayUrl };
}

function gatewayOutputs({ den, model, gatewayUrl }: AcmeGatewayStack): Record<string, WorldOutput> {
  return {
    denWeb: output(den.ref.webUrl, { group: "URLs" }),
    denApi: output(den.ref.apiUrl, { group: "URLs" }),
    aiGateway: output(`${den.ref.webUrl}/dashboard/gateway-providers`, { group: "URLs", note: "Den admin screen for providers, keys and who can use them" }),
    gatewayUrl: output(gatewayUrl, { group: "URLs" }),
    model: output(model.modelName, { group: "AI Gateway" }),
    providerId: output(model.providerId, { group: "AI Gateway" }),
    modelId: output(model.modelId, { group: "AI Gateway" }),
    reply: output(ACME_REPLY, { group: "AI Gateway", note: "Deterministic upstream; no paid inference keys required" }),
    alexEmail: output(den.admin.email, { group: "Accounts", note: "org owner (Acme)" }),
    alexPassword: secret(den.admin.password, { group: "Accounts" }),
  };
}

export async function main(): Promise<void> {
  await using stack = new AsyncDisposableStack();
  const place = resolvePlace();
  if (place.kind === "daytona") {
    const gateway = await bootAcmeGateway(stack, place, { denEnv: { DEN_DASHBOARDS_ENABLED: "true" } });
    const probe = await probeAcmeGatewayDirect(gateway.den.admin, gateway);
    await hold({
      name: ACME_WEB_NAME,
      outputs: {
        ...gatewayOutputs(gateway),
        verified: output(`Message through AI Gateway (${probe.upstreamRequests} upstream call)`, { group: "AI Gateway" }),
        webRuntime: output("not started", { group: "Runtime", note: "Daytona placement boots Den + AI Gateway only; use app-web for the OpenWork web runtime" }),
        ...(gateway.den.placement?.kind === "daytona" ? { denSandbox: output(gateway.den.placement.sandboxId, { group: "World" }) } : {}),
      },
    });
    return;
  }
  const world = await bootAcmeWeb(stack);
  const { den, web, model, gatewayUrl, upstream } = world;
  await probeAcmeGateway(world);
  await hold({
    name: ACME_WEB_NAME,
    outputs: {
      webUrl: output(web.manifest.webUrl, { group: "URLs" }),
      openworkUrl: output(web.manifest.openworkUrl, { group: "URLs" }),
      ...gatewayOutputs({ den, model, gatewayUrl, upstream: { ...upstream, baseUrl: "" } }),
      verified: output("OpenCode chat through AI Gateway", { group: "AI Gateway" }),
      dashboards: output("enabled", { group: "Org", note: "DEN_DASHBOARDS_ENABLED=true" }),
    },
  });
}

if (import.meta.main) await main();
