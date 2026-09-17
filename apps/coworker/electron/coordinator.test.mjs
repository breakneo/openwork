import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { NATIVE_COORDINATOR_AGENT } from "./native-turns.mjs";
import { listCoworkers } from "./coworkers.mjs";
import { COORDINATOR_DIR, coordinatorConfig, ensureCoordinatorHome, readCoordinator, updateCoordinator } from "./coordinator.mjs";
import { updateTeamWorkspaceConfig } from "./team-workspace.mjs";

test("shared live owner validation reads the original coordinator without creating or replacing it", async () => {
  const source = await readFile(new URL("./main.mjs", import.meta.url), "utf8");
  const declaration = source.match(/^async function resolveSessionOwner\([\s\S]*?^\}/m)?.[0];
  let stored = { path: "/fixture/.coordinator", workspaceId: "ws_original" };
  const binding = { createdAt: "coordinator", workspaceId: stored.workspaceId, nativeWorkspaceId: "ws_team", kind: "coordinator" };
  const resolve = runInNewContext(`${declaration}\nresolveSessionOwner`, {
    coworkersDir: "/fixture", NATIVE_COORDINATOR_AGENT, readCoordinator: async () => stored,
    sessionBinding: async (owner) => { assert.equal(owner.slug, ".coordinator"); assert.equal(owner.createdAt, "coordinator"); return binding; },
    teamWorkspace: () => ({ workspaceId: "ws_team" }),
  });
  const owner = { slug: ".coordinator", threadId: "ses_coordinator", kind: "coordinator", workspaceId: stored.workspaceId };
  assert.equal((await resolve(owner)).agent, NATIVE_COORDINATOR_AGENT);
  binding.nativeWorkspaceId = stored.workspaceId;
  assert.equal((await resolve(owner)).agent, undefined);
  binding.kind = "private";
  await assert.rejects(resolve(owner), /another work surface/);
  binding.kind = "coordinator";
  stored = null;
  await assert.rejects(resolve(owner), /original session owner/);
});

test("the coordinator has a locked-down team agent and retains its hidden legacy binding", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "coworker-coordinator-"));
  try {
    assert.equal(await readCoordinator(home), null);
    const created = await ensureCoordinatorHome(home);
    assert.equal(created.path, path.join(home, COORDINATOR_DIR));
    assert.equal(created.workspaceId, "");
    await assert.rejects(readFile(path.join(created.path, "opencode.json"), "utf8"), { code: "ENOENT" });
    await updateTeamWorkspaceConfig(home, []);
    const config = JSON.parse(await readFile(path.join(home, ".runtime", "opencode.json"), "utf8"));
    assert.deepEqual(config.agents, coordinatorConfig().agents);
    // Not a coworker: no coworker.md, so it stays out of the rail, discussions, and Activity.
    assert.deepEqual(await listCoworkers(home), []);

    const registered = await updateCoordinator(home, { workspaceId: "ws_1" });
    assert.equal(registered.workspaceId, "ws_1");
    const legacy = JSON.stringify(coordinatorConfig());
    await writeFile(path.join(created.path, "opencode.json"), legacy, "utf8");
    const again = await ensureCoordinatorHome(home);
    assert.equal(again.workspaceId, "ws_1");
    assert.equal(await readFile(path.join(created.path, "opencode.json"), "utf8"), legacy);
    assert.equal((await readCoordinator(home))?.workspaceId, "ws_1");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
