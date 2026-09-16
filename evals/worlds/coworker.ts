/**
 * Arrangement for the Open Coworker journeys.
 *
 * The specs observe the packaged app through `coworker()`. What they need
 * built beforehand — a standard MCP App page compiled the way OpenWork
 * Connect compiles one — is arranged here, so a spec never imports product
 * source and the boundary between witness and product stays visible.
 */
import type { GeneratedArtifactViewBuildInput } from "../../ee/apps/den-api/src/generated-artifact-view-builder.js";
import { addInitScript, browserScript, clickAt, evaluate, evaluateOnSurface, pressKey, typeText, waitForLocated, type Surface, type Target } from "@openwork/cdp";
import { coworker, localHost } from "@openwork/hosts";
import { SkipError, type Place, type Seed } from "@openwork/env";
import { access, cp, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { createServer, type ServerResponse } from "node:http";
import { createConnection } from "node:net";
import type { CoworkerSettings, RuntimeInfo } from "../../apps/coworker/src/lib/bridge.ts";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";

export { pressKey } from "@openwork/cdp";

function isNativeRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nativeRecord(value: unknown): Record<string, unknown> {
  if (!isNativeRecord(value)) throw new Error("Invalid native fixture response.");
  return value;
}

function nativeRows(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) throw new Error("Invalid native fixture list.");
  return value.map(nativeRecord);
}

async function nativeConversationModel() {
  const nonce = randomUUID();
  const calls: Array<{ id: number; model: unknown; stream: unknown; userTexts: string[]; chunks: string[]; released: number; finished: boolean; aborted: boolean; expired: boolean }> = [];
  const streams = new Map<number, ServerResponse>();
  const errors: string[] = [];
  const chunk = (id: number, delta: Record<string, string>, finish: string | null = null) =>
    `data: ${JSON.stringify({ id: `chatcmpl-${nonce}-${id}`, object: "chat.completion.chunk", created: 1, model: "reply", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
  const server = createServer((request, response) => {
    const pathname = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
    if (request.method === "GET" && ["/api.json", "/models/api.json", "/v1/models"].includes(pathname)) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(pathname === "/v1/models" ? { object: "list", data: [{ id: "reply", object: "model" }] } : {}));
      return;
    }
    if (request.method !== "POST" || pathname !== "/v1/chat/completions") {
      response.writeHead(404).end();
      return;
    }
    void (async () => {
      let raw = "";
      for await (const part of request) {
        raw += String(part);
        if (raw.length > 2_097_152) throw new Error("Model request exceeded the fixture bound.");
      }
      const body = nativeRecord(JSON.parse(raw));
      const id = calls.length + 1;
      const call = { id, model: body.model, stream: body.stream,
        userTexts: nativeRows(body.messages).filter((message) => message.role === "user").map((message) => typeof message.content === "string" ? message.content
          : nativeRows(message.content).map((part) => typeof part.text === "string" ? part.text : "").join("\n")),
        chunks: [`Plan ${nonce}-${id}-opening: clarify the goal. `, `Plan ${nonce}-${id}-middle: pick a small first step. `, `Plan ${nonce}-${id}-final: review the outcome.`],
        released: 0, finished: false, aborted: false, expired: false };
      calls.push(call);
      if (body.stream !== true || body.model !== "reply") throw new Error("Expected one streaming request to the configured fixture model.");
      streams.set(id, response);
      response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      response.write(chunk(id, { role: "assistant", content: "" }));
      const heartbeat = setInterval(() => response.write(": held\n\n"), 1_000);
      const deadline = setTimeout(() => { call.expired = true; response.destroy(); }, 120_000);
      response.once("close", () => {
        call.aborted = !call.finished;
        clearInterval(heartbeat);
        clearTimeout(deadline);
        streams.delete(id);
      });
    })().catch((error: unknown) => {
      errors.push(error instanceof Error ? error.message : String(error));
      if (!response.headersSent) response.writeHead(400);
      response.end();
    });
  });
  server.requestTimeout = 15_000;
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Model fixture did not bind loopback.");
  const held = (id: number) => {
    const call = calls.find((entry) => entry.id === id);
    const response = streams.get(id);
    if (!call || !response || response.destroyed || response.writableEnded || call.finished) throw new Error(`Request ${id} is not held.`);
    return { call, response };
  };
  return {
    url: `http://127.0.0.1:${address.port}`,
    requests: () => calls.map((call) => ({ ...call, userTexts: [...call.userTexts], chunks: [...call.chunks] })),
    errors: () => [...errors],
    release(id: number) {
      const { call, response } = held(id);
      const text = call.chunks[call.released];
      if (text === undefined) throw new Error("All content was released; finish the stream explicitly.");
      response.write(chunk(id, { content: text }));
      call.released++;
    },
    finish(id: number) {
      const { call, response } = held(id);
      if (call.released !== call.chunks.length) throw new Error("Cannot finish before releasing all content.");
      call.finished = true;
      response.write(chunk(id, {}, "stop"));
      response.end("data: [DONE]\n\n");
    },
    async [Symbol.asyncDispose]() {
      for (const response of streams.values()) response.destroy();
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    },
  };
}

