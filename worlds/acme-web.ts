import { fileURLToPath } from "node:url";
import { launchHeadlessWeb } from "../packages/world/src/headless-web.ts";
import type { HeadlessWebHandle } from "../packages/world/src/headless-web.ts";
import { hold } from "../packages/world/src/hold.ts";
import { output, secret } from "../packages/world/src/outputs.ts";
import { server } from "../evals/packages/env/src/den.ts";
import type { Den } from "../evals/packages/env/src/den.ts";
import { resolvePlace } from "../evals/packages/env/src/place.ts";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const ACME_WEB_NAME = "acme-web";

export interface AcmeWebWorld {
  den: Den;
  web: HeadlessWebHandle;
}

/** The seeded Acme demo with the web app signed in through its local Den. */
export async function bootAcmeWeb(stack: AsyncDisposableStack): Promise<AcmeWebWorld> {
  const place = resolvePlace();
  if (place.kind !== "local") {
    throw new Error("acme-web supports only --place local; use app-web for Daytona web previews.");
  }
  const den = stack.use(await server({
    place,
    ports: { api: 8790, web: 3005 },
    env: { DEN_DASHBOARDS_ENABLED: "true" },
    seedProfile: "demo-org",
    web: true,
  }));
  const web = await launchHeadlessWeb({
    repoRoot: REPO_ROOT,
    name: ACME_WEB_NAME,
    state: "isolated",
    env: {
      ...process.env,
      OPENWORK_DEV_HEADLESS_WEB_DEN_PROXY: "1",
      OPENWORK_DEV_DEN_PROXY_TARGET: den.ref.webUrl,
    },
  });
  return { den, web: stack.adopt(web, (owned) => owned.stop()) };
}

export async function main(): Promise<void> {
  await using stack = new AsyncDisposableStack();
  const { den, web } = await bootAcmeWeb(stack);
  await hold({
    name: ACME_WEB_NAME,
    outputs: {
      webUrl: output(web.manifest.webUrl, { group: "URLs" }),
      openworkUrl: output(web.manifest.openworkUrl, { group: "URLs" }),
      denWeb: output(den.ref.webUrl, { group: "URLs" }),
      denApi: output(den.ref.apiUrl, { group: "URLs" }),
      alexEmail: output(den.admin.email, { group: "Accounts", note: "org owner (Acme)" }),
      alexPassword: secret(den.admin.password, { group: "Accounts" }),
      dashboards: output("enabled", { group: "Org", note: "DEN_DASHBOARDS_ENABLED=true" }),
    },
  });
}

if (import.meta.main) await main();
