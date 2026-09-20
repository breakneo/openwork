import assert from "node:assert/strict";
import test from "node:test";
import { validateProofSpec } from "./pr-proof-spec.mjs";

const file = "evals/specs/change.e2e.test.ts";

test("accepts nonempty testkit and Vitest E2E tests", () => {
  validateProofSpec(file, `import { test } from "@openwork/testkit"; test("proof", async ({ user }) => { await user.see("Ready"); });`);
  validateProofSpec(file, `import { test as verify } from "vitest"; verify("proof", () => { if (!true) throw new Error(); });`);
});

test("rejects syntax errors, empty, skipped, todo and prose-only files", () => {
  for (const source of [
    `import { test } from "@openwork/testkit"; test("proof", () => {});`,
    `import { test } from "@openwork/testkit"; test.skip("proof", () => { throw new Error(); });`,
    `import { test } from "@openwork/testkit"; test.todo("proof");`,
    `export const explanation = "not executable";`,
    `import { test } from "@openwork/testkit"; test(`,
  ]) assert.throws(() => validateProofSpec(file, source));
});