export async function nativePackagedDiscussion(seed: Seed, { place }: { place: Place }) {
  if (place.kind !== "local") throw new SkipError("native packaged Coworker requires local placement");
  if (process.platform !== "darwin") throw new SkipError("native packaged Coworker requires macOS");
  const binary = process.env.OPENWORK_EVAL_ELECTRON_BINARY?.trim();
  if (!binary) throw new SkipError("set OPENWORK_EVAL_ELECTRON_BINARY");
  if (!isAbsolute(binary)) throw new Error("OPENWORK_EVAL_ELECTRON_BINARY must be an absolute packaged Coworker executable path.");
  if (process.env.OPENWORK_EVAL_ELECTRON_ENTRY?.trim()) throw new Error("Packaged proof refuses a source Electron entry override.");
  const resources = join(dirname(binary), "..", "Resources");
  await access(join(resources, "app.asar"));
  await access(join(resources, "sidecars", "opencode2"), constants.X_OK);
  const pin = nativeRecord(nativeRecord(JSON.parse(await readFile(join(resources, "sidecars", "versions.json"), "utf8"))).opencode2);
  if (pin.version !== "0.0.0-beta-19271" || pin.platform !== process.platform || pin.arch !== process.arch) throw new Error("Packaged native sidecar does not match the Coworker pin and host.");
  const stack = new AsyncDisposableStack();
  try {
    const profileDir = await mkdtemp(join(await realpath(tmpdir()), "coworker-native-discussion-"));
    stack.defer(() => rm(profileDir, { recursive: true, force: true }));
    await mkdir(join(profileDir, "claude"), { recursive: true });
    await writeFile(join(profileDir, "claude", ".credentials.json"), "{}\n", { mode: 0o600, flag: "wx" });
    const model = stack.use(await nativeConversationModel());
    const diagnosticsDir = process.env.OPENWORK_EVAL_COWORKER_DIAGNOSTICS_DIR?.trim();
    if (diagnosticsDir) {
      if (!isAbsolute(diagnosticsDir)) throw new Error("Diagnostic evidence needs an absolute, run-owned directory.");
      await mkdir(diagnosticsDir, { recursive: true });
      stack.defer(async () => {
        for (const file of ["electron.log", "server.log"]) {
          await cp(join(profileDir, file), join(diagnosticsDir, file), { force: false, errorOnExist: true }).catch((error: unknown) => {
            if (!isNativeRecord(error) || error.code !== "ENOENT") throw error;
          });
        }
        await writeFile(join(diagnosticsDir, "model-after-cleanup.json"), JSON.stringify({ requests: model.requests(), errors: model.errors() }, null, 2), { mode: 0o600, flag: "wx" });
      });
    }
    const cleared = Object.fromEntries(Object.keys(process.env).filter((key) =>
      !/^(PATH|USER|LOGNAME|SHELL|LANG|LC_\w+|TZ|TERM|TMPDIR|TMP|TEMP|DISPLAY|OPENWORK_ELECTRON_REMOTE_DEBUG_PORT)$/.test(key)).map((key) => [key, ""]));
    const app = stack.use(await coworker({ name: "native-discussion", host: stack.use(localHost()), profileDir, env: {
      ...cleared,
      HOME: join(profileDir, "home"), USERPROFILE: join(profileDir, "home"),
      XDG_CONFIG_HOME: join(profileDir, "xdg-config"), XDG_DATA_HOME: join(profileDir, "xdg-data"),
      XDG_CACHE_HOME: join(profileDir, "xdg-cache"), XDG_STATE_HOME: join(profileDir, "xdg-state"),
      APPDATA: join(profileDir, "appdata"), LOCALAPPDATA: join(profileDir, "local-appdata"),
      COWORKER_USER_DATA_DIR: join(profileDir, "electron-userdata"), COWORKER_HOME_DIR: join(profileDir, "coworkers"),
      COWORKER_SERVER_CONFIG: join(profileDir, "coworker-server.json"), COWORKER_DEN_BASE_URL: model.url,
      OPENWORK_DATA_DIR: join(profileDir, "openwork-data"), OPENWORK_RUNTIME_DB: join(profileDir, "runtime.sqlite"),
      OPENWORK_ENV_STORE: join(profileDir, "env.json"), OPENWORK_SERVER_STATE_PATH: join(profileDir, "server-state.json"),
      OPENWORK_SERVER_TOKEN_STORE_PATH: join(profileDir, "server-tokens.json"), OPENWORK_SERVER_LOG_FILE: join(profileDir, "server.log"),
      OPENWORK_DEV_MODE: "1", OPENWORK_ELECTRON_DISABLE_PROTOCOL_REGISTRATION: "1", OPENWORK_ELECTRON_USE_MOCK_KEYCHAIN: "1",
      OPENCODE_MODELS_URL: `${model.url}/models`, OPENCODE_CONFIG_DIR: join(profileDir, "opencode-config"),
      CODEX_HOME: join(profileDir, "codex"), CLAUDE_CONFIG_DIR: join(profileDir, "claude"),
      OLLAMA_HOST: "127.0.0.1:9", LMSTUDIO_HOST: "127.0.0.1:9",
    } }));
    if (diagnosticsDir) await writeFile(join(diagnosticsDir, "launch.json"), JSON.stringify({ binary, profileDir, modelUrl: model.url, pid: app.handle.pid, cdpUrl: app.handle.cdpUrl, hostKind: app.handle.hostKind }, null, 2), { mode: 0o600, flag: "wx" });
    const invoke = async (command: string, payload: unknown = {}) => {
      const response = nativeRecord(await seed.evalIn(app, browserScript((command, payload) => window.__COWORKER__.invoke(command, payload), [command, payload]), { timeoutMs: 120_000 }));
      if (response.ok !== true) throw new Error(`Native fixture setup failed: ${command}: ${String(response.error ?? "unknown error")}`);
      return nativeRecord(response.result);
    };
    const cold = await seed.evalIn(app, () => ({ packaged: location.protocol === "file:" && location.pathname.includes("/app.asar/"), electron: navigator.userAgent.includes("Electron/"), welcome: Boolean(document.querySelector('[data-testid="onboarding-welcome"]')) }));
    const runtime = await invoke("runtime.info");
    if (typeof runtime.serverUrl !== "string" || new URL(runtime.serverUrl).origin !== runtime.serverUrl || new URL(runtime.serverUrl).hostname !== "127.0.0.1"
      || typeof runtime.ownerToken !== "string" || !runtime.ownerToken || runtime.engineManaged !== true || runtime.engineError) throw new Error("Cold packaged native runtime is unavailable.");
    const baseUrl = runtime.serverUrl;
    const headers = { Authorization: `Bearer ${runtime.ownerToken}`, "Content-Type": "application/json" };
    const request = async (method: string, route: string, body?: unknown): Promise<unknown> => {
      const response = await fetch(baseUrl + route, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), redirect: "error", signal: AbortSignal.timeout(method === "GET" ? 15_000 : 60_000) });
      if (!response.ok) throw new Error(`Native fixture ${method} ${route}: HTTP ${response.status}`);
      return response.json();
    };
    const created = await invoke("coworkers.create", { name: "Editor", role: "Writing partner", mission: "Help shape clear product writing.", avatarColor: "blue", avatarGlasses: "round" });
    if (typeof created.workspaceId !== "string" || !created.workspaceId) throw new Error("No native coworker workspace.");
    const workspace = `/workspace/${encodeURIComponent(created.workspaceId)}`;
    await request("PATCH", `${workspace}/config`, { opencode: { provider: {
      "eval-native-discussion": { npm: "@ai-sdk/openai-compatible", name: "Discussion fixture", options: { baseURL: `${model.url}/v1`, apiKey: "fixture-only" }, models: { reply: { name: "Discussion fixture", tool_call: true } } },
    } } });
    await request("POST", `${workspace}/engine/reload`, {});
    await invoke("coworkers.update", { slug: "editor", patch: { model: "eval-native-discussion/reply", modelVariant: "" } });
    const native = (route: string) => request("GET", `${workspace}/opencode2/api${route}`);
    const models = nativeRows(nativeRecord(await native("/model")).data);
    const available = models.filter((model) => model.enabled === true).map((model) => `${model.providerID}/${model.id}`);
    if (JSON.stringify(available) !== JSON.stringify(["eval-native-discussion/reply"])) throw new Error(`Fixture must be the only enabled native model: ${JSON.stringify(available)}`);
    const engine = nativeRecord(await request("GET", "/experimental/engine-v2-preview/status"));
    await seed.evalIn(app, () => { location.reload(); return true; });
    return {
      app, model, cold, engine,
      uiState: () => evaluateOnSurface(app, () => ({
        draft: document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Message Editor"]')?.value ?? null,
        working: document.querySelector('[data-testid="coworker-composer"]')?.getAttribute("data-working") ?? null,
        status: document.querySelector('[data-testid="coworker-thread-status"]')?.textContent?.trim() ?? null,
        outcome: document.querySelector('[data-testid="coworker-thread-status"]')?.getAttribute("data-outcome") ?? null,
        users: [...document.querySelectorAll('[data-message-role="user"]')].map((node) => node.textContent?.trim()),
        replies: [...document.querySelectorAll('[data-message-role="assistant"]')].map((node) => node.textContent?.trim()),
        next: [...document.querySelectorAll('[data-testid="coworker-next-row"]')].map((node) => node.textContent?.trim()),
        text: document.body.innerText,
      }), { timeoutMs: 5_000 }),
      sessionIds: async () => nativeRows(nativeRecord(await native("/session?limit=200")).data).map((session) => {
        if (typeof session.id !== "string" || !session.id.startsWith("ses_")) throw new Error("Invalid native session identity.");
        return session.id;
      }),
      async state(id: string) {
        const route = `/session/${encodeURIComponent(id)}`;
        const [session, history, active, inbox] = await Promise.all([native(route), native(`${route}/message?limit=200&order=asc`), native("/session/active"), native(`${route}/inbox`)]);
        let page = nativeRecord(history);
        const messages: Record<string, unknown>[] = [];
        const pageSizes: number[] = [];
        const cursors = new Set<string>();
        for (let index = 0; index < 3; index++) {
          const rows = nativeRows(page.data);
          messages.push(...rows);
          pageSizes.push(rows.length);
          const cursor = nativeRecord(page.cursor).next;
          if (cursor === undefined || cursor === null) break;
          if (typeof cursor !== "string" || !cursor || cursors.has(cursor) || index === 2) throw new Error("Native history cursor is invalid, repeated, or exceeds the three-page fixture bound.");
          cursors.add(cursor);
          page = nativeRecord(await native(`${route}/message?limit=200&cursor=${encodeURIComponent(cursor)}`));
        }
        if (new Set(messages.map((message) => message.id)).size !== messages.length) throw new Error("Native history repeated a message ID across pages.");
        return {
          session: nativeRecord(nativeRecord(session).data), running: Object.hasOwn(nativeRecord(nativeRecord(active).data), id), inbox: nativeRows(nativeRecord(inbox).data),
          historyPageSizes: pageSizes, historyBoundary: nativeRecord(page.cursor),
          messages: messages.map((message) => ({ id: message.id, type: message.type,
            text: typeof message.text === "string" ? message.text : nativeRows(message.content ?? []).filter((part) => part.type === "text").map((part) => part.text).join(""),
            completed: typeof nativeRecord(message.time).completed === "number", finish: message.finish ?? null, error: message.error ?? null,
          })),
        };
      },
      [Symbol.asyncDispose]: () => stack.disposeAsync(),
    };
  } catch (error) {
    await stack.disposeAsync();
    throw error;
  }
}

