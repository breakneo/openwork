import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { uploadReview } from "@openwork/review/storage";
import { publishReviewPr } from "../packages/test-artifacts/src/publish-pr.ts";
import { association, publicationJob, publishCompletedEvidence } from "./publish-review.mjs";

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

test("direct PR publication is selected evidence, not a required-journey verdict", async () => {
  const fixture = harness();
  fixture.dependencies.required = async () => assert.fail("direct evidence must not depend on the required-journey controller");
  const queries = [];
  const api = fixture.dependencies.api;
  fixture.dependencies.api = async path => { queries.push(path); return api(path); };
  await publishCompletedEvidence({ repo, runId: 30, runAttempt: "1" }, fixture.dependencies);
  assert.deepEqual(fixture.publications[0].gaps, []);
  assert.ok(queries.some(path => path.includes(`/workflows/20/runs?`) && path.includes(`head_sha=${sha}`)));
  assert.ok(queries.some(path => path.includes(`/workflows/21/runs?`) && !path.includes("head_sha=")));
});

test("a completion event for an earlier attempt cannot publish the rerun", async () => {
  const fixture = harness();
  await publishCompletedEvidence({ repo, runId: 30, runAttempt: "2" }, fixture.dependencies);
  assert.match(fixture.logs[0], /source run attempt is stale/);
  assert.deepEqual(fixture.downloads, []);
});

test("unbound chained evidence cannot publish even with plausible artifact identities", async () => {
  const fixture = harness([run(31, workflows[1])]);
  fixture.dependencies.binding = async () => { throw new Error("unsupported chain"); };
  await publishCompletedEvidence({ repo, runId: 31 }, fixture.dependencies);
  assert.deepEqual(fixture.publications, []);
  assert.deepEqual(fixture.downloads, []);
});

test("bounded history, expired artifacts and changed producer/current PR fail closed", async () => {
  for (const condition of ["bound", "expired", "producer", "attempt", "head"]) {
    const fixture = harness();
    const original = fixture.dependencies.api;
    let runReads = 0, prReads = 0;
    fixture.dependencies.api = async (path) => {
      const value = await original(path);
      if (condition === "bound" && path.includes("/runs?")) return { ...value, total_count: 501 };
      if (condition === "expired" && path.includes("/artifacts?")) return { total_count: 1, artifacts: [{ expired: true }] };
      if (condition === "producer" && path.endsWith("/runs/30") && ++runReads > 1) return { ...value, name: "Unknown" };
      if (condition === "attempt" && path.endsWith("/runs/30") && ++runReads > 1) return { ...value, run_attempt: 2 };
      if (condition === "head" && path.endsWith("/pulls/7") && ++prReads > 1) return { ...value, head: { ...value.head, sha: "2".repeat(40) } };
      return value;
    };
    await publishCompletedEvidence({ repo, runId: 30 }, fixture.dependencies);
    assert.deepEqual(fixture.publications, []);
    assert.match(fixture.logs[0], /skipped:/);
  }
});

const jobEnv = {
  GITHUB_REPOSITORY: repo, REVIEW_RUN_ID: "30",
  OPENWORK_REVIEW_URL: "https://review.example.test", BLOB_READ_WRITE_TOKEN: "synthetic-test-only",
};

test("publication outcome is explicit for skipped, preserved, unavailable, failed and published runs", async () => {
  for (const [result, state] of [
    [{ skipped: "missing or ambiguous PR association" }, "skipped"],
    [{ posted: false }, "unchanged"],
    [{ posted: true, urls: { report: `https://review.example.test/r/${"a".repeat(32)}` } }, "published"],
  ]) {
    const summaries = [];
    const outcome = await publicationJob(jobEnv, {
      publish: async () => result, summary: async text => summaries.push(text),
    });
    assert.equal(outcome.state, state);
    assert.equal(outcome.exitCode, 0);
    assert.match(summaries.join(""), new RegExp(`Evidence publication: ${state}`));
  }
  for (const result of [
    new Error("sensitive-provider-error-do-not-print"),
    { posted: true, urls: { report: `https://external.example.test/r/${"a".repeat(32)}` } },
  ]) {
    const summaries = [];
    const outcome = await publicationJob(jobEnv, {
      publish: async () => { if (result instanceof Error) throw result; return result; },
      summary: async text => summaries.push(text),
    });
    assert.equal(outcome.state, "failed");
    assert.equal(outcome.exitCode, 1);
    assert.doesNotMatch(summaries.join(""), /sensitive-provider-error|external.example/);
  }
  for (const missing of ["OPENWORK_REVIEW_URL", "BLOB_READ_WRITE_TOKEN"]) {
    const summaries = [];
    const outcome = await publicationJob({ ...jobEnv, [missing]: "" }, {
      publish: async () => assert.fail("must not publish without configuration"),
      summary: async text => summaries.push(text),
    });
    assert.equal(outcome.state, "unavailable");
    assert.equal(outcome.exitCode, 1);
    assert.match(summaries.join(""), /OPENWORK_REVIEW_BLOB_TOKEN/);
  }
});

