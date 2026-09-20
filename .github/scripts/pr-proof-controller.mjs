import { spawnSync } from "node:child_process";
import { appendFile, readFile } from "node:fs/promises";
import { changedFiles, proofKey, requireProof, selectProof } from "./pr-proof.mjs";

const event = JSON.parse(await readFile(process.env.GITHUB_EVENT_PATH, "utf8"));
if (!event.pull_request) throw new Error("Proof contract requires a pull request event.");
const repo = process.env.GITHUB_REPOSITORY;
const pr = event.pull_request.number;
function api(path) {
  const result = spawnSync("gh", ["api", path], { encoding: "utf8", timeout: 30_000 });
  if (result.status !== 0) throw new Error("GitHub proof selection unavailable.");
  return JSON.parse(result.stdout);
}
const current = api(`repos/${repo}/pulls/${pr}`);
if (current.head.sha !== event.pull_request.head.sha) throw new Error("PR head changed; rerun the proof contract on the current head.");
const files = await changedFiles(api, repo, pr, current.changed_files);
const selection = requireProof(selectProof(files));
if (selection.specs.length > 32) throw new Error("More than 32 new proof specs; bounded CI selection unavailable. Split the change.");
if (process.argv[2] === "validate") {
  const { validateProofSpec } = await import("../../evals/scripts/pr-proof-spec.mjs");
  for (const spec of selection.specs) {
    const file = files.find(file => file.filename === spec);
    if (!/^[a-f0-9]{40}$/.test(file.sha)) throw new Error("Spec blob identity unavailable.");
    const blob = api(`repos/${repo}/git/blobs/${file.sha}`);
    if (blob.sha !== file.sha || blob.encoding !== "base64" || blob.size > 256_000) throw new Error("Spec blob is invalid or too large.");
    validateProofSpec(spec, Buffer.from(blob.content, "base64").toString("utf8"));
  }
}
if (api(`repos/${repo}/pulls/${pr}`).head.sha !== current.head.sha) throw new Error("PR head changed during selection.");
if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `matrix=${JSON.stringify({ include: selection.specs.map(spec => ({ spec, key: proofKey(spec) })) })}\nselected=${selection.specs.length > 0}\n`);
console.log(selection.exemption ? `Proof exemption: ${selection.exemption}; its existing validation lane remains required.` : `New PR proof specs (${selection.specs.length}):\n${selection.specs.join("\n")}`);