type OnboardingFrame = {
  at: number; stage: string; headings: string[]; meaningful: number; background: string[];
  reducedMotion: boolean; movingSurfaces: number; status: string; outcome: string; working: string;
  visibleStatus: string; warming: boolean; leaked: boolean;
};

type OnboardingFrameWatch = { frames: OnboardingFrame[]; overflow: boolean; stop(): void };

declare global {
  interface Window {
    __coworkerOnboardingFrames?: OnboardingFrameWatch;
  }
}

export async function isolatedOnboardingCoworker(_seed: Seed, { place }: { place: Place }) {
  if (place.kind !== "local" || process.platform !== "darwin") throw new SkipError("native onboarding requires an isolated local macOS package");
  const binary = process.env.OPENWORK_EVAL_ELECTRON_BINARY?.trim();
  if (!binary) throw new SkipError("set OPENWORK_EVAL_ELECTRON_BINARY to the coordinator's unsigned package");
  if (!isAbsolute(binary) || !binary.includes(".app/Contents/MacOS/")) throw new Error("Native onboarding requires an absolute packaged app executable, not source Electron.");
  const resolvedBinary = await realpath(binary);
  if (resolvedBinary.includes("/Applications/") || process.env.OPENWORK_EVAL_ELECTRON_ENTRY?.trim() || process.env.OPENWORK_EVAL_COWORKER_PROFILE_DIR?.trim()) throw new Error("Native onboarding refuses an installed app, entry override, or retained profile.");
  if (process.env.OPENWORK_EVAL_ENGINE !== "v2" || process.env.OPENWORK_EVAL_VISION !== "defer") throw new Error("Select native v2 and deferred vision explicitly; this proof must not call a paid judge.");
  if (process.env.OPENWORK_EVAL_COWORKER_LOOPBACK_ONLY !== "1") throw new Error("Run the selected cases under the inherited macOS sandbox-exec loopback-only policy; no app was started.");
  if (["OPENWORK_EVAL_DAYTONA", "OPENWORK_EVAL_DAYTONA_SANDBOX_ID", "OPENWORK_EVAL_DEN_API_URL", "OPENWORK_EVAL_DEN_WEB_URL"].some((key) => process.env[key]?.trim())) throw new Error("Native onboarding refuses inherited remote or shared Den placement.");
  const egress = await Promise.all(["192.0.2.1", "2001:db8::1"].map((host) => new Promise<{ family: string; denied: string }>((resolve, reject) => {
    const socket = createConnection({ host, port: 9 });
    const timer = setTimeout(() => { socket.destroy(); reject(new Error("Egress confinement was not confirmed before launch.")); }, 1_500);
    socket.once("connect", () => { clearTimeout(timer); socket.destroy(); reject(new Error("External egress is not blocked; refusing to launch.")); });
    socket.once("error", (error) => {
      clearTimeout(timer);
      socket.destroy();
      if (!isNativeRecord(error) || !["EPERM", "EACCES"].includes(String(error.code))) reject(new Error("Expected an OS permission denial, not a network timeout or missing route. No app was started."));
      else resolve({ family: host.includes(":") ? "IPv6" : "IPv4", denied: String(error.code) });
    });
  })));
  const resources = join(dirname(resolvedBinary), "..", "Resources");
  const packageFiles = [join(resources, "app.asar"), join(resources, "sidecars/opencode2")];
  await access(packageFiles[1], constants.X_OK);
  const pin = nativeRecord(nativeRecord(JSON.parse(await readFile(join(resources, "sidecars/versions.json"), "utf8"))).opencode2);
  if (pin.version !== "0.0.0-beta-19271" || pin.platform !== process.platform || pin.arch !== process.arch) throw new Error("The supplied package does not contain the pinned native v2 sidecar for this host.");
  const packageHashes = await Promise.all(packageFiles.map(async (file) => ({ file: file.slice(resources.length + 1), sha256: createHash("sha256").update(await readFile(file)).digest("hex") })));
  const stack = new AsyncDisposableStack();
  try {
    const profileDir = await mkdtemp(join(await realpath(tmpdir()), "coworker-onboarding-"));
    stack.defer(() => rm(profileDir, { recursive: true, force: true }));
    await mkdir(join(profileDir, "claude"), { recursive: true });
    await writeFile(join(profileDir, "claude/.credentials.json"), "{}\n", { mode: 0o600, flag: "wx" });
    const nonce = randomUUID();
    const grant = `fixture-grant-${nonce}`, sessionToken = `fixture-session-${nonce}`, cloudKey = `ow_gw_fixture_${nonce}`, byokKey = `fixture-byok-${nonce}`;
    const orgId = "org_onboarding_fixture", cloudProvider = "ipr_onboarding_fixture", customProvider = "custom-fixture-box";
    const group = "00000000000000000000000001", credential = "00000000000000000000000002";
    const cloudModels = ["00000000000000000000000003", "00000000000000000000000004"].map((model) => `gwm_${group}_${credential}_${model}`);
    const customModels = ["local-small", "local-large"];
    const secrets = [grant, sessionToken, cloudKey, byokKey];
    const denReads: Array<{ path: string; authenticated: boolean; scoped: boolean; status: number }> = [];
    const calls: Array<{ id: number; route: string; model: string; prompt: string; effort: unknown; authenticated: boolean; startedAt: number; finished: boolean; aborted: boolean; expired: boolean; reply: string }> = [];
    const held = new Map<number, ServerResponse>();
    const pendingCatalog = new Set<ServerResponse>();
    const faults: string[] = [];
    let origin = "", exchanges = 0, catalogState: "available" | "held" | "unavailable" = "available";
    const json = (response: ServerResponse, status: number, body: unknown) => {
      response.writeHead(status, { "content-type": "application/json", "access-control-allow-origin": "*", "access-control-allow-methods": "GET, POST, OPTIONS", "access-control-allow-headers": "authorization, content-type, x-openwork-org-id, x-openwork-legacy-org-id" });
      response.end(JSON.stringify(body));
    };
    const provider = () => ({
      id: cloudProvider, providerId: "openai", name: "Fixture Cloud", credentialMode: "org", credentialStatus: "ready", source: "openwork_gateway", status: "active", authUrl: null, authorizationRequests: [],
      updatedAt: "2026-09-01T00:00:00.000Z", modelIds: ["gpt-5.6-luna", "gpt-5.5"],
      providerConfig: { npm: "@ai-sdk/openai-compatible", env: ["IPR_ONBOARDING_FIXTURE_API_KEY"], options: { baseURL: `${origin}/cloud/v1` } },
      models: cloudModels.map((id, index) => ({
        id, name: index === 0 ? "Cloud model A" : "Cloud model B", upstreamModelId: index === 0 ? "openai/gpt-5.6-luna" : "gpt-5.5",
        modelGroupId: `gmg_${group}`, modelGroupName: "Fixture models", credentialSetId: `gcs_${credential}`, credentialSetName: "Synthetic organization key",
        config: { id, tool_call: true, reasoning: true, status: "active", modalities: { input: ["text"], output: ["text"] },
          upstreamModelId: "untrusted-config-identity", limit: { context: 128_000, output: 8_192 }, cost: { input: index === 0 ? 2 : 1, output: index === 0 ? 6 : 3 },
          variants: { minimal: { reasoningEffort: "minimal" }, low: { reasoningEffort: "low" }, medium: { reasoningEffort: "medium" }, high: { reasoningEffort: "high" } },
          headers: { "x-openwork-gateway-request-model": id } },
      })),
    });
    const bodyOf = async (request: import("node:http").IncomingMessage) => {
      let raw = "";
      for await (const chunk of request) {
        raw += String(chunk);
        if (raw.length > 2_097_152) throw new Error("Fixture request exceeded its bound.");
      }
      return raw ? nativeRecord(JSON.parse(raw)) : {};
    };
    const sse = (response: ServerResponse, call: typeof calls[number], content: string, finish: string | null) => response.write(`data: ${JSON.stringify({ id: `chatcmpl-fixture-${call.id}`, object: "chat.completion.chunk", created: 1, model: call.model, choices: [{ index: 0, delta: { content }, finish_reason: finish }], ...(finish ? { usage: { prompt_tokens: 4, completion_tokens: 6, total_tokens: 10 } } : {}) })}\n\n`);
    const server = createServer((request, response) => {
      void (async () => {
        const pathname = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
        const route = pathname.replace(/^\/api\/den(?=\/|$)/, "");
        if (request.method === "OPTIONS") { json(response, 204, null); return; }
        if (["/catalog", "/catalog/api.json"].includes(route)) { json(response, 200, {}); return; }
        if (route === "/api/tags") { json(response, 200, { models: [] }); return; }
        if (route === "/v1/models") { json(response, 200, { data: [] }); return; }
        if (route === "/custom/v1/models") {
          const authenticated = request.headers.authorization === `Bearer ${byokKey}`;
          json(response, authenticated ? 200 : 401, authenticated ? { object: "list", data: customModels.map((id) => ({ id, object: "model" })) } : { error: { message: "The fixture server did not accept the key." } });
          return;
        }
        if (request.method === "POST" && ["/cloud/v1/chat/completions", "/custom/v1/chat/completions"].includes(route)) {
          const body = await bodyOf(request);
          const messages = nativeRows(body.messages);
          const lastUser = messages.findLast((message) => message.role === "user");
          const prompt = typeof lastUser?.content === "string" ? lastUser.content : Array.isArray(lastUser?.content) ? nativeRows(lastUser.content).map((part) => typeof part.text === "string" ? part.text : "").join("\n") : "";
          const cloud = route.startsWith("/cloud/");
          const model = typeof body.model === "string" ? body.model : "";
          const call = { id: calls.length + 1, route, model, prompt, effort: body.reasoning_effort ?? body.reasoning ?? null,
            authenticated: request.headers.authorization === `Bearer ${cloud ? cloudKey : byokKey}`, startedAt: Date.now(), finished: false, aborted: false, expired: false, reply: `The next review step is ready (${nonce}-${calls.length + 1}).` };
          calls.push(call);
          if (!call.authenticated || !(cloud ? cloudModels : customModels).includes(model) || body.stream !== true
            || (cloud && request.headers["x-openwork-gateway-request-model"] !== model)) {
            faults.push(`Dispatch ${call.id} escaped its fixture model, credential or protocol boundary.`);
            json(response, 400, { error: { message: "Fixture dispatch boundary mismatch." } });
            return;
          }
          held.set(call.id, response);
          const deadline = setTimeout(() => { call.expired = true; response.destroy(); }, 120_000);
          response.once("close", () => { clearTimeout(deadline); call.aborted = !call.finished; held.delete(call.id); });
          return;
        }
        if (request.method === "POST" && route === "/v1/auth/desktop-handoff/exchange") {
          const body = await bodyOf(request);
          if (body.grant !== grant || exchanges !== 0) { json(response, 400, { error: "invalid_grant" }); return; }
          exchanges++;
          json(response, 200, { token: sessionToken, user: { name: "Fixture member", email: "member@example.test" }, organization: { id: orgId, name: "Fixture organization", slug: "fixture" }, connectEnabled: false });
          return;
        }
        const authenticated = request.headers.authorization === `Bearer ${sessionToken}`;
        const scoped = (request.headers["x-openwork-org-id"] ?? request.headers["x-openwork-legacy-org-id"]) === orgId;
        const status = !authenticated ? 401 : !scoped && route !== "/v1/me/orgs" ? 403 : route === "/v1/inference-providers" && catalogState === "unavailable" ? 503 : 200;
        denReads.push({ path: route, authenticated, scoped, status });
        if (status !== 200) { json(response, status, { error: "fixture_unavailable" }); return; }
        if (route === "/v1/me/orgs") { json(response, 200, { orgs: [{ id: orgId, name: "Fixture organization" }], activeOrgId: orgId }); return; }
        if (route === "/v1/me/desktop-config") { json(response, 200, {}); return; }
        if (route === "/v1/me/coworkers") { json(response, 200, { enabled: false, items: [], nextCursor: null }); return; }
        if (route === "/v1/llm-providers") { json(response, 200, { llmProviders: [] }); return; }
        if (route === "/v1/inference-providers") {
          if (catalogState === "held") { pendingCatalog.add(response); response.once("close", () => pendingCatalog.delete(response)); }
          else json(response, 200, { inferenceProviders: [provider()] });
          return;
        }
        if (route === `/v1/inference-providers/${cloudProvider}/connect`) { json(response, 200, { inferenceProvider: { ...provider(), apiKey: cloudKey, apiKeys: { IPR_ONBOARDING_FIXTURE_API_KEY: cloudKey } } }); return; }
        if (route === "/v1/inference") { json(response, 503, { error: "fixture_membership_unverified" }); return; }
        if (route === "/v1/automations") { json(response, 200, { items: [], nextCursor: null }); return; }
        if (route === "/v1/mcp/token") { json(response, 403, { error: "connect_disabled" }); return; }
        json(response, 404, { error: "fixture_route_unavailable" });
      })().catch(() => { faults.push("A fixture request could not be parsed."); if (!response.headersSent) json(response, 400, { error: "invalid_fixture_request" }); else response.destroy(); });
    });
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
    stack.defer(async () => {
      for (const response of [...held.values(), ...pendingCatalog]) response.destroy();
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("The fixture did not bind loopback.");
    origin = `http://127.0.0.1:${address.port}`;
    const cleared = Object.fromEntries(Object.keys(process.env).filter((key) => !/^(PATH|USER|LOGNAME|SHELL|LANG|LC_\w+|TZ|TERM|TMPDIR|TMP|TEMP|OPENWORK_ELECTRON_REMOTE_DEBUG_PORT)$/.test(key)).map((key) => [key, ""]));
    const app = stack.use(await coworker({ name: "native-onboarding", host: stack.use(localHost()), profileDir, env: {
      ...cleared, HOME: join(profileDir, "home"), USERPROFILE: join(profileDir, "home"), APPDATA: join(profileDir, "appdata"), LOCALAPPDATA: join(profileDir, "local-appdata"),
      XDG_CONFIG_HOME: join(profileDir, "xdg-config"), XDG_DATA_HOME: join(profileDir, "xdg-data"), XDG_CACHE_HOME: join(profileDir, "xdg-cache"), XDG_STATE_HOME: join(profileDir, "xdg-state"),
      COWORKER_USER_DATA_DIR: join(profileDir, "electron-userdata"), COWORKER_HOME_DIR: join(profileDir, "coworkers"), COWORKER_SERVER_CONFIG: join(profileDir, "coworker-server.json"),
      COWORKER_DEN_BASE_URL: origin, OPENWORK_DATA_DIR: join(profileDir, "openwork-data"), OPENWORK_RUNTIME_DB: join(profileDir, "runtime.sqlite"), OPENWORK_ENV_STORE: join(profileDir, "env.json"),
      OPENWORK_SERVER_STATE_PATH: join(profileDir, "server-state.json"), OPENWORK_SERVER_TOKEN_STORE_PATH: join(profileDir, "server-tokens.json"), OPENWORK_SERVER_LOG_FILE: join(profileDir, "server.log"),
      OPENWORK_DEV_MODE: "1", OPENWORK_ELECTRON_DISABLE_PROTOCOL_REGISTRATION: "1", OPENWORK_ELECTRON_USE_MOCK_KEYCHAIN: "1",
      OPENCODE_CONFIG_DIR: join(profileDir, "opencode-config"), OPENCODE_DB: join(profileDir, "opencode.db"), OPENCODE_MODELS_URL: `${origin}/catalog`,
      OPENCODE_DISABLE_DEFAULT_PLUGINS: "1", OPENCODE_DISABLE_INSTALL: "1", CODEX_HOME: join(profileDir, "codex"), CLAUDE_CONFIG_DIR: join(profileDir, "claude"),
      OLLAMA_HOST: origin, LMSTUDIO_HOST: origin,
    } }));
    const invoke = async (command: string, payload: unknown = {}) => {
      const response = nativeRecord(await evaluateOnSurface(app, browserScript((command, payload) => {
        const host: Window & { __COWORKER__?: CoworkerTestBridge } = window;
        if (!host.__COWORKER__) throw new Error("The native Coworker bridge is missing.");
        return host.__COWORKER__.invoke(command, payload);
      }, [command, payload]), { timeoutMs: 30_000 }));
      if (response.ok !== true) throw new Error(`Native read failed: ${command}`);
      return response.result;
    };
    const runtime = async () => {
      const value = nativeRecord(await invoke("runtime.info"));
      if (typeof value.serverUrl !== "string" || new URL(value.serverUrl).hostname !== "127.0.0.1" || typeof value.ownerToken !== "string" || value.engineManaged !== true || value.engineError) throw new Error("The real embedded native v2 runtime is unavailable.");
      const identity: Pick<RuntimeInfo, "serverUrl" | "ownerToken" | "readinessKey" | "workspaceReadinessRevisions"> = {
        serverUrl: value.serverUrl, ownerToken: value.ownerToken,
        readinessKey: typeof value.readinessKey === "string" ? value.readinessKey : undefined,
        workspaceReadinessRevisions: Object.fromEntries(Object.entries(nativeRecord(value.workspaceReadinessRevisions ?? {})).map(([key, revision]) => {
          if (typeof revision !== "number") throw new Error("Invalid native workspace revision.");
          return [key, revision];
        })),
      };
      return identity;
    };
    const request = async (route: string) => {
      const info = await runtime();
      const response = await fetch(`${info.serverUrl}${route}`, { headers: { Authorization: `Bearer ${info.ownerToken}` }, redirect: "error", signal: AbortSignal.timeout(15_000) });
      if (!response.ok) throw new Error(`Native GET ${route}: HTTP ${response.status}`);
      return nativeRecord(await response.json());
    };
    const coworkers = async () => nativeRows(await invoke("coworkers.list")).map((item) => {
      const field = (key: string) => { if (typeof item[key] !== "string") throw new Error(`Native coworker has no ${key}.`); return item[key]; };
      return { slug: field("slug"), name: field("name"), workspaceId: field("workspaceId"), createdAt: field("createdAt"), conversationThreadId: field("conversationThreadId"), model: field("model"), modelVariant: field("modelVariant"), modelChosenBy: field("modelChosenBy"), modelMode: field("modelMode"), effortPreference: field("effortPreference"), useAppModelDefaults: item.useAppModelDefaults !== false };
    });
    const modelDefaults = async (): Promise<CoworkerSettings["modelDefaults"]> => {
      const defaults = nativeRecord(nativeRecord(await invoke("settings.get")).modelDefaults);
      const choice = (role: string) => {
        const value = nativeRecord(defaults[role]);
        if (typeof value.model !== "string" || typeof value.modelVariant !== "string") throw new Error("Invalid native model default.");
        return { model: value.model, modelVariant: value.modelVariant };
      };
      return { conversation: choice("conversation"), thinking: choice("thinking"), delivery: choice("delivery"), facilitator: choice("facilitator") };
    };
    await invoke("settings.update", { progressSummariesEnabled: false, automaticMemoryEnabled: false });
    const cold = await evaluateOnSurface(app, () => ({ packaged: location.protocol === "file:" && location.pathname.includes("/app.asar/"), electron: navigator.userAgent.includes("Electron/"), welcome: Boolean(document.querySelector('[data-testid="onboarding-welcome"]')) }));
    if (!cold.packaged || !cold.electron || !cold.welcome || (await coworkers()).length) throw new Error("The fixture did not start at real, empty packaged onboarding.");
    const engine = await request("/experimental/engine-v2-preview/status");
    if (engine.running !== true || engine.version !== pin.version) throw new Error("The packaged native v2 sidecar did not become active.");
    function watchFrames(secrets: string[]) {
      window.__coworkerOnboardingFrames?.stop();
      const frames: OnboardingFrame[] = [];
      let stopped = false, scheduled = 0;
      const visible = (node: Element) => {
        const rect = node.getBoundingClientRect();
        if (rect.width < 4 || rect.height < 4 || rect.bottom <= 0 || rect.right <= 0 || rect.top >= innerHeight || rect.left >= innerWidth) return false;
        for (let parent: Element | null = node; parent; parent = parent.parentElement) {
          const style = getComputedStyle(parent);
          if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) < 0.05) return false;
        }
        const hit = document.elementFromPoint(Math.max(1, Math.min(innerWidth - 1, rect.x + rect.width / 2)), Math.max(1, Math.min(innerHeight - 1, rect.y + rect.height / 2)));
        return Boolean(hit && (node.contains(hit) || hit.contains(node)));
      };
      const sample = () => {
        if (stopped) return;
        if (frames.length >= 36_000) { watch.overflow = true; watch.stop(); return; }
        const content = [...document.querySelectorAll<HTMLElement>('h1, h2, p, button, label, summary, textarea, [role="status"]')].filter((node) => visible(node) && (node.innerText?.trim() || node.getAttribute("aria-label")));
        const roots = [...document.querySelectorAll<HTMLElement>('[data-testid="sign-in-gate"], [data-testid="local-mode"], [data-testid="onboarding-models"], [data-testid="onboarding-intents"], [data-testid="onboarding-team"], [data-testid="onboarding-team-preparing"], [data-testid="coworker-discussion-view"], [data-testid="openwork-settings"]')].filter(visible);
        const background = [0.2, 0.5, 0.8].map((y) => {
          for (const node of document.elementsFromPoint(innerWidth / 2, innerHeight * y)) {
            const style = getComputedStyle(node);
            const color = style.backgroundColor;
            if (Number(style.opacity) > 0.05 && color !== "transparent" && color !== "rgba(0, 0, 0, 0)") return color;
          }
          return "transparent";
        });
        const surfaceAnimations = document.getAnimations().filter((animation) => {
          const effect = animation.effect;
          if (!(effect instanceof KeyframeEffect) || !(effect.target instanceof Element) || !visible(effect.target)) return false;
          const bounds = effect.target.getBoundingClientRect();
          return bounds.width > innerWidth / 2 && bounds.height > innerHeight / 2 && animation.playState === "running"
            && effect.getKeyframes().some((frame) => frame.opacity !== undefined || frame.transform !== undefined);
        });
        const text = document.body?.innerText ?? "";
        frames.push({ at: Date.now(), stage: roots[0]?.dataset.testid ?? (document.querySelector('[data-testid="onboarding-welcome"]') ? "onboarding-welcome" : "app"),
          headings: [...document.querySelectorAll<HTMLElement>("h1, h2")].filter(visible).map((node) => node.innerText), meaningful: content.length, background,
          reducedMotion: matchMedia("(prefers-reduced-motion: reduce)").matches, movingSurfaces: surfaceAnimations.length,
          status: document.querySelector('[data-testid="coworker-thread-status"]')?.textContent?.trim() ?? "", outcome: document.querySelector('[data-testid="coworker-thread-status"]')?.getAttribute("data-outcome") ?? "",
          working: document.querySelector('[data-testid="coworker-composer"]')?.getAttribute("data-working") ?? "",
          visibleStatus: [...document.querySelectorAll<HTMLElement>('[data-testid="coworker-turn-line"], [data-testid="coworker-turn-outcome"], [data-testid="coworker-rail-status"], [role="status"]')].filter(visible).map((node) => node.innerText).join("\n"),
          warming: [...document.querySelectorAll('[data-testid="coworker-workspace-warming"], [data-testid="coworker-workspace-problem"], [data-testid="coworker-ai-unavailable"]')].some(visible),
          leaked: secrets.some((secret) => text.includes(secret)) });
        scheduled = requestAnimationFrame(sample);
      };
      const watch: OnboardingFrameWatch = { frames, overflow: false, stop() { stopped = true; cancelAnimationFrame(scheduled); } };
      window.__coworkerOnboardingFrames = watch;
      scheduled = requestAnimationFrame(sample);
    }
    stack.use(await addInitScript(app.client, browserScript(watchFrames, [secrets])));
    await evaluateOnSurface(app, browserScript(watchFrames, [secrets]));
    stack.defer(async () => { await evaluateOnSurface(app, () => window.__coworkerOnboardingFrames?.stop()).catch(() => undefined); });
    const frames = async () => evaluateOnSurface(app, () => {
      const watch = window.__coworkerOnboardingFrames;
      if (!watch) throw new Error("Transition frame witness is missing.");
      return { frames: watch.frames, overflow: watch.overflow };
    });
    return {
      app, cold, engine, egress, packageHashes, cloudProvider, cloudModels, customProvider, customModels, byokKey,
      customAddress: `${origin}/custom/v1`,
      async typeHandoff() {
        const focused = await evaluateOnSurface(app, () => document.activeElement instanceof HTMLInputElement && document.activeElement.placeholder.startsWith("opencoworker://den-auth") && document.activeElement.value === "");
        if (!focused) throw new Error("Focus the empty native sign-in link field before entering its synthetic grant.");
        await typeText(app, `opencoworker://den-auth?grant=${grant}&denBaseUrl=${encodeURIComponent(origin)}`);
      },
      coworkers, modelDefaults, frames,
      restartFrames: () => evaluateOnSurface(app, browserScript(watchFrames, [secrets])),
      async reducedMotion() { await app.client.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-reduced-motion", value: "reduce" }] }); },
      async rendererOffline(offline: boolean) { await app.client.send("Network.enable"); await app.client.send("Network.emulateNetworkConditions", { offline, latency: 0, downloadThroughput: -1, uploadThroughput: -1 }); },
      den: {
        reads: () => [...denReads], exchanges: () => exchanges,
        catalog(state: typeof catalogState) {
          catalogState = state;
          if (state !== "held") { for (const response of pendingCatalog) json(response, state === "available" ? 200 : 503, state === "available" ? { inferenceProviders: [provider()] } : { error: "fixture_catalog_unavailable" }); pendingCatalog.clear(); }
        },
      },
      model: {
        requests: () => calls.map((call) => ({ ...call })), faults: () => [...faults],
        release(id: number, outcome: "success" | "failure" = "success") {
          const call = calls.find((entry) => entry.id === id), response = held.get(id);
          if (!call || !response || response.destroyed || response.writableEnded) throw new Error(`Fixture request ${id} is not held.`);
          call.finished = true;
          if (outcome === "failure") json(response, 401, { error: { type: "authentication_error", code: "invalid_api_key", message: "The fixture provider rejected this request. Check the connection before retrying." } });
          else {
            response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
            sse(response, call, call.reply, null);
            sse(response, call, "", "stop");
            response.end("data: [DONE]\n\n");
          }
        },
      },
      async preparation() {
        const info = await runtime();
        return { key: info.readinessKey, revisions: info.workspaceReadinessRevisions };
      },
      async state(slug: string) {
        const coworker = (await coworkers()).find((item) => item.slug === slug);
        if (!coworker?.conversationThreadId) throw new Error("The native conversation has not been created.");
        const base = `/workspace/${encodeURIComponent(coworker.workspaceId)}/opencode2/api`;
        const thread = `${base}/session/${encodeURIComponent(coworker.conversationThreadId)}`;
        const [session, messages, active, activity] = await Promise.all([request(thread), request(`${thread}/message?limit=100&order=asc`), request(`${base}/session/active`), invoke("turns.activity", { slug, threadId: coworker.conversationThreadId })]);
        return { threadId: coworker.conversationThreadId, session: session.data, running: Object.hasOwn(nativeRecord(active.data), coworker.conversationThreadId), activity: nativeRows(activity).map((entry) => {
          const admission = nativeRecord(entry.admission ?? {});
          return { executionId: entry.executionId, messageId: entry.messageId, state: entry.state, available: entry.available, nativeStatus: entry.nativeStatus,
            admission: { phase: admission.phase, confirmed: admission.confirmed === true, inFlight: admission.inFlight ?? null, stopped: admission.stopped === true } };
        }),
          messages: nativeRows(messages.data).map((message) => ({ id: message.id, type: message.type, model: message.model, parentId: message.parentID ?? message.parentId,
            text: typeof message.text === "string" ? message.text : nativeRows(message.content ?? []).filter((part) => part.type === "text").map((part) => part.text).join(""),
            completed: typeof nativeRecord(message.time).completed === "number", error: message.error ?? null, finish: message.finish ?? null })) };
      },
      ui: () => evaluateOnSurface(app, () => ({
        roles: [...document.querySelectorAll<HTMLElement>('[data-testid^="model-default-"]')].map((node) => ({ role: node.dataset.testid?.replace("model-default-", ""), summary: node.querySelector("summary")?.textContent?.trim(), current: node.querySelector('[data-testid="model-picker-current"]')?.textContent?.trim(), detail: node.querySelector('[data-testid="model-picker-current-detail"]')?.textContent?.trim(), variant: node.querySelector<HTMLSelectElement>("select[title]")?.value ?? "" })),
        continueDisabled: document.querySelector<HTMLButtonElement>('[data-testid="onboarding-models-continue"]')?.disabled,
        contextOpen: document.querySelector('[data-testid="context-panel"]')?.getAttribute("data-collapsed") === "false",
        status: document.querySelector('[data-testid="coworker-thread-status"]')?.textContent?.trim() ?? document.querySelector('[data-testid="coworker-top-status"]')?.textContent?.trim() ?? "",
        state: document.querySelector('[data-testid="coworker-thread-status"]')?.getAttribute("data-state") ?? "", outcome: document.querySelector('[data-testid="coworker-thread-status"]')?.getAttribute("data-outcome") ?? "",
        warming: Boolean(document.querySelector('[data-testid="coworker-workspace-warming"], [data-testid="coworker-workspace-problem"], [data-testid="coworker-ai-unavailable"]')),
        working: document.querySelector('[data-testid="coworker-composer"]')?.getAttribute("data-working"),
        text: document.body.innerText, width: innerWidth, height: innerHeight, scale: devicePixelRatio,
      })),
      async privacy() {
        const logs = await Promise.all(["electron.log", "server.log"].map((file) => readFile(join(profileDir, file), "utf8").catch((error: unknown) => { if (isNativeRecord(error) && error.code === "ENOENT") return ""; throw error; })));
        const text = await evaluateOnSurface(app, () => document.body.innerText);
        return { inspectedLogs: logs.filter(Boolean).length, clean: secrets.every((secret) => !text.includes(secret) && logs.every((log) => !log.includes(secret))) };
      },
      [Symbol.asyncDispose]: () => stack.disposeAsync(),
    };
  } catch (error) {
    await stack.disposeAsync();
    throw error;
  }
}

export type StandardAppSource = GeneratedArtifactViewBuildInput;

/** The HTML of one standard MCP App view, compiled by the builder OpenWork Connect ships. */
export async function buildStandardAppHtml(source: StandardAppSource): Promise<string> {
  const builder = await import("../../ee/apps/den-api/src/generated-artifact-view-builder.js");
  const built = await builder.buildGeneratedArtifactViewInWorker(source);
  if (!built.ok) throw new Error(`Standard MCP App build failed: ${JSON.stringify(built.diagnostics)}`);
  return built.html;
}

/** Unlike the legacy DOM-click helpers, these events reach the preload's user-activation gate. */
export async function clickCoworkerControl(app: Surface, target: Target): Promise<void> {
  await app.client.send("Page.bringToFront");
  const found = await waitForLocated(app, target, { mustHitTest: true, timeoutMs: 30_000 }).catch(async (error) => {
    console.warn("Coworker control diagnostics", await evaluateOnSurface(app, browserScript((testId) =>
      [...document.querySelectorAll<HTMLElement>("[data-testid]")].filter((node) => node.dataset.testid === testId).map((node) => {
        const ancestors = [];
        for (let parent: HTMLElement | null = node; parent; parent = parent.parentElement) {
          const style = getComputedStyle(parent);
          const rect = parent.getBoundingClientRect();
          ancestors.push({ tag: parent.tagName, id: parent.dataset.testid, classes: parent.className, display: style.display, visibility: style.visibility, opacity: style.opacity, rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height } });
        }
        return ancestors;
      }), [typeof target === "object" ? target.testId : ""] )));
    throw error;
  });
  await clickAt(app, found.center);
}

