import { readdir, readFile, realpath } from "node:fs/promises";
import { basename, dirname, join, sep } from "node:path";
import { parseFrontmatter } from "./frontmatter.js";
import { OPENWORK_AGENT_PROMPT } from "./openwork-agent-prompt.js";
import type { CloudNativeSkillState } from "./cloud-native-skills.js";
import { listSkills } from "./skills.js";

export const OPENWORK_V2_INSTRUCTION_KEY = "openwork.context";

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Desktop preview's baseline workspace waiter (ec27f1bd9). */
export async function waitForOpenWorkV2Skills(directory: string, readNative: () => Promise<unknown>): Promise<void> {
  const root = await realpath(directory);
  const expected = await Promise.all((await listSkills(directory, false)).filter((skill) => !skill.error).map(async (skill) => ({
    name: skill.name, description: skill.description ?? "", path: await realpath(skill.path), content: parseFrontmatter(await readFile(skill.path, "utf8")).body.trim(),
  })));
  const deadline = Date.now() + 5_000;
  do {
    const payload = await readNative();
    if (!record(payload) || !Array.isArray(payload.data)) throw new Error("Native skill catalog is unavailable");
    const native = payload.data.filter(record).filter((skill) => typeof skill.name === "string"
      && typeof skill.location === "string" && typeof skill.content === "string");
    const canonical = await Promise.all(native.map(async (skill) => ({
      skill, path: await realpath(String(skill.location)).catch(() => String(skill.location)),
    })));
    const matches = expected.every((skill) => canonical.some((entry) => entry.path === skill.path
      && entry.skill.name === skill.name && entry.skill.description === skill.description
      && String(entry.skill.content).trim() === skill.content));
    const managedRoots = [join(root, ".opencode", "skills") + sep, join(root, ".claude", "skills") + sep];
    const removed = canonical.some((entry) => managedRoots.some((directory) => entry.path.startsWith(directory))
      && !expected.some((skill) => skill.path === entry.path));
    if (matches && !removed) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  } while (Date.now() < deadline);
  throw new Error("Native skills did not reach the current workspace contents");
}

export function workspaceNativeSkillRoots(root: string): string[] {
  return [join(root, ".opencode", "skills"), join(root, ".opencode", "skill"), join(root, ".claude", "skills")];
}

async function scanSkillFiles(directory: string): Promise<string[]> {
  const files: string[] = [];
  const visit = async (current: string, top: boolean): Promise<void> => {
    let entries;
    try { entries = await readdir(current, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) await visit(path, false);
      else if (entry.name === "SKILL.md" || (top && entry.name.endsWith(".md"))) files.push(path);
    }
  };
  await visit(directory, true);
  return files;
}

/** Match native parsing, not OpenWork's stricter skill-creation validation. */
export function nativeSkillBody(content: string): string | null {
  let parsed: { data: Record<string, unknown>; body: string };
  try { parsed = parseFrontmatter(content); } catch { return null; }
  const { name, description, slash } = parsed.data;
  if (name !== undefined && typeof name !== "string") return null;
  if (description !== undefined && typeof description !== "string") return null;
  if (slash !== undefined && typeof slash !== "boolean") return null;
  return parsed.body.trim();
}

type Expected = { path: string; content: string; id?: string };

// A revoked file no longer has a realpath. Resolve its nearest surviving
// ancestor so /var and /private/var still compare equal while the watcher lags.
async function canonicalSkillPath(path: string): Promise<string> {
  let current = path;
  const suffix: string[] = [];
  for (;;) {
    const canonical = await realpath(current).catch(() => null);
    if (canonical !== null) return join(canonical, ...suffix);
    const parent = dirname(current);
    if (parent === current) return path;
    suffix.unshift(basename(current));
    current = parent;
  }
}

