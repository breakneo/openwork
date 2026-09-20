import assert from "node:assert/strict";
import test from "node:test";
import { changedFiles, proofArtifact, selectProof } from "./pr-proof.mjs";

const file = (filename, status = "modified", previous_filename) => ({ filename, status, ...(previous_filename ? { previous_filename } : {}) });

test("added and changed E2E specs are all selected; removed specs and non-specs are not", () => {
  assert.deepEqual(selectProof([
    file("apps/app/src/a.ts"),
    file("evals/specs/new.e2e.test.ts", "added"),
    file("evals/specs/changed.e2e.test.ts"),
    file("evals/specs/moved.e2e.test.ts", "renamed", "evals/specs/old-name.e2e.test.ts"),
    file("evals/specs/gone.e2e.test.ts", "removed"),
    file("evals/specs/unit.test.ts"),
    file("evals/worlds/chat.ts"),
  ]).specs, ["evals/specs/changed.e2e.test.ts", "evals/specs/moved.e2e.test.ts", "evals/specs/new.e2e.test.ts"]);
});

test("a PR without spec changes selects nothing instead of failing", () => {
  assert.deepEqual(selectProof([file("packages/docs/page.mdx")]).specs, []);
  assert.deepEqual(selectProof([]).specs, []);
});

test("normal Git paths are accepted while traversal, controls, backslashes and duplicates fail closed", () => {
  assert.deepEqual(selectProof([
    file("ee/apps/den-web/app/(den)/dashboard/a file.ts"),
    file("packages/docs/café.mdx"),
    file("evals/specs/change.e2e.test.ts", "added"),
  ]).specs, ["evals/specs/change.e2e.test.ts"]);
  for (const files of [
    [file("../escape.ts")], [file("/absolute.ts")], [file("apps\\escape.ts")],
    [file("apps/control\n.ts")], [file("apps/a.ts"), file("apps/a.ts")],
  ]) assert.throws(() => selectProof(files));
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
