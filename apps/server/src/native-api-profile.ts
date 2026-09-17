import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { isAbsolute } from "node:path";
import { resolveOpencodeV2Version } from "./opencode-v2-binary.js";
import type { EmbeddedOpencodeV2Options } from "./types.js";

export type NativeApiContract = "beta19271" | "native-2";
export type NativeSourceBuild = { version: string; sha256: string };

export function nativeHostVersion(options?: EmbeddedOpencodeV2Options, bin?: string): string {
  const source = options?.sourceBuild;
  if (!source) {
    if (options?.apiContract === "native-2") throw new Error("The native-2 development profile requires a verified source build.");
    return resolveOpencodeV2Version(options?.version);
  }
  if (options?.version !== undefined || options.apiContract !== "native-2" || !bin || !isAbsolute(bin)
    || !/^0\.0\.0-local-[A-Za-z0-9.-]+$/.test(source.version) || !/^[a-f0-9]{64}$/.test(source.sha256)) {
    throw new Error("A native source profile requires an explicit executable, local version, SHA-256 and native-2 API contract; it is not a release pin.");
  }
  return source.version;
}

export async function verifyNativeSourceBuild(options: EmbeddedOpencodeV2Options | undefined, bin: string): Promise<void> {
  nativeHostVersion(options, bin);
  if (!options?.sourceBuild) return;
  const hash = createHash("sha256");
  for await (const bytes of createReadStream(bin)) hash.update(bytes);
  if (hash.digest("hex") !== options.sourceBuild.sha256) throw new Error("Native source executable failed its host-supplied SHA-256 check.");
}

export function nativeProviderPackage(value: string | undefined, contract: NativeApiContract = "beta19271"): string {
  const selected = value ?? "@opencode-ai/ai/providers/openai-compatible";
  return contract === "native-2" && selected.startsWith("@opencode-ai/ai/providers/") ? selected.replace("@opencode-ai/ai/", "@opencode/ai/") : selected;
}

export function nativeProxyPolicyPath(path: string, contract: NativeApiContract = "beta19271"): string {
  const decoded = decodeURIComponent(path);
  return contract === "native-2"
    ? decoded.replace(/^((?:\/opencode2)?\/api)\/experimental\/(config$|mcp(?:\/|$)|session\/ses_[A-Za-z0-9_-]+(?:\/|$))/, "$1/$2")
    : decoded;
}

export function nativeMcpMutationPath(name: string, contract: NativeApiContract = "beta19271"): string {
  return `/api/${contract === "native-2" ? "experimental/" : ""}mcp/${encodeURIComponent(name)}`;
}

export function nativeInstructionPath(sessionId: string, key: string, contract: NativeApiContract = "beta19271"): string {
  return `/api/${contract === "native-2" ? "experimental/" : ""}session/${encodeURIComponent(sessionId)}/instructions/entries/${encodeURIComponent(key)}`;
}

export async function awaitNativePlugins(
  request: (path: string, init?: { method?: string; directory?: string; timeoutMs?: number }) => Promise<{ status: number; json: unknown }>,
  directory: string,
  contract: NativeApiContract = "beta19271",
): Promise<void> {
  if (contract === "beta19271") {
    const activated = await request("/api/plugin/await-activation", { method: "POST", directory, timeoutMs: 30_000 });
    if (activated.status !== 204) throw new Error("OpenCode v2 plugin activation did not settle");
  }
  const deadline = Date.now() + 30_000;
  do {
    const response = await request("/api/plugin", { directory, timeoutMs: 5_000 });
    const payload = response.json;
    const entries = payload && typeof payload === "object" && "data" in payload ? payload.data : undefined;
    if (response.status !== 200 || !Array.isArray(entries)) throw new Error("OpenCode v2 plugin inventory is unavailable");
    const statuses = entries.map((entry: unknown) => entry && typeof entry === "object" && "state" in entry && entry.state && typeof entry.state === "object" && "status" in entry.state ? entry.state.status : undefined);
    if (statuses.every((status) => status === "active")) return;
    if (contract === "beta19271" || statuses.some((status) => status === "failed")) throw new Error("OpenCode v2 has an inactive or failed configured plugin");
    await new Promise((resolve) => setTimeout(resolve, 100));
  } while (Date.now() < deadline);
  throw new Error("OpenCode v2 plugin activation did not settle");
}