export async function typeCoworkerSpace(app: Surface): Promise<void> {
  await pressKey(app, process.platform === "darwin" ? "Meta+ArrowDown" : "Control+End");
  await app.client.send("Input.dispatchKeyEvent", { type: "keyDown", key: " ", code: "Space", text: " ", windowsVirtualKeyCode: 32 });
  await app.client.send("Input.dispatchKeyEvent", { type: "keyUp", key: " ", code: "Space", windowsVirtualKeyCode: 32 });
}

/** The account journey never inherits a provider, engine database, or Coworker home. */
export async function isolatedAccountCoworker(name: string, denBaseUrl: string, fakeMicrophone = false) {
  const profileDir = await mkdtemp(join(await realpath(tmpdir()), "coworker-account-"));
  const cleared = Object.fromEntries(Object.keys(process.env).filter((key) => /^(OPENCODE_|COWORKER_)/.test(key) || /(_API_KEY|_ACCESS_TOKEN|_AUTH_TOKEN)$/.test(key)).map((key) => [key, ""]));
  try {
    const app = await coworker({ name, profileDir, env: {
      ...cleared,
      COWORKER_DEN_BASE_URL: denBaseUrl,
      COWORKER_HOME_DIR: join(profileDir, "coworkers"),
      COWORKER_USER_DATA_DIR: join(profileDir, "electron-userdata"),
      COWORKER_SERVER_CONFIG: join(profileDir, "coworker-server.json"),
      OPENWORK_RUNTIME_DB: join(profileDir, "runtime.sqlite"),
      OPENWORK_SERVER_STATE_PATH: join(profileDir, "server-state.json"),
      OPENWORK_SERVER_TOKEN_STORE_PATH: join(profileDir, "server-tokens.json"),
      OPENWORK_SERVER_LOG_FILE: join(profileDir, "server.log"),
      OPENWORK_SERVER_URL: "",
      OPENWORK_SERVER_TOKEN: "",
      OPENWORK_POLICY_TOKEN: "",
      OPENWORK_UI_CONTROL_DISCOVERY: "",
      OPENWORK_OPENCODE_BIN: "",
      OPENCODE_CONFIG_DIR: join(profileDir, "opencode-config"),
      OPENCODE_DB: join(profileDir, "opencode.db"),
      CODEX_HOME: join(profileDir, "codex"),
      // Fake device only: the native consent and preload gesture gates remain real.
      ELECTRON_EXTRA_LAUNCH_ARGS: fakeMicrophone ? "--use-fake-device-for-media-stream" : "",
    } });
    return { ...app, async [Symbol.asyncDispose]() {
      await app.stop();
      await rm(profileDir, { recursive: true, force: true });
    } };
  } catch (error) {
    await rm(profileDir, { recursive: true, force: true });
    throw error;
  }
}

