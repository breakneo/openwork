import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createTeamSessionRegistry } from "./team-sessions.mjs";
import { assertTeamCompatibleHomes, teamWorkspacePlan, updateTeamWorkspaceConfig } from "./team-workspace.mjs";
import { createCoworker, readHomeContext, HOME_CONTEXT_FILE_LIMIT } from "./coworkers.mjs";
import { nativeTurnAgent, NATIVE_TURN_ROLES, NATIVE_COORDINATOR_AGENT } from "./native-turns.mjs";
import { COMPUTER_DENY } from "./computer-control.mjs";
import { EVENT_WRITE_DENY, EVENT_SCHEDULE_DENY } from "./event-execution.mjs";
import { workerTurnTools } from "./workers.mjs";

test("host bindings survive reload, reject reassignment and validate the current admitted role and model", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "team-bindings-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const owner = { slug: "alpha", createdAt: "2026-01-01T00:00:00.000Z" };
  let current = owner;
  let entry = { id: "execution-1", owner: { slug: owner.slug, threadId: "ses_first", kind: "private" }, coworkerCreatedAt: owner.createdAt,
    messageId: "msg_first", workspaceId: "ws_team", agent: "coworker-alpha", model: { providerId: "fixture", modelId: "one" }, state: "running" };
  const options = { file: path.join(root, "owners.json"), coworkerFor: async () => current, executionFor: async () => entry };
  const registry = createTeamSessionRegistry(options);
  const binding = { ...owner, sessionId: "ses_first", workspaceId: "ws_team", directory: root, kind: "unassigned" };
  await registry.bind(binding);
  await registry.classify(binding.sessionId, owner, "private");
  await assert.rejects(registry.classify(binding.sessionId, owner, "group"), /cannot be reassigned/);
  const reloaded = createTeamSessionRegistry(options);
  assert.equal((await reloaded.resolve(binding.sessionId, owner)).kind, "private");
  const context = { sessionID: "ses_first", directory: root, agent: "coworker-alpha", model: { providerID: "fixture", id: "one" } };
  assert.equal((await reloaded.context(context)).entry.id, "execution-1");
  await assert.rejects(reloaded.context({ ...context, agent: "coworker-beta" }), /admitted native execution/);
  await assert.rejects(reloaded.context({ ...context, model: { providerID: "fixture", id: "other" } }), /admitted native execution/);
  await assert.rejects(reloaded.context({ ...context, directory: path.join(root, "other") }), /location/);
  await assert.rejects(reloaded.context({ ...context, sessionID: "ses_foreign", slug: "alpha" }), /host owner/);
  entry = { ...entry, id: "execution-2", agent: "coworker-alpha:worker" };
  assert.equal((await reloaded.context({ ...context, agent: entry.agent })).binding.slug, "alpha");
  entry = { ...entry, state: "succeeded" };
  await assert.rejects(reloaded.context({ ...context, agent: entry.agent }), /admitted native execution/);
  const original = await readFile(options.file, "utf8");
  current = { ...owner, createdAt: "replacement" };
  await assert.rejects(reloaded.resolve(binding.sessionId), /replaced coworker/);
  assert.equal((await reloaded.cleanupBinding(binding.sessionId)).createdAt, owner.createdAt);
  await assert.rejects(reloaded.cleanupBinding("ses_foreign"), /original host session binding/);
  assert.equal(await readFile(options.file, "utf8"), original);
});

