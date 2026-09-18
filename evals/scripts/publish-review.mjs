import { spawnSync } from "node:child_process";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { publishReviewPr } from "../packages/test-artifacts/src/publish-pr.ts";
import { readTestRunDirectory } from "../packages/test-artifacts/src/scan.ts";
import { readBinding, requiredStatus } from "../../.github/scripts/required-verification-controller.mjs";

const producers = [
  { file: "ci-tests.yml", name: "Build and core checks", events: ["pull_request", "push"] },
  { file: "daytona-e2e.yml", name: "Product journeys", events: ["workflow_run"] },
];
const validSha = (sha) => typeof sha === "string" && /^[a-f0-9]{40}$/.test(sha);
const validId = (id) => Number.isSafeInteger(id) && id > 0;
function sameRepo(value, repo) {
  const [owner, name] = repo.split("/");
  return value?.full_name === repo && value?.owner?.login === owner && value?.name === name;
}

// All identity comes from GitHub's API, never artifact contents or the event's first PR.
export function association(run, repo, workflows) {
  const producer = workflows.find((workflow) => workflow.id === run.workflow_id);
  if (!producer || run.path !== `.github/workflows/${producer.file}` || run.name !== producer.name)
    return { reason: "unrecognized producer workflow" };
  if (!sameRepo(run.repository, repo) || !sameRepo(run.head_repository, repo))
    return { reason: "producer repository identity mismatch" };
  if (run.status !== "completed" || !["success", "failure"].includes(run.conclusion) || !producer.events.includes(run.event))
    return { reason: "producer event or completion is not eligible" };
  if (run.event === "workflow_run") return { reason: "chained producer requires authenticated upstream binding" };
  if (!Array.isArray(run.pull_requests) || run.pull_requests.length !== 1)
    return { reason: "missing or ambiguous PR association" };
  const pr = run.pull_requests[0];
  // Run PR stubs expose repo IDs, not necessarily full repository objects.
  if (!validId(run.repository.id) || run.head_repository.id !== run.repository.id || pr.base?.repo?.id !== run.repository.id || pr.head?.repo?.id !== run.head_repository.id)
    return { reason: "PR base or head repository identity mismatch" };
  if (!validId(pr.number) || !validSha(pr.head?.sha))
    return { reason: "missing PR identity" };
  if (run.head_sha !== pr.head.sha)
    return { reason: "producer SHA differs from PR association" };
  return { pr: pr.number, sha: pr.head.sha };
}

function gh(args) {
  const result = spawnSync("gh", args, { encoding: "utf8", timeout: 90_000 });
  if (result.status !== 0 || result.error) throw new Error("GitHub evidence operation failed; existing report unchanged.");
  return result.stdout;
}