/** Destructive proof owns every storage path and refuses an implicit SDK install. */
export async function isolatedFreshStartCoworker(modelUrl: string, previewOnly = false) {
  const profileDir = await mkdtemp(join(await realpath(tmpdir()), "coworker-fresh-start-"));
  const owned = join(profileDir, "owned");
  const cleared = Object.fromEntries(Object.keys(process.env).filter((key) =>
    /^(OPENWORK_|OPENCODE_|COWORKER_|ELECTRON_|CODEX_|CLAUDE_)/.test(key)
    || /(_API_KEY|_ACCESS_TOKEN|_AUTH_TOKEN)$/.test(key)).map((key) => [key, ""]));
  try {
    await mkdir(owned, { recursive: true });
    const sdk = process.env.OPENWORK_EVAL_COWORKER_SDK_DIRECTORY;
    if (!previewOnly && !sdk) throw new Error("Native reset proof cannot launch without installing: provide OPENWORK_EVAL_COWORKER_SDK_DIRECTORY containing the already-cached engine SDK (node_modules/@opencode-ai/plugin). No app was started.");
    // The supplementary design preview exercises the real app's unavailable-engine
    // path. It cannot run a model or install the engine SDK and never attempts reset.
    const binary = previewOnly ? join(profileDir, "unavailable-opencode") : process.env.OPENWORK_EVAL_COWORKER_OPENCODE_BINARY || "opencode";
    const env = {
      ...process.env, ...cleared, HOME: join(profileDir, "home"),
      XDG_CONFIG_HOME: join(profileDir, "xdg-config"), XDG_DATA_HOME: join(profileDir, "xdg-data"),
      XDG_CACHE_HOME: join(profileDir, "xdg-cache"), XDG_STATE_HOME: join(profileDir, "xdg-state"),
      OPENCODE_DB: join(profileDir, "opencode.db"),
    };
    if (!previewOnly && sdk) {
      const version = (await promisify(execFile)(binary, ["--version"], { env, timeout: 10_000 })).stdout.trim();
      const manifest: unknown = JSON.parse(await readFile(join(sdk, "node_modules/@opencode-ai/plugin/package.json"), "utf8"));
      if (!manifest || typeof manifest !== "object" || !("version" in manifest) || manifest.version !== version) throw new Error(`Cached SDK does not match engine ${version}; no install or app launch was attempted.`);
      for (const directory of [join(profileDir, "xdg-config/opencode"), join(profileDir, "opencode-config")]) {
        await mkdir(directory, { recursive: true });
        await cp(join(sdk, "node_modules"), join(directory, "node_modules"), { recursive: true, dereference: true, mode: constants.COPYFILE_FICLONE });
      }
    }
    await writeFile(join(profileDir, "credential-sentinel.json"), JSON.stringify({ key: "UNRELATED-FIXTURE-CREDENTIAL" }), { mode: 0o600 });
    const repoRoot = new URL("../../", import.meta.url).pathname;
    const sourceFiles = [
      ...(await readdir(join(repoRoot, "apps/coworker/electron"))).filter((name) => name.endsWith(".mjs") && !name.endsWith(".test.mjs") && !name.endsWith(".fixture.mjs")).map((name) => `apps/coworker/electron/${name}`),
      "apps/coworker/dist/index.html",
      ...(await readdir(join(repoRoot, "apps/coworker/dist/assets"))).filter((name) => /\.(js|css)$/.test(name)).map((name) => `apps/coworker/dist/assets/${name}`),
      "evals/worlds/coworker.ts", "evals/specs/open-coworker-local-first.e2e.test.ts",
      "evals/packages/hosts/src/coworker.ts", "evals/packages/hosts/src/local.ts",
    ];
    const files = Object.fromEntries(await Promise.all(sourceFiles.sort().map(async (file) => [file, createHash("sha256").update(await readFile(join(repoRoot, file))).digest("hex")])));
    const head = (await promisify(execFile)("git", ["rev-parse", "HEAD"], { cwd: repoRoot })).stdout.trim();
    await writeFile(join(profileDir, "source-fingerprint.json"), JSON.stringify({ head, files }, null, 2), { mode: 0o600 });
    const app = await coworker({ name: "fresh-start", profileDir, env: {
      ...cleared,
      OPENWORK_EVAL_ELECTRON_ENTRY: new URL("../../apps/coworker/electron/main.mjs", import.meta.url).pathname,
      COWORKER_USER_DATA_DIR: join(owned, "electron-userdata"),
      COWORKER_HOME_DIR: join(owned, "coworkers"),
      COWORKER_SERVER_CONFIG: join(owned, "coworker-server.json"),
      OPENWORK_RUNTIME_DB: join(owned, "coworker-runtime.sqlite"),
      OPENWORK_ENV_STORE: join(owned, "coworker-env.json"),
      OPENWORK_DATA_DIR: join(profileDir, "openwork-data"),
      OPENWORK_SERVER_STATE_PATH: join(profileDir, "server-state.json"),
      OPENWORK_SERVER_TOKEN_STORE_PATH: join(profileDir, "server-tokens.json"),
      OPENWORK_SERVER_LOG_FILE: join(profileDir, "server.log"),
      OPENWORK_OPENCODE_BIN: binary,
      OPENWORK_DEV_MODE: "1", OPENWORK_ELECTRON_DISABLE_PROTOCOL_REGISTRATION: "1",
      OPENWORK_ELECTRON_USE_MOCK_KEYCHAIN: "1",
      COWORKER_DEN_BASE_URL: modelUrl,
      OPENCODE_DB: join(profileDir, "opencode.db"),
      OPENCODE_CONFIG_DIR: join(profileDir, "opencode-config"),
      CODEX_HOME: join(profileDir, "codex"), CLAUDE_CONFIG_DIR: join(profileDir, "claude"),
      OLLAMA_HOST: "127.0.0.1:9", LMSTUDIO_HOST: "127.0.0.1:9",
      OPENCODE_DISABLE_DEFAULT_PLUGINS: "1", OPENCODE_DISABLE_INSTALL: "1",
      OPENCODE_CONFIG_CONTENT: JSON.stringify({ enabled_providers: ["eval-reset"], provider: {
        "eval-reset": { npm: "@ai-sdk/openai-compatible", name: "Reset fixture", options: { baseURL: `${modelUrl}/v1`, apiKey: "fixture-only" }, models: { "stub-small": { name: "Reset fixture", tool_call: true } } },
      } }),
    } });
    const invoke = (command: string, payload: unknown = {}) => evaluate(app.client,
      browserScript((command, payload) => window.__COWORKER__.invoke(command, payload), [command, payload]),
      { awaitPromise: true, timeoutMs: 90_000 });
    const history = () => {
      const db = new DatabaseSync(join(profileDir, "opencode.db"), { readOnly: true });
      try { return db.prepare("SELECT id, directory FROM session ORDER BY id").all(); }
      finally { db.close(); }
    };
    const credentials = async () => {
      const nativeAuth: unknown = JSON.parse(await readFile(join(profileDir, "xdg-data/opencode/auth.json"), "utf8"));
      const db = new DatabaseSync(join(profileDir, "opencode.db"), { readOnly: true });
      try { return { database: db.prepare("SELECT * FROM credential").all(), nativeAuth }; }
      finally { db.close(); }
    };
    const seedUnrelatedHistory = () => {
      const db = new DatabaseSync(join(profileDir, "opencode.db"));
      try {
        const row = db.prepare("SELECT * FROM session LIMIT 1").get();
        if (!row) throw new Error("Create a real conversation before seeding the unrelated history control.");
        const other = { ...row, id: "ses_fresh_start_unrelated", directory: join(profileDir, "unrelated-project"), parent_id: null, slug: "fresh-start-unrelated" };
        const columns = Object.keys(other);
        db.prepare(`INSERT INTO session (${columns.map((key) => `"${key}"`).join(",")}) VALUES (${columns.map(() => "?").join(",")})`).run(...Object.values(other));
      } finally { db.close(); }
    };
    const seedAccountStorage = () => evaluateOnSurface(app, browserScript((baseUrl) => {
      localStorage.setItem("coworker.den.session.v1", JSON.stringify({ baseUrl, token: "reset-fixture-session", userName: "Fixture member", userEmail: "fixture@example.test", orgId: "org_reset_fixture", orgName: "Reset fixture" }));
      location.reload();
      return true;
    }, [modelUrl]));
    return { app, profileDir, invoke, history, credentials, seedUnrelatedHistory, seedAccountStorage, async [Symbol.asyncDispose]() {
      await app.stop();
      // Retain this disposable reset receipt, backup, and log for diagnosis.
      console.log(`Isolated Fresh start receipt root: ${profileDir}`);
    } };
  } catch (error) {
    await rm(profileDir, { recursive: true, force: true });
    throw error;
  }
}