test("team planning never deletes legacy descriptors and custom policies fail closed without rewriting homes", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "team-policy-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const coworker = await createCoworker(root, { name: "Alpha" });
  const workspaces = [{ id: "ws_legacy", path: coworker.path, workspaceType: "local" }];
  const before = structuredClone(workspaces);
  assert.deepEqual(teamWorkspacePlan({ coworkersDir: root, workspaces }).legacy, [{ id: "ws_legacy", path: coworker.path }]);
  assert.deepEqual(workspaces, before);
  await assertTeamCompatibleHomes([coworker]);
  const target = path.join(coworker.path, "opencode.json");
  const bytes = JSON.stringify({ permissions: [{ action: "shell", resource: "*", effect: "deny" }] });
  await writeFile(target, bytes);
  assert.deepEqual((await assertTeamCompatibleHomes([coworker]))[0].nativePermissions, JSON.parse(bytes).permissions);
  assert.equal(await readFile(target, "utf8"), bytes);
  await updateTeamWorkspaceConfig(root, [coworker]);
  const plan = teamWorkspacePlan({ coworkersDir: root, workspaces });
  assert.equal(plan.directory, path.join(root, ".runtime"));
  await assert.rejects(readFile(path.join(root, "opencode.json")), { code: "ENOENT" });
  const shared = JSON.parse(await readFile(path.join(plan.directory, "opencode.json"), "utf8"));
  assert.ok(shared.agents["coworker-owner-alpha"].system.includes(coworker.path));
  assert.equal(await readFile(target, "utf8"), bytes);
  await writeFile(target, JSON.stringify({ permissions: JSON.parse(bytes).permissions, providers: { custom: {} } }));
  await assert.rejects(assertTeamCompatibleHomes([coworker]), /per-owner compatibility for providers/);
  const soul = path.join(coworker.path, "soul.md");
  await writeFile(soul, "x".repeat(HOME_CONTEXT_FILE_LIMIT * 2));
  assert.ok((await readHomeContext(root, coworker.slug)).length < HOME_CONTEXT_FILE_LIMIT + 10_000);
  await rm(soul);
  const foreign = path.join(root, "foreign.md");
  await writeFile(foreign, "FOREIGN_PRIVATE_RECORD");
  await symlink(foreign, soul);
  await assert.rejects(readHomeContext(root, coworker.slug), /original home/);
});