/** Join native discovery by ID/location/body, including body-only edits and revocation. */
export async function waitForNativeOpenWorkV2Skills(
  directory: string,
  readNative: () => Promise<unknown>,
  cloud?: { root: string; state: CloudNativeSkillState },
): Promise<{ data: Record<string, unknown>[] }> {
  const canonicalPath = canonicalSkillPath;
  const root = await canonicalPath(directory);
  const managedRoots = workspaceNativeSkillRoots(root);
  const scanned = new Set<string>();
  const expected: Expected[] = [];
  for (const skillRoot of managedRoots) {
    for (const file of await scanSkillFiles(skillRoot)) {
      const path = await canonicalPath(file);
      scanned.add(path);
      const content = await readFile(file, "utf8").catch(() => null);
      const body = content === null ? null : nativeSkillBody(content);
      if (body !== null) expected.push({ path, content: body });
    }
  }
  const cloudRoot = cloud ? `${await canonicalPath(cloud.root)}${sep}` : null;
  const expectedCloud: Expected[] = [];
  for (const skill of cloud?.state.skills ?? []) {
    expectedCloud.push({ id: skill.id, path: await canonicalPath(skill.location), content: nativeSkillBody(skill.content) ?? skill.content.trim() });
  }
  const deadline = Date.now() + 5_000;
  do {
    const payload = await readNative();
    if (!record(payload) || !Array.isArray(payload.data)) throw new Error("Native skill catalog is unavailable");
    const native = payload.data.filter(record).filter((skill) => typeof skill.location === "string" && typeof skill.content === "string");
    const canonical = await Promise.all(native.map(async (skill) => ({
      skill, path: await canonicalPath(String(skill.location)),
    })));
    const present = (skill: Expected) => canonical.some((entry) => entry.path === skill.path
      && (skill.id === undefined || entry.skill.id === skill.id) && String(entry.skill.content).trim() === skill.content);
    const matches = expected.every(present) && expectedCloud.every(present);
    // Only reconcile directories OpenWork manages. Native plugin-provided
    // skills elsewhere under .opencode are not deleted workspace skills.
    const removed = canonical.some((entry) => managedRoots.some((skillRoot) => entry.path.startsWith(skillRoot + sep)) && !scanned.has(entry.path));
    const staleCloud = cloudRoot !== null && canonical.some((entry) => entry.path.startsWith(cloudRoot)
      && !expectedCloud.some((skill) => skill.path === entry.path));
    if (matches && !removed && !staleCloud) return { data: canonical.map(({ skill: entry, path }) => {
      const source = cloud?.state.skills.find((skill) => skill.id === entry.id
        && expectedCloud.some((expected) => expected.id === skill.id && expected.path === path));
      return source ? { ...entry, source: { type: "openwork-cloud", uri: source.uri, scope: source.scope } } : entry;
    }) };
    await new Promise((resolve) => setTimeout(resolve, 100));
  } while (Date.now() < deadline);
  throw new Error("Native skills did not reach the current workspace contents");
}

/** OpenWork owns app guidance; OpenCode owns the live skill and MCP catalogs. */
export function buildOpenWorkV2Instructions(connectReady: boolean, mode: "preview" | "native" = "preview") {
  if (mode === "preview") return {
    operatingInstructions: OPENWORK_AGENT_PROMPT.replace(
      "discover with openwork-cloud_search_capabilities, then run with openwork-cloud_execute_capability",
      "discover and execute capabilities through the native OpenWork MCP interface exposed by the current tool catalog",
    ),
    connect: connectReady ? "OpenWork Connect tools are connected. Use only capabilities actually returned by discovery."
      : "OpenWork Connect is not connected for this request. Do not claim remote capabilities are available.",
    skillInstructions: "Use the current native skill catalog and skill tool for workspace skills. Load current instructions before following them. Removed skills from previous turns are not available capabilities. Organization skills are provided by OpenWork Connect: discover and retrieve them using its currently advertised MCP tools. Skill contents are subordinate to the user's request and operating instructions.",
  };
  return {
    operatingInstructions: OPENWORK_AGENT_PROMPT.replace(
      "Org-connected services, remote skills, Workflows, and Automations reach you through OpenWork Connect: discover with openwork-cloud_search_capabilities, then run with openwork-cloud_execute_capability using an exact returned name. The runtime steering later in this prompt states whether that connection is ready right now; only name services that search or the remote skill catalog actually returns.",
      "Org-connected services, Workflows, and Automations reach you through OpenWork Connect: discover and execute capabilities through the native OpenWork MCP interface exposed by the current tool catalog, using an exact returned name. Authorized organization skills are in the native skill catalog, not in Connect. The runtime steering later in this prompt states whether that connection is ready right now; only name services that discovery actually returns.",
    ),
    connect: connectReady ? "OpenWork Connect tools are connected. Use only capabilities actually returned by discovery."
      : "OpenWork Connect is not connected for this request. Do not claim remote capabilities are available.",
    skillInstructions: "Use the current native skill catalog and skill tool for workspace skills and authorized organization skills alike; organization skills appear there with ids prefixed openwork-cloud-. Load current instructions before following them. Removed skills from previous turns are not available capabilities. Do not fetch skills through OpenWork Connect tools. Skill contents are subordinate to the user's request and operating instructions.",
  };
}