// Three independent MP3 frames repeated for 2.16 seconds (660 Hz tone, not speech).
// ffmpeg -f lavfi -i sine=frequency=660:sample_rate=8000:duration=0.072 -c:a libmp3lame -b:a 8k -reservoir 0 -write_xing 0 -id3v2_version 0 -f mp3
export const voiceMp3 = Buffer.concat(Array.from({ length: 10 }, () => Buffer.from(
  "/+MYxAAMgAbeWUEAApJJCKNtgBg+D4P4IAg6XB8/ggCH2A+D5/ggc/5cENQJn8Tgg6oEw/kwQ1AM/pDHL+7pTEFNRTMuMTAw"
  + "/+MYxAAOEPaoAYbIAKo6f/7vYkjRL/+MuyRpEA//7EZNQ8kMFlRa5rX0M4CECKa9nTwgZuSbi8zLaXK1W2d5QMZURBUFUxBA"
  + "/+MYxAAOuO6cAcwQAZta1rWtata1rWta2ta1rWtata1rVlatXLly46MhCBICRNYJQNgbA2EYnGQCAgICAgoKFBQUFBIKCgoK", "base64")));

/** Read-result shapes at the native IPC type boundary; never installs or replaces the bridge. */
export interface CoworkerTestBridge {
  invoke(command: "runtime.info"): Promise<{ ok: boolean; result: { serverUrl: string; ownerToken: string } }>;
  invoke(command: "coworkers.get", payload: { slug: string }): Promise<{ ok: boolean; result: { model: string; workspaceId: string } }>;
  invoke(command: "coworkers.list"): Promise<{ ok: boolean; result: Array<{ slug: string; name: string; model: string; automations: unknown[] }> }>;
  invoke(command: "coworkers.files.read", payload: { slug: string; path: string }): Promise<{ ok: boolean; result: { content: string } }>;
  invoke(command: string, payload?: unknown): Promise<unknown>;
}