export async function publishCompletedEvidence({ repo, runId }, dependencies = {}) {
  const api = dependencies.api ?? ((path) => JSON.parse(gh(["api", path])));
  const download = dependencies.download ?? ((id, directory) => gh(["run", "download", String(id), "--repo", repo, "--dir", directory]));
  const publish = dependencies.publish ?? publishReviewPr;
  const log = dependencies.log ?? console.log;
  const binding = dependencies.binding ?? readBinding;
  const required = dependencies.required ?? requiredStatus;
  const skip = (reason) => { log(`Evidence review skipped: ${reason}; existing report unchanged.`); return { skipped: reason }; };
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo ?? "") || !/^[1-9]\d*$/.test(String(runId)))
    return skip("missing repository or run identity");
  const workflows = [];
  for (const producer of producers) {
    const workflow = await api(`repos/${repo}/actions/workflows/${producer.file}`);
    if (!validId(workflow.id) || workflow.path !== `.github/workflows/${producer.file}` || workflow.name !== producer.name)
      return skip("workflow identity mismatch");
    workflows.push({ ...producer, id: workflow.id });
  }
  const source = await api(`repos/${repo}/actions/runs/${runId}`);
  if (!validId(source.id) || String(source.id) !== String(runId)) return skip("source run identity mismatch");
  async function resolve(run) {
    if (run.event !== "workflow_run") return association(run, repo, workflows);
    try {
      const bound = await binding(repo, run.id);
      if (bound.producer.id !== run.id || bound.producer.run_attempt !== run.run_attempt || bound.producer.status !== "completed")
        return { reason: "chained producer attempt changed" };
      return { pr: bound.receipt.pr, sha: bound.receipt.sha };
    } catch { return { reason: "chained producer has no authenticated current-head upstream binding" }; }
  }
  const identity = await resolve(source);
  if (identity.reason) return skip(identity.reason);
  const current = await api(`repos/${repo}/pulls/${identity.pr}`);
  if (current.number !== identity.pr || current.state !== "open" || !sameRepo(current.base?.repo, repo) || !sameRepo(current.head?.repo, repo))
    return skip("current PR repository identity mismatch or closed PR");
  if (current.head.sha !== identity.sha) return skip("source PR SHA is stale");
  if (!Number.isFinite(Date.parse(current.created_at))) return skip("missing PR creation date");

  const runs = new Map([[source.id, source]]);
  for (const workflow of workflows) {
    // No head_sha filter: chained producers run on default-branch code.
    const query = `status=completed&per_page=100&created=${encodeURIComponent(`>=${current.created_at}`)}`;
    for (let page = 1; page <= 5; page++) {
      const result = await api(`repos/${repo}/actions/workflows/${workflow.id}/runs?${query}&page=${page}`);
      if (!Array.isArray(result.workflow_runs) || !Number.isSafeInteger(result.total_count)) return skip("invalid producer listing");
      if (result.total_count > 500) return skip("producer history exceeds 500-run bound");
      for (const candidate of result.workflow_runs) {
        const match = await resolve(candidate);
        if (match.pr === identity.pr && match.sha === identity.sha) {
          if (!validId(candidate.id)) return skip("invalid producer run ID");
          runs.set(candidate.id, candidate);
        }
      }
      if (page * 100 >= result.total_count) break;
    }
  }
  const directory = await mkdtemp(join(tmpdir(), "openwork-review-"));
  try {
    const testRunDirs = [];
    async function visit(path, depth = 0) {
      if (depth > 12) throw new Error("Evidence directory nesting exceeds the limit.");
      const entries = await readdir(path, { withFileTypes: true });
      if (entries.some((entry) => entry.isFile() && entry.name === "test-run.json")) {
        const stored = await readTestRunDirectory(path);
        if (!stored) throw new Error("Malformed recorded evidence.");
        if (stored.testRun.gitSha === identity.sha) testRunDirs.push(path);
      }
      for (const entry of entries)
        if (entry.isDirectory()) await visit(join(path, entry.name), depth + 1);
    }
    for (const id of [...runs.keys()].sort((a, b) => a - b)) {
      // Re-read each run before downloading: list entries and artifacts are not authority.
      const verified = await api(`repos/${repo}/actions/runs/${id}`);
      const match = await resolve(verified);
      if (verified.id !== id || match.pr !== identity.pr || match.sha !== identity.sha) return skip("producer identity changed");
      const artifacts = await api(`repos/${repo}/actions/runs/${id}/artifacts?per_page=100`);
      if (!Array.isArray(artifacts.artifacts) || artifacts.total_count !== artifacts.artifacts.length) return skip("artifact listing incomplete");
      if (artifacts.artifacts.some((artifact) => artifact.expired)) return skip("producer artifacts expired");
      if (artifacts.artifacts.length === 0) continue;
      const destination = join(directory, String(id));
      await download(id, destination);
      await visit(destination);
    }
    if (!testRunDirs.length) return skip("no records for current PR SHA");
    const latest = await api(`repos/${repo}/pulls/${identity.pr}`);
    if (latest.number !== identity.pr || latest.state !== "open" || latest.head?.sha !== identity.sha || !sameRepo(latest.base?.repo, repo) || !sameRepo(latest.head?.repo, repo)) return skip("PR identity changed before publishing");
    const status = await required(repo, identity.pr, identity.sha);
    const gaps = status.state === "passed" ? [] : [`Required verification: ${status.state}. Selected evidence does not satisfy all required specs.${status.url ? ` Jobs: ${status.url}` : " No authenticated current-head required plan is available."}`];
    const result = await publish({ pr: identity.pr, testRunDirs, gaps, automatic: true, preserveCurrentReport: true });
    log(result.posted ? result.urls.report : "Evidence review unchanged: protected selection or cumulative records unavailable.");
    return result;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  // Pin all publisher gh calls (including its head checks and comment writes).
  process.env.GH_REPO = process.env.GITHUB_REPOSITORY;
  await publishCompletedEvidence({ repo: process.env.GITHUB_REPOSITORY, runId: process.env.REVIEW_RUN_ID });
}
