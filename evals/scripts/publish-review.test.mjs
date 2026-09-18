import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { association, publishCompletedEvidence } from "./publish-review.mjs";

const repo = "sample-org/sample-project";
const repository = { id: 10, full_name: repo, name: "sample-project", owner: { login: "sample-org" } };
const sha = "1".repeat(40);
const workflows = [
  { id: 20, file: "ci-tests.yml", name: "Build and core checks", events: ["pull_request", "push"] },
  { id: 21, file: "daytona-e2e.yml", name: "Product journeys", events: ["workflow_run"] },
];
function run(id = 30, producer = workflows[0]) {
  return {
    id, run_attempt: 1, workflow_id: producer.id, path: `.github/workflows/${producer.file}`, name: producer.name,
    event: producer.events[0], status: "completed", conclusion: "success",
    repository, head_repository: repository, head_sha: sha,
    pull_requests: [{ number: 7, base: { repo: { id: 10 } }, head: { repo: { id: 10 }, sha } }],
  };
}
function harness(runs = [run()]) {
  const logs = [], downloads = [], publications = [];
  const current = { number: 7, state: "open", created_at: "2026-07-01T00:00:00Z", base: { repo: repository }, head: { repo: repository, sha } };
  const api = async (path) => {
    const workflow = workflows.find((item) => path.endsWith(`/workflows/${item.file}`));
    if (workflow) return { ...workflow, path: `.github/workflows/${workflow.file}` };
    if (path.endsWith("/pulls/7")) return current;
    const id = /\/actions\/runs\/(\d+)$/.exec(path)?.[1];
    if (id) return runs.find((item) => item.id === Number(id));
    if (path.includes("/artifacts?")) return { total_count: 1, artifacts: [{ expired: false }] };
    const workflowId = /\/workflows\/(\d+)\/runs\?/.exec(path)?.[1];
    if (workflowId) {
      const matches = runs.filter((item) => item.workflow_id === Number(workflowId));
      return { total_count: matches.length, workflow_runs: matches };
    }
    throw new Error(`Unexpected API path: ${path}`);
  };
  return {
    logs, downloads, publications, current,
    dependencies: {
      api, log: (message) => logs.push(message),
      required: async () => ({ state: "waiting", url: "https://github.com/sample-org/sample-project/actions/runs/31" }),
      binding: async (_repo, id) => ({ producer: runs.find(item => item.id === id), receipt: { pr: 7, sha } }),
      download: async (id, directory) => {
        downloads.push(id);
        await mkdir(directory, { recursive: true });
        await writeFile(join(directory, "test-run.json"), JSON.stringify({
          name: `Producer ${id}`, dir: directory, createdAt: "2026-07-02T00:00:00Z", closedAt: "2026-07-02T00:01:00Z", gitSha: sha,
          engine: "v1", branch: "test", artifacts: [], trace: [], steps: [], outcome: "passed",
          summary: { ok: true, totalArtifacts: 0, passedArtifacts: 0, failedArtifacts: 0, unvalidatedArtifacts: 0,
            pendingArtifacts: 0, passedExpectations: 0, failedExpectations: 0, pendingJudgments: 0 },
        }));
      },
      publish: async (options) => { publications.push(options); return { posted: true, urls: { report: "published" } }; },
    },
  };
}

test("external-base push association is skipped before looking up its PR number", async () => {
  const source = run();
  source.event = "push";
  source.pull_requests[0].base.repo.id = 99;
  const fixture = harness([source]);
  await publishCompletedEvidence({ repo, runId: 30 }, fixture.dependencies);
  assert.match(fixture.logs[0], /base or head repository identity mismatch/);
  assert.deepEqual(fixture.downloads, []);
});

test("missing, ambiguous, stale and invalid producer identities skip visibly", async () => {
  for (const change of [
    (source) => { source.pull_requests = []; },
    (source) => { source.pull_requests.push(source.pull_requests[0]); },
    (source) => { source.path = ".github/workflows/unknown.yml"; },
    (source) => { source.head_repository = { ...repository, owner: { login: "other-org" } }; },
    (source) => { source.head_sha = "2".repeat(40); },
  ]) {
    const source = run(); change(source);
    const fixture = harness([source]);
    await publishCompletedEvidence({ repo, runId: 30 }, fixture.dependencies);
    assert.match(fixture.logs[0], /skipped: .+; existing report unchanged/);
    assert.deepEqual(fixture.publications, []);
  }
  const fixture = harness();
  fixture.current.head.sha = "2".repeat(40);
  await publishCompletedEvidence({ repo, runId: 30 }, fixture.dependencies);
  assert.match(fixture.logs[0], /stale/);
});

test("chained producer PR arrays are not authority without an authenticated upstream binding", () => {
  const chained = run(31, workflows[1]);
  chained.head_sha = "2".repeat(40);
  assert.match(association(chained, repo, workflows).reason, /authenticated upstream binding/);
  chained.pull_requests = [];
  assert.match(association(chained, repo, workflows).reason, /authenticated upstream binding/);
});

test("later publication gathers all verified producers, excluding untrusted runs", async () => {
  const chained = run(31, workflows[1]);
  chained.head_sha = "2".repeat(40);
  const unrelated = run(32); unrelated.pull_requests[0].base.repo.id = 99;
  const fixture = harness([run(), chained, unrelated]);
  await publishCompletedEvidence({ repo, runId: 31 }, fixture.dependencies);
  assert.deepEqual(fixture.downloads, [30, 31]);
  assert.equal(fixture.publications[0].testRunDirs.length, 2);
  assert.equal(fixture.publications[0].automatic, true);
  assert.match(fixture.publications[0].gaps[0], /Required verification: waiting/);
});

test("unbound chained evidence cannot publish even with plausible artifact identities", async () => {
  const fixture = harness([run(31, workflows[1])]);
  fixture.dependencies.binding = async () => { throw new Error("unsupported chain"); };
  await publishCompletedEvidence({ repo, runId: 31 }, fixture.dependencies);
  assert.deepEqual(fixture.publications, []);
  assert.deepEqual(fixture.downloads, []);
});

test("bounded history, expired artifacts and changed producer/current PR fail closed", async () => {
  for (const condition of ["bound", "expired", "producer", "head"]) {
    const fixture = harness();
    const original = fixture.dependencies.api;
    let runReads = 0, prReads = 0;
    fixture.dependencies.api = async (path) => {
      const value = await original(path);
      if (condition === "bound" && path.includes("/runs?")) return { ...value, total_count: 501 };
      if (condition === "expired" && path.includes("/artifacts?")) return { total_count: 1, artifacts: [{ expired: true }] };
      if (condition === "producer" && path.endsWith("/runs/30") && ++runReads > 1) return { ...value, name: "Unknown" };
      if (condition === "head" && path.endsWith("/pulls/7") && ++prReads > 1) return { ...value, head: { ...value.head, sha: "2".repeat(40) } };
      return value;
    };
    await publishCompletedEvidence({ repo, runId: 30 }, fixture.dependencies);
    assert.deepEqual(fixture.publications, []);
    assert.match(fixture.logs[0], /skipped:/);
  }
});