test("real publisher assembles and stores a report then updates one compact comment (synthetic GitHub, local storage)", async () => {
  const root = await mkdtemp(join(tmpdir(), "review-publication-integration-"));
  try {
    const fixture = harness();
    const comments = [];
    let savedId;
    const exec = (_command, args, options) => {
      if (args.includes("headRefOid")) return { status: 0, stdout: JSON.stringify({ headRefOid: sha }), stderr: "" };
      if (args.includes("comments")) return { status: 0, stdout: JSON.stringify({ comments: [{ databaseId: 77, body: "<!-- test-evidence --> previous" }] }), stderr: "" };
      assert.ok(args.includes("PATCH"), "update the existing comment, never delete or attach public assets");
      comments.push(JSON.parse(options.input).body);
      return { status: 0, stdout: "{}", stderr: "" };
    };
    fixture.dependencies.publish = options => publishReviewPr({ ...options, reviewUrl: jobEnv.OPENWORK_REVIEW_URL }, {
      exec,
      upload: async (report, assets) => {
        savedId = await uploadReview(report, assets, { localDir: root });
        return savedId;
      },
    });
    const summaries = [];
    const result = await publicationJob(jobEnv, {
      publish: input => publishCompletedEvidence(input, fixture.dependencies),
      summary: async text => summaries.push(text),
    });
    assert.equal(result.state, "published");
    assert.equal(comments.length, 1);
    assert.match(comments[0], new RegExp(`/r/${savedId}`));
    assert.doesNotMatch(comments[0], /\[user\]|\[probe\]|!\[/);
    const manifest = JSON.parse(await readFile(join(root, savedId, "report.json"), "utf8"));
    assert.equal(manifest.gitSha, sha);
    assert.equal(manifest.sources.length, 1);
    const original = JSON.parse(await readFile(join(root, savedId, manifest.sources[0].asset), "utf8"));
    assert.equal(original.gitSha, sha);
    assert.match(summaries[0], /not a test verdict or human approval/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("workflow restores PR checks and publication without running candidate code with publishing secrets", async () => {
  const yaml = await readFile(new URL("../../.github/workflows/evidence-review.yml", import.meta.url), "utf8");
  assert.match(yaml, /on:\n  pull_request:\n    paths:/);
  assert.match(yaml, /workflow_dispatch:\n    inputs:\n      run_id:/);
  const checks = yaml.slice(yaml.indexOf("  check-publisher:"), yaml.indexOf("  publish:"));
  assert.doesNotMatch(checks, /secrets\.|pull-requests: write|checks: write/);
  assert.match(checks, /specs\/evidence-review.test.ts/);
  const publisher = yaml.slice(yaml.indexOf("  publish:"));
  assert.match(publisher, /github.event.workflow_run.event == 'pull_request'/);
  assert.doesNotMatch(publisher, /github.event.workflow_run.event != 'pull_request'/);
  assert.match(publisher, /ref: \$\{\{ github.event.repository.default_branch \}\}/);
  assert.match(publisher, /persist-credentials: false/);
  assert.doesNotMatch(publisher, /ref:.*head.sha|pull_request_target/);
  assert.match(publisher, /REVIEW_RUN_ID: \$\{\{ github.event.workflow_run.id \|\| inputs.run_id \}\}/);
});
