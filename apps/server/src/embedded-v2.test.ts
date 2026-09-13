import { expect, spyOn, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { NativeV2Catalog } from "@openwork/headless-threads/v2";

// Import server modules only inside a process whose entire profile is owned by
// this test. Path providers may cache HOME/XDG values at module initialization.
if (!process.env.OPENWORK_EMBEDDED_V2_TEST_ROOT) {
  const nativeBinary = process.env.OPENWORK_TEST_NATIVE_V2_BIN;
  test("embedded v2 isolated process", async () => {
    const root = await mkdtemp(join(tmpdir(), "openwork-embedded-v2-"));
    try {
      const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
        !/^(OPENWORK_|OPENCODE_|COWORKER_|SENTRY_|XDG_|HOME$)/.test(key)));
      const child = Bun.spawn([process.execPath, "--conditions=development", "test", fileURLToPath(import.meta.url),
        fileURLToPath(new URL("./engine-v2-preview.test.ts", import.meta.url)),
        ...(nativeBinary ? [fileURLToPath(new URL("./embedded-v2-native.test.ts", import.meta.url))] : [])], {
        env: { ...env, HOME: root, XDG_CONFIG_HOME: join(root, "config"), XDG_DATA_HOME: join(root, "data"),
          XDG_CACHE_HOME: join(root, "cache"), XDG_STATE_HOME: join(root, "state"), OPENWORK_DEV_MODE: "1",
          OPENWORK_EMBEDDED_V2_TEST_ROOT: root, ...(nativeBinary ? { OPENWORK_TEST_NATIVE_V2_BIN: nativeBinary } : {}) },
        stdout: "pipe", stderr: "pipe",
      });
      const timeout = setTimeout(() => child.kill(), nativeBinary ? 110_000 : 40_000);
      try {
        const [code, stdout, stderr] = await Promise.all([
          child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
        ]);
        if (code !== 0) throw new Error(`${stdout}\n${stderr}`);
        console.info(stderr.trim());
        expect(code).toBe(0);
      } finally { clearTimeout(timeout); child.kill(); await child.exited; }
    } finally { await rm(root, { recursive: true, force: true }); }
  }, nativeBinary ? 115_000 : 45_000);
} else {
  const { startEmbeddedServer } = await import("./embedded.js");
  const managedModule = await import("./managed-opencode-v2.js");
  const v1Module = await import("./managed-opencode.js");
  const { writeRuntimeOpencodeConfig, writeGlobalRuntimeOpencodeConfig } = await import("./runtime-opencode-config-store.js");
  const { engineV2ByConfig } = await import("./engine-v2-preview.js");
  const { default: constants } = await import("../../../constants.json", { with: { type: "json" } });
  const { default: nativeRuntime } = await import("../../coworker/native-runtime.json", { with: { type: "json" } });
  const { createNativeV2Client, nativeCatalogProviders } = await import("@openwork/headless-threads/v2");

  async function fixture(version?: string) {
    const root = await mkdtemp(join(process.env.OPENWORK_EMBEDDED_V2_TEST_ROOT!, "case-"));
    const bin = join(root, "opencode2");
    const log = join(root, "requests.jsonl");
    const workspace = join(root, "workspace");
    await mkdir(workspace);
    await writeFile(bin, `#!${process.execPath}
import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
const log = (value) => appendFileSync(process.env.FIXTURE_LOG, JSON.stringify(value) + "\\n");
const config = () => JSON.parse(readFileSync(join(process.env.OPENCODE_CONFIG_DIR, "opencode.json"), "utf8"));
log({ spawn: true, args: process.argv.slice(2), serverUrl: process.env.OPENWORK_SERVER_URL,
  bridge: process.env.NATIVE_BRIDGE, secret: process.env.OPENWORK_ENCRYPTION_KEY ?? null });
const mcps = new Map();
const sessions = new Map();
const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
  const url = new URL(request.url);
  log({ method: request.method, path: url.pathname });
  if (url.pathname === "/api/health") return Response.json({ healthy: true, pid: process.pid, version: process.env.FIXTURE_VERSION });
  if (url.pathname === "/api/plugin/await-activation") return new Response(null, { status: 204 });
  if (url.pathname === "/api/plugin") return Response.json({ data: [] });
  if (url.pathname === "/api/provider" || url.pathname.startsWith("/api/provider/")) {
    const providers = Object.entries(config().providers).map(([id, value]) => ({ id, activation: "enabled", ...value }));
    return Response.json({ data: url.pathname === "/api/provider" ? providers : providers.find((value) => value.id === decodeURIComponent(url.pathname.slice("/api/provider/".length))) });
  }
  if (url.pathname === "/api/model") return Response.json({ data: Object.entries(config().providers).flatMap(([providerID, value]) => Object.entries(value.models ?? {}).map(([id, model]) => ({
    id, modelID: id, providerID, name: id, capabilities: { tools: true, input: ["text"], output: ["text"] },
    variants: [], time: { released: 0 }, cost: [{ input: 0, output: 0 }], status: "active", enabled: true,
    limit: { context: 128000, output: 8192 }, ...model,
  }))) });
  if (url.pathname === "/api/integration") return Response.json({ data: [{ id: "fixture-integration", connections: [{ type: "env", name: "FIXTURE_CONNECTED" }] }] });
  if (url.pathname === "/api/mcp") return Response.json({ data: [...mcps.keys()].map((name) => ({ name, status: { status: "connected" } })) });
  if (url.pathname.startsWith("/api/mcp/")) {
    const name = decodeURIComponent(url.pathname.slice("/api/mcp/".length));
    if (request.method === "PUT") mcps.set(name, await request.json());
    else if (request.method === "DELETE") mcps.delete(name);
    return new Response(null, { status: 204 });
  }
  if (url.pathname === "/api/skill") return Response.json(process.env.FIXTURE_SKILLS ? JSON.parse(readFileSync(process.env.FIXTURE_SKILLS, "utf8")) : { data: [] });
  if (url.pathname === "/api/session" && request.method === "POST") {
    const data = await request.json(); sessions.set(data.id, data); return Response.json({ data });
  }
  const session = url.pathname.match(/^\\/api\\/session\\/([^/]+)$/);
  if (session) return Response.json({ data: sessions.get(session[1]) });
  if (url.pathname.includes("/instructions/entries/") && request.method === "PUT") { log({ instruction: await request.json() }); return new Response(null, { status: 204 }); }
  if (url.pathname.endsWith("/prompt") && request.method === "POST") { const data = await request.json(); log({ prompt: data }); return Response.json({ data }); }
  return Response.json({ error: "unexpected route" }, { status: 404 });
} });
console.log("server listening on http://127.0.0.1:" + server.port);
process.on("SIGTERM", () => { log({ stopped: true }); server.stop(true); process.exit(0); });
`);
    await chmod(bin, 0o755);
    return { root, log, options: {
      engine: "v2" as const, opencodeV2Bin: bin, manageOpencode: true,
      configPath: join(root, "server.json"), workspaces: [workspace], host: "127.0.0.1", port: 0,
      token: "fixture-client", hostToken: "fixture-host", logRequests: false,
      opencodeV2: { version, rootDir: join(root, "engine"), bootTimeoutMs: 2_000,
        config: { agents: { coworker: { sources: ["tools", "skills"] } }, plugins: ["file:///fixture/native-plugin.mjs"] },
        env: { FIXTURE_LOG: log, FIXTURE_VERSION: version ?? constants.opencodeV2Version,
          OPENCODE_MODELS_URL: "http://127.0.0.1:1/unused", NATIVE_BRIDGE: "owned-bridge" } },
    } };
  }

  async function waitFor(check: () => Promise<boolean>) {
    const deadline = Date.now() + 5_000;
    while (!await check()) {
      if (Date.now() > deadline) throw new Error("Fixture observation timed out");
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  test("explicit host pin controls native health and metadata without changing Desktop's default", async () => {
    expect(constants.opencodeV2Version).toBe("0.0.0-beta-19086");
    expect(nativeRuntime.opencodeV2Version).toBe("0.0.0-beta-19271");
    for (const version of [undefined, nativeRuntime.opencodeV2Version]) {
      const item = await fixture(version);
      const handle = await startEmbeddedServer(item.options);
      try {
        expect(handle.config.opencodeV2?.version).toBe(version);
        const headers = { authorization: `Bearer ${handle.config.token}` };
        for (const route of ["/health", "/capabilities"]) {
          const response = await fetch(handle.url + route, { headers });
          expect(response.status).toBe(200);
          expect((await response.json()).opencodeVersion).toBe(version ?? constants.opencodeV2Version);
        }
        const id = handle.config.workspaces[0]!.id;
        const response = await fetch(`${handle.url}/workspace/${id}/mcp/openwork-cloud/health?probe=false`, { headers });
        expect(response.status).toBe(200);
        expect((await response.json()).compatibility.opencode.expectedVersion).toBe(version ?? constants.opencodeV2Version);
      } finally { await handle.stop(); }
    }
    const item = await fixture(nativeRuntime.opencodeV2Version);
    await expect(startEmbeddedServer({ ...item.options, opencodeV2: { ...item.options.opencodeV2,
      env: { ...item.options.opencodeV2.env, FIXTURE_VERSION: constants.opencodeV2Version } } })).rejects.toThrow("version mismatch");
    await expect(startEmbeddedServer({ ...item.options, opencodeV2: { ...item.options.opencodeV2,
      version: "latest" } })).rejects.toThrow("No verified OpenCode v2 artifacts");
  }, 15_000);

  test("workspace proxy preserves native catalog eligibility and exposes only public provider metadata", async () => {
    const item = await fixture();
    const packageName = "@opencode-ai/ai/providers/openai-compatible";
    const provider = {
      name: "Fixture", activation: "enabled", package: packageName,
      settings: { baseURL: "http://fixture-user:fixture-password@127.0.0.1:12345/private-path?key=fixture-query#fixture-fragment",
        apiKey: "fixture-api-key", headers: { Authorization: "Bearer fixture-settings-header" }, nested: { secret: "fixture-nested-secret" } },
      headers: { Authorization: "Bearer fixture-provider-header" }, credentialScopes: ["fixture-private-scope"],
      models: { text: { name: "Fixture text", settings: { apiKey: "fixture-model-key" },
        variants: [{ id: "low", settings: { apiKey: "fixture-variant-key" } }] } },
    };
    const handle = await startEmbeddedServer({ ...item.options, opencodeV2: { ...item.options.opencodeV2,
      config: { ...item.options.opencodeV2.config, providers: {
        fixture: provider,
        integrated: { ...provider, activation: "auto", integrationID: "fixture-integration", settings: { baseURL: "https://fixture-user:fixture-password@example.test/private?key=fixture-query#fixture-fragment" } },
        disabled: { ...provider, activation: "disabled", integrationID: "fixture-integration", settings: { baseURL: "file:///fixture-private-file" } },
        disconnected: { ...provider, activation: "auto", settings: { baseURL: "not a URL fixture-private-value" } },
      } } } });
    try {
      const id = handle.config.workspaces[0]!.id;
      const mount = `${handle.url}/workspace/${id}/opencode2/api`;
      const headers = { authorization: `Bearer ${handle.config.token}` };
      const response = await fetch(mount + "/provider", { headers });
      expect(response.status).toBe(200);
      const publicProviders: NativeV2Catalog["providers"] = [
        { id: "fixture", name: "Fixture", activation: "enabled", package: packageName, settings: { baseURL: "http://127.0.0.1:12345" } },
        { id: "integrated", name: "Fixture", activation: "auto", package: packageName, integrationID: "fixture-integration", settings: { baseURL: "https://example.test" } },
        { id: "disabled", name: "Fixture", activation: "disabled", package: packageName, integrationID: "fixture-integration" },
        { id: "disconnected", name: "Fixture", activation: "auto", package: packageName },
      ];
      // Exact wire assertions catch leakage even if the client's Zod parser strips it.
      expect(await response.json()).toEqual({ data: publicProviders });
      expect(await (await fetch(mount + "/provider/fixture", { headers })).json()).toEqual({ data: publicProviders[0] });
      const client = createNativeV2Client({ baseUrl: handle.url, workspaceId: id, token: handle.config.token });
      const catalog = await client.readCatalog();
      expect(catalog.providers).toEqual(publicProviders);
      expect(catalog.connectedProviderIds).toEqual(["fixture", "integrated"]);
      expect(catalog.models).toHaveLength(4);
      const projected = nativeCatalogProviders(catalog);
      expect(projected.map((entry) => entry.id)).toEqual(["fixture", "integrated"]);
      expect(projected[0]?.options).toEqual({ baseURL: "http://127.0.0.1:12345" });
      expect(projected[0]?.models.text).toMatchObject({ name: "Fixture text", api: { npm: packageName, id: "text" }, variants: { low: {} } });
      const models = await (await fetch(mount + "/model", { headers })).text();
      expect(models).not.toContain("fixture-model-key");
      expect(models).not.toContain("fixture-variant-key");
      // An independently configured same-ID provider is restored when its
      // managed override disappears; mandatory readiness must accept it.
      const providerPatch = (value: unknown) => fetch(handle.url + "/runtime-config/providers", { method: "PATCH",
        headers: { ...headers, "content-type": "application/json", "x-openwork-host-token": item.options.hostToken },
        body: JSON.stringify({ provider: { fixture: value } }) });
      expect((await providerPatch({ npm: "@ai-sdk/openai", options: { apiKey: "managed-override" }, models: {} })).status).toBe(200);
      expect((await providerPatch(null)).status).toBe(200);
      expect((await fetch(mount + "/provider", { headers })).status).toBe(200);
      expect(JSON.parse(await readFile(join(item.options.opencodeV2.rootDir, "config/opencode.json"), "utf8")).providers.fixture.settings.apiKey).toBe("fixture-api-key");
    } finally { await handle.stop(); }
  }, 10_000);

  test("Desktop optional preview retains plain skills, Connect guidance, minimal providers and untouched Cloud files", async () => {
    const item = await fixture();
    const marker = join(item.options.opencodeV2.rootDir, "cloud-skills", "marker");
    await mkdir(join(marker, ".."), { recursive: true });
    await writeFile(marker, "preview-owned-marker");
    const skillCatalog = { data: [{ id: "preview-skill", name: "Preview skill", description: "Preview", content: "Preview instructions",
      location: join(item.root, "plugin", "SKILL.md") }], previewField: "preserved" };
    const catalogFile = join(item.root, "skills.json");
    await writeFile(catalogFile, JSON.stringify(skillCatalog));
    let cloudReads = 0;
    const cloud = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() { cloudReads++; return new Response(null, { status: 401 }); } });
    process.env.OPENWORK_ENGINE_V2_PREVIEW = "chat";
    let handle: Awaited<ReturnType<typeof startEmbeddedServer>> | undefined;
    try {
      handle = await startEmbeddedServer({ ...item.options, engine: "v1", manageOpencode: false, opencodeV2: { ...item.options.opencodeV2,
        config: { providers: { preview: { name: "Preview" } }, skills: [join(item.root, "not-preview-managed")] },
        env: { ...item.options.opencodeV2.env, FIXTURE_SKILLS: catalogFile } } });
      const engine = engineV2ByConfig.get(handle.config)!;
      await waitFor(async () => engine.status().running);
      await writeGlobalRuntimeOpencodeConfig(handle.config, (current) => ({ ...current, mcp: { "openwork-cloud": {
        type: "remote", url: `http://127.0.0.1:${cloud.port}/mcp`, headers: { Authorization: "Bearer preview-fixture" },
      } } }));
      const mount = `${handle.url}/workspace/${handle.config.workspaces[0]!.id}/opencode2/api`;
      const headers = { authorization: `Bearer ${handle.config.token}`, "content-type": "application/json" };
      expect(await (await fetch(mount + "/skill", { headers })).json()).toEqual(skillCatalog);
      expect(await (await fetch(mount + "/provider", { headers })).json()).toEqual({ data: [{ id: "preview", name: "Preview" }] });
      const sid = "ses_preview";
      await fetch(mount + "/session", { method: "POST", headers, body: JSON.stringify({ id: sid }) });
      const prompt = { id: "msg_preview", text: "Preview", skills: [{ id: "openwork-cloud-old", text: "Preview contract retained" }] };
      const response = await fetch(mount + `/session/${sid}/prompt`, { method: "POST", headers: { ...headers, "x-openwork-native-skills-scope": "preview-ignored" }, body: JSON.stringify(prompt) });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ data: prompt });
      const previewLog = await readFile(item.log, "utf8");
      expect(previewLog.trim().split("\n").map((line) => JSON.parse(line)).some((entry) => entry.path?.endsWith("/permission"))).toBe(false);
      expect(previewLog).toContain("Organization skills are provided by OpenWork Connect");
      expect(JSON.parse(await readFile(join(item.options.opencodeV2.rootDir, "config/opencode.json"), "utf8"))).not.toHaveProperty("skills");
      expect(cloudReads).toBe(0);
      expect(await readFile(marker, "utf8")).toBe("preview-owned-marker");
      await handle.stop();
      expect(await readFile(marker, "utf8")).toBe("preview-owned-marker");
    } finally {
      delete process.env.OPENWORK_ENGINE_V2_PREVIEW;
      await handle?.stop();
      cloud.stop(true);
    }
  }, 15_000);

  test("v2 is exclusive, ready on return, hot-updated and stopped once", async () => {
    const item = await fixture();
    const v1 = spyOn(v1Module, "createManagedOpencodeServer");
    process.env.OPENWORK_OPENCODE_BASE_URL = "http://127.0.0.1:1/v1-must-not-be-probed";
    process.env.OPENWORK_OPENCODE_BIN = "/missing/v1-must-not-be-spawned";
    process.env.OPENWORK_OPENCODE2_BIN = "/missing/ambient-v2-must-not-win";
    process.env.OPENWORK_ENGINE_V2_PREVIEW = "sidecar";
    process.env.OPENWORK_ENCRYPTION_KEY = "server-only-fixture-key";
    let stop: (() => Promise<void>) | undefined;
    try {
      const handle = await startEmbeddedServer(item.options);
      stop = handle.stop;
      const headers = { authorization: `Bearer ${handle.config.token}`, "content-type": "application/json" };
      const nativePath = join(item.options.opencodeV2.rootDir, "config/opencode.json");
      const native = async () => JSON.parse(await readFile(nativePath, "utf8"));
      expect(v1).not.toHaveBeenCalled();
      expect(handle.managedOpencode).toBeNull();
      expect(handle.managedOpencodeExecution).toBeNull();
      expect(handle.managedOpencodePool()).toBeNull();
      expect(handle.managedOpencodeV2?.isAlive()).toBe(true);
      expect(handle.managedOpencodeV2?.pid).toBeGreaterThan(0);
      expect(handle.policyToken.length).toBeGreaterThan(10);
      expect(handle.config.opencodeBaseUrl).toBeUndefined();
      const id = handle.config.workspaces[0]!.id;
      for (const path of ["/opencode/provider", `/workspace/${id}/opencode/provider`, `/w/${id}/opencode/provider`]) {
        const response = await fetch(handle.url + path, { headers });
        expect(response.status).toBe(409);
        expect(await response.json()).toMatchObject({ code: "engine_v1_disabled" });
      }
      for (const body of [{ enabled: false }, { chatRouting: false }]) {
        expect((await fetch(handle.url + "/experimental/engine-v2-preview", { method: "PUT", headers, body: JSON.stringify(body) })).status).toBe(409);
      }
      const mount = `${handle.url}/workspace/${id}/opencode2`;
      expect((await fetch(mount + "/api/model", { headers })).status).toBe(200);
      const session = await fetch(mount + "/api/session", { method: "POST", headers,
        body: JSON.stringify({ location: { directory: "/wrong" }, title: "Isolated" }) });
      expect(await session.json()).toMatchObject({ data: { location: { directory: item.options.workspaces[0] } } });

      const patch = await fetch(handle.url + "/runtime-config/providers", { method: "PATCH",
        headers: { ...headers, "x-openwork-host-token": item.options.hostToken },
        body: JSON.stringify({ provider: { fixture: { npm: "@ai-sdk/openai", options: { apiKey: "synthetic-key" }, models: { fixture: { name: "Fixture" } } } } }) });
      expect(patch.status).toBe(200);
      expect((await native()).providers.fixture.settings.apiKey).toBe("synthetic-key");
      expect((await native()).agents.coworker.sources).toContain("tools");
      expect((await native()).plugins).toEqual(item.options.opencodeV2.config.plugins);
      const hostHeaders = { ...headers, "x-openwork-host-token": item.options.hostToken };
      const setCredential = (value: string) => fetch(handle.url + "/env", { method: "PUT", headers: hostHeaders,
        body: JSON.stringify({ key: "FIXTURE_API_KEY", value }) });
      expect((await setCredential("first-key")).status).toBe(200);
      expect((await fetch(handle.url + "/runtime-config/providers", { method: "PATCH", headers: hostHeaders,
        body: JSON.stringify({ provider: { fixture: { npm: "@ai-sdk/openai", env: ["FIXTURE_API_KEY"], models: {} } } }) })).status).toBe(200);
      expect((await native()).providers.fixture.settings.apiKey).toBe("first-key");
      expect((await setCredential("rotated-key")).status).toBe(200);
      await waitFor(async () => (await native()).providers.fixture.settings.apiKey === "rotated-key");
      expect((await fetch(handle.url + "/env/FIXTURE_API_KEY", { method: "DELETE", headers: hostHeaders })).status).toBe(200);
      await waitFor(async () => !(await native()).providers.fixture);
      expect((await fetch(mount + "/api/provider", { headers })).status).toBe(200);
      await writeRuntimeOpencodeConfig(handle.config, id, (current) => ({ ...current,
        mcp: { fixture: { type: "local", command: ["unused-fixture-command"] } } }));
      await waitFor(async () => (await readFile(item.log, "utf8")).includes('"method":"PUT","path":"/api/mcp/fixture"'));
      await writeRuntimeOpencodeConfig(handle.config, id, (current) => ({ ...current, mcp: {} }));
      await waitFor(async () => (await readFile(item.log, "utf8")).includes('"method":"DELETE","path":"/api/mcp/fixture"'));

      const firstStop = handle.stop();
      expect(handle.stop()).toBe(firstStop);
      await firstStop;
      expect(handle.managedOpencodeV2?.isAlive()).toBe(false);
      await expect(fetch(handle.url + "/health")).rejects.toThrow();
      const log = await readFile(item.log, "utf8");
      expect(log.match(/"spawn":true/g)).toHaveLength(1);
      expect(log.match(/"stopped":true/g)).toHaveLength(1);
      expect(log).toContain(`"serverUrl":"${handle.url}"`);
      expect(log).toContain('"bridge":"owned-bridge","secret":null');
      expect(log).not.toContain("/instance/dispose");
      expect(log).not.toContain("/auth/");
      expect(v1).not.toHaveBeenCalled();
    } finally {
      v1.mockRestore();
      try { await stop?.(); } finally {
        // Setup and shutdown failures must not contaminate later test cases.
        for (const key of ["OPENWORK_OPENCODE_BASE_URL", "OPENWORK_OPENCODE_BIN", "OPENWORK_OPENCODE2_BIN", "OPENWORK_ENGINE_V2_PREVIEW", "OPENWORK_ENCRYPTION_KEY"]) delete process.env[key];
      }
    }
  }, 15_000);

  test("startup failure has no fallback and closes the listener and child", async () => {
    const item = await fixture();
    const serverModule = await import("./serve-node.js");
    const serve = serverModule.serve;
    let port = 0;
    const serverSpy = spyOn(serverModule, "serve").mockImplementation(async (options) => {
      const server = await serve(options); port = server.port; return server;
    });
    try {
      await expect(startEmbeddedServer({ ...item.options, opencodeV2: { ...item.options.opencodeV2,
        env: { ...item.options.opencodeV2.env, FIXTURE_VERSION: "1.18.18" } } })).rejects.toThrow("version mismatch");
      await expect(fetch(`http://127.0.0.1:${port}/health`)).rejects.toThrow();
      expect(await readFile(item.log, "utf8")).toContain('"stopped":true');
      await expect(startEmbeddedServer({ ...item.options, opencodeV2Bin: join(item.root, "missing") })).rejects.toThrow("Failed to start OpenCode v2");
      await expect(fetch(`http://127.0.0.1:${port}/health`)).rejects.toThrow();
      await expect(startEmbeddedServer({ ...item.options, opencodeBin: "/v1" })).rejects.toThrow("cannot attach");
    } finally { serverSpy.mockRestore(); }
  }, 10_000);

  test("child death changes liveness and mandatory cleanup errors reach the host", async () => {
    const item = await fixture();
    const create = managedModule.createManagedOpencodeV2Server;
    const spy = spyOn(managedModule, "createManagedOpencodeV2Server").mockImplementation(async (options) => {
      const managed = await create(options);
      return { ...managed, close: async () => { await managed.close(); throw new Error("fixture cleanup failure"); } };
    });
    const handle = await startEmbeddedServer(item.options);
    try {
      process.kill(handle.managedOpencodeV2!.pid!, "SIGTERM");
      await waitFor(async () => handle.managedOpencodeV2?.isAlive() === false);
      const status = await fetch(handle.url + "/experimental/engine-v2-preview/status", { headers: { authorization: `Bearer ${handle.config.token}` } });
      expect(await status.json()).toMatchObject({ running: false, enabled: true, chatRouting: true });
      await expect(handle.stop()).rejects.toThrow("fixture cleanup failure");
      await expect(fetch(handle.url + "/health")).rejects.toThrow();
    } finally { spy.mockRestore(); await handle.stop().catch(() => undefined); }
  }, 10_000);
}
