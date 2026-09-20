import { createHash } from "node:crypto";

export function safePath(path) {
  return typeof path === "string" && path.length <= 240 && path.split("/").every(part =>
    part !== "." && part !== ".." && !part.startsWith("-") && /^[a-zA-Z0-9_.-]+$/.test(part));
}

export function selectProof(files) {
  if (!Array.isArray(files) || !files.length || files.some(file => !safePath(file.filename) || (file.previous_filename !== undefined && !safePath(file.previous_filename))))
    throw new Error("Missing or unsafe changed-file listing; proof selection is unavailable.");
  const paths = files.flatMap(file => [file.filename, ...(file.previous_filename ? [file.previous_filename] : [])]);
  const docs = paths.every(path => path.startsWith("packages/docs/"));
  const snapshot = files.length === 1 && files[0].status === "modified" && files[0].filename === "ee/apps/gateway/src/models/base.json";
  const specs = files.filter(file => file.status === "added" && !file.previous_filename && /^evals\/specs\/.+\.e2e\.test\.ts$/.test(file.filename)).map(file => file.filename).sort();
  if (new Set(files.map(file => file.filename)).size !== files.length) throw new Error("Duplicate changed files; proof selection is unavailable.");
  return { exemption: docs ? "docs" : snapshot ? "snapshot" : null, specs };
}

export function requireProof(selection) {
  if (!selection.exemption && !selection.specs.length)
    throw new Error("Add a NEW runnable evals/specs/**/*.e2e.test.ts demonstrating this change for human review. Modified, unchanged, renamed, or deleted specs do not count. No regression or packaged-smoke fallback. Only packages/docs-only and the single generated model snapshot lane are exempt.");
  return selection;
}

export async function changedFiles(api, repo, pr, expectedCount) {
  if (!Number.isSafeInteger(expectedCount) || expectedCount < 1 || expectedCount > 3000) throw new Error("Changed-file count is unavailable or exceeds GitHub's 3000-file limit.");
  const files = [];
  for (let page = 1; page <= Math.ceil(expectedCount / 100); page++) {
    const entries = await api(`repos/${repo}/pulls/${pr}/files?per_page=100&page=${page}`);
    if (!Array.isArray(entries) || entries.length !== Math.min(100, expectedCount - files.length)) throw new Error("Changed-file pagination is incomplete.");
    files.push(...entries);
  }
  if (files.length !== expectedCount) throw new Error("Changed-file listing is incomplete.");
  return files;
}

export function proofKey(spec) {
  if (!safePath(spec) || !/^evals\/specs\/.+\.e2e\.test\.ts$/.test(spec)) throw new Error("Invalid proof spec path.");
  return createHash("sha256").update(spec).digest("hex");
}

export function proofArtifact(spec, attempt) {
  if (!Number.isSafeInteger(attempt) || attempt < 1) throw new Error("Invalid proof attempt.");
  return `pr-proof-${attempt}-${proofKey(spec)}`;
}