declare global {
  interface Window {
    __coworkerVoiceCapture: {
      calls: number;
      tracks: MediaStreamTrack[];
      clicks: Array<{ control: string; trusted: boolean; active: boolean }>;
      playback: Array<{ node: AudioBufferSourceNode; context: AudioContext; started: number | null; ended: number | null; stopped: boolean; disconnected: boolean; destination: boolean }>;
    };
  }
}

/** Observe real capture; do not replace the bridge, grant permissions, or fabricate a stream. */
export async function observeCoworkerVoice(app: Surface) {
  function install() {
    const witness: Window["__coworkerVoiceCapture"] = { calls: 0, tracks: [], clicks: [], playback: [] };
    window.__coworkerVoiceCapture = witness;
    document.addEventListener("click", (event) => {
      const control = event.target instanceof Element ? event.target.closest<HTMLElement>('[data-testid^="voice-"]') : null;
      if (control?.dataset.testid) witness.clicks.push({ control: control.dataset.testid, trusted: event.isTrusted, active: navigator.userActivation.isActive });
    }, true);
    if (navigator.mediaDevices?.getUserMedia) {
      const capture = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
      navigator.mediaDevices.getUserMedia = async (constraints) => {
        witness.calls++;
        const stream = await capture(constraints);
        witness.tracks.push(...stream.getTracks());
        return stream;
      };
    }
    const createSource = AudioContext.prototype.createBufferSource;
    AudioContext.prototype.createBufferSource = function () {
      const node = createSource.call(this);
      const entry: Window["__coworkerVoiceCapture"]["playback"][number] = { node, context: this, started: null, ended: null, stopped: false, disconnected: false, destination: false };
      witness.playback.push(entry);
      const start = node.start.bind(node);
      const stop = node.stop.bind(node);
      const connect = node.connect.bind(node);
      const disconnect = node.disconnect.bind(node);
      node.start = (...args) => { start(...args); entry.started = this.currentTime; };
      node.stop = (...args) => { stop(...args); entry.stopped = true; };
      // The product connects a BufferSource to this context's real destination.
      node.connect = ((destination: AudioNode) => { entry.destination = destination === this.destination; return connect(destination); }) as typeof node.connect;
      node.disconnect = () => { disconnect(); entry.disconnected = true; };
      node.addEventListener("ended", () => { entry.ended = this.currentTime; }, { once: true });
      return node;
    };
  }
  const registration = await addInitScript(app.client, install);
  await evaluateOnSurface(app, install);
  return {
    read: () => evaluateOnSurface(app, () => ({
      calls: window.__coworkerVoiceCapture.calls,
      tracks: window.__coworkerVoiceCapture.tracks.map((track) => ({ kind: track.kind, state: track.readyState })),
      clicks: window.__coworkerVoiceCapture.clicks,
      playback: window.__coworkerVoiceCapture.playback.map(({ node, context, started, ended, stopped, disconnected, destination }) => ({
        started, ended, stopped, disconnected, destination, state: context.state,
        progress: started === null ? 0 : context.currentTime - started,
        duration: node.buffer?.duration ?? 0,
        hasSignal: node.buffer?.getChannelData(0).some((value) => Math.abs(value) > 0.001) ?? false,
      })),
      supported: Boolean(navigator.mediaDevices?.getUserMedia) && typeof MediaRecorder !== "undefined"
        && ["audio/webm;codecs=opus", "audio/webm", "audio/mp4;codecs=mp4a.40.2", "audio/mp4"].some((mime) => MediaRecorder.isTypeSupported(mime)),
      // Native Node fetch is not a renderer resource. A direct renderer voice request is a regression.
      rendererVoiceRequests: performance.getEntriesByType("resource").filter((entry) => /\/v1\/voice(?:\/|$)/.test(entry.name)).length,
    })),
    [Symbol.asyncDispose]: () => registration.dispose(),
  };
}