test("native turn roles accept only exact finite masks and never override an admitted agent pin", () => {
  assert.equal(nativeTurnAgent(), "build");
  assert.equal(nativeTurnAgent({ tools: null, agent: "progress-summary" }), "progress-summary");
  assert.equal(nativeTurnAgent({ tools: COMPUTER_DENY, agent: NATIVE_COORDINATOR_AGENT }), NATIVE_COORDINATOR_AGENT);
  for (const role of NATIVE_TURN_ROLES) {
    const tools = Object.fromEntries(Object.entries(role.tools).reverse());
    assert.equal(nativeTurnAgent({ tools }), role.id);
    assert.equal(nativeTurnAgent({ tools, agent: role.id }), role.id);
    assert.equal(nativeTurnAgent({ agent: role.id }), role.id);
    assert.ok(role.permissions.every((rule) => rule.effect === "deny"));
    assert.throws(() => nativeTurnAgent({ tools, agent: "custom-agent" }), /conflicting agent pin/);
    assert.throws(() => nativeTurnAgent({ tools: { ...tools, unknown: false } }), /Unsupported/);
  }
  for (const tools of [{ question: false }, { "*": false }, { coworker_react: false }, { ...COMPUTER_DENY, coworker_react: true }, { coworker_computer_act: true }, { ...COMPUTER_DENY, coworker_browser_tabs: true }, [], true, Object.create({ task: false })]) {
    assert.throws(() => nativeTurnAgent({ tools }), /Unsupported/);
  }
  assert.throws(() => nativeTurnAgent({ tools: COMPUTER_DENY, agent: "coworker-worker-computer" }), /conflicting agent pin/);
  for (const [suffix, policy] of [["", {}], ["-event-read-only", EVENT_WRITE_DENY], ["-schedule-read-only", EVENT_SCHEDULE_DENY]]) {
    const workerSuffix = suffix === "-schedule-read-only" ? "-event-read-only" : suffix;
    for (const [id, base] of [
      ["coworker", {}], ["coworker-no-computer", COMPUTER_DENY],
      ["coworker-no-referral", { coworker_team_refer: false }],
      ["coworker-group", { ...COMPUTER_DENY, coworker_team_refer: false }],
      ["coworker-worker", workerTurnTools()], ["coworker-worker-browser", workerTurnTools("browser")],
      ["coworker-worker-computer", workerTurnTools("computer")],
    ]) {
      if (id !== "coworker" || suffix) assert.equal(nativeTurnAgent({ tools: { ...base, ...policy } }), id + (id.startsWith("coworker-worker") ? workerSuffix : suffix));
      if (["coworker-no-referral", "coworker-group"].includes(id)) for (const conclude of [false, true]) {
        const tools = { ...base, ...policy, coworker_event_conclude: conclude };
        const role = id + suffix + (conclude ? "-conclusion" : "-no-conclusion");
        assert.equal(nativeTurnAgent({ tools }), role);
        assert.equal(nativeTurnAgent({ tools, agent: role }), role);
      }
    }
    const tools = { ...COMPUTER_DENY, ...policy, coworker_react: false };
    const id = "coworker-no-computer-no-reactions" + suffix;
    const role = NATIVE_TURN_ROLES.find((role) => role.id === id);
    assert.ok(role);
    assert.deepEqual(role.tools, tools);
    assert.equal(nativeTurnAgent({ tools }), id);
    assert.equal(nativeTurnAgent({ tools, agent: id }), id);
    assert.equal(nativeTurnAgent({ agent: id }), id);
    for (const action of Object.keys(tools)) assert.ok(role.permissions.some((rule) => rule.action === action && rule.effect === "deny"));
    for (const masked of [tools, { ...COMPUTER_DENY, ...policy }]) {
      assert.equal(nativeTurnAgent({ tools: masked, agent: NATIVE_COORDINATOR_AGENT }), NATIVE_COORDINATOR_AGENT);
    }
    assert.throws(() => nativeTurnAgent({ tools, agent: "coworker-no-computer" + suffix }), /conflicting agent pin/);
    assert.throws(() => nativeTurnAgent({ tools: { ...tools, unknown: false }, agent: NATIVE_COORDINATOR_AGENT }), /Unsupported/);
    assert.throws(() => nativeTurnAgent({ tools: { ...tools, coworker_react: true }, agent: NATIVE_COORDINATOR_AGENT }), /Unsupported/);
    for (const control of [undefined, "browser", "computer"]) {
      const workerTools = { ...workerTurnTools(control), ...policy };
      const workerId = "coworker-worker" + (control ? "-" + control : "") + workerSuffix;
      assert.equal(workerTools.coworker_react, false);
      assert.equal(nativeTurnAgent({ tools: workerTools }), workerId);
      assert.ok(NATIVE_TURN_ROLES.find((role) => role.id === workerId).permissions.some((rule) => rule.action === "coworker_react" && rule.effect === "deny"));
      assert.throws(() => nativeTurnAgent({ tools: workerTools, agent: NATIVE_COORDINATOR_AGENT }), /Unsupported/);
    }
  }
  for (const policy of [EVENT_WRITE_DENY, EVENT_SCHEDULE_DENY]) {
    assert.equal(nativeTurnAgent({ tools: { ...COMPUTER_DENY, ...policy }, agent: NATIVE_COORDINATOR_AGENT }), NATIVE_COORDINATOR_AGENT);
    for (const control of [undefined, "browser", "computer"]) {
      const tools = { ...workerTurnTools(control), ...policy };
      const role = NATIVE_TURN_ROLES.find((role) => role.id === nativeTurnAgent({ tools }));
      for (const action of Object.keys(policy)) assert.ok(role.permissions.some((rule) => rule.action === action && rule.effect === "deny"));
      assert.ok(role.permissions.some((rule) => rule.action === "subagent" && rule.effect === "deny"));
    }
    for (const conclude of [false, true]) {
      const tools = { ...COMPUTER_DENY, coworker_team_refer: false, coworker_event_conclude: conclude, ...policy };
      const role = NATIVE_TURN_ROLES.find((role) => role.id === nativeTurnAgent({ tools }));
      assert.equal(role.permissions.some((rule) => rule.action === "coworker_event_conclude"), !conclude);
      assert.ok(role.permissions.every((rule) => rule.effect === "deny"));
      assert.throws(() => nativeTurnAgent({ tools, agent: "coworker-group" }), /conflicting agent pin/);
    }
  }
});
