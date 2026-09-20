import assert from "node:assert/strict";
import test from "node:test";
import { changedFiles, proofArtifact, requireProof, selectProof } from "./pr-proof.mjs";

const file = (filename, status = "modified", previous_filename) => ({ filename, status, ...(previous_filename ? { previous_filename } : {}) });

test("only newly added E2E specs satisfy the PR proof contract", () => {
  assert.deepEqual(requireProof(selectProof([
    file("apps/app/src/a.ts"),
    file("evals/specs/change.e2e.test.ts", "added"),
  ])).specs, ["evals/specs/change.e2e.test.ts"]);
  for (const candidate of [
    [file("apps/app/src/a.ts")],
    [file("apps/app/src/a.ts"), file("evals/specs/change.e2e.test.ts")],
    [file("apps/app/src/a.ts"), file("evals/specs/change.e2e.test.ts", "renamed", "evals/specs/old.e2e.test.ts")],
    [file("apps/app/src/a.ts"), file("evals/specs/change.e2e.test.ts", "removed")],
  ]) assert.throws(() => requireProof(selectProof(candidate)), /Add a NEW runnable/);
});

test("narrow existing lanes are exempt but mixed changes are not", () => {
  assert.equal(requireProof(selectProof([file("packages/docs/page.mdx")])).exemption, "docs");
  assert.equal(requireProof(selectProof([file("ee/apps/gateway/src/models/base.json")])).exemption, "snapshot");
  assert.throws(() => requireProof(selectProof([file("packages/docs/page.mdx"), file("apps/app/src/a.ts")])), /NEW runnable/);
  assert.throws(() => requireProof(selectProof([file("packages/docs/new.mdx", "renamed", "apps/app/old.ts")])), /NEW runnable/);
});

test("unsafe, duplicate and malformed file lists fail closed", () => {
  for (const files of [[], [file("../escape.ts")], [file("apps/a.ts"), file("apps/a.ts")]])
    assert.throws(() => selectProof(files));
  assert.throws(() => requireProof(selectProof([file("evals/specs/a.e2e.test.ts", "added", "evals/specs/old.e2e.test.ts")])));
});

test("changed-file pagination is complete and bounded", async () => {
  const paths = Array.from({ length: 201 }, (_, index) => file(`apps/a-${index}.ts`));
  const calls = [];
  const result = await changedFiles(async path => {
    calls.push(path);
    const page = Number(new URL(`https://example.test/${path}`).searchParams.get("page"));
    return paths.slice((page - 1) * 100, page * 100);
  }, "o/r", 1, paths.length);
  assert.equal(result.length, 201);
  assert.equal(calls.length, 3);
  await assert.rejects(changedFiles(async () => [], "o/r", 1, 3001), /3000-file limit/);
});

test("artifact names are stable, bounded hashes of validated spec paths", () => {
  const name = proofArtifact("evals/specs/change.e2e.test.ts", 2);
  assert.match(name, /^pr-proof-2-[a-f0-9]{64}$/);
  assert.throws(() => proofArtifact("../change.e2e.test.ts", 1));
});
