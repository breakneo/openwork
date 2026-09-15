import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { expect } from "vitest"
import { needs, test } from "@openwork/testkit"

test("read-only codemode policy rejects writes and undeclared runtime access", async ({ evidence }) => {
  needs({ commands: ["bun"] })
  const result = spawnSync("bun", ["test", "--conditions", "development", "test/codemode-readonly-policy.test.ts"], {
    cwd: fileURLToPath(new URL("../../ee/apps/den-api/", import.meta.url)),
    encoding: "utf8",
    timeout: 60_000,
    env: { ...process.env, NO_COLOR: "1" },
  })
  const output = result.stdout + result.stderr
  expect(result.error).toBeUndefined()
  expect(result.status, output).toBe(0)
  expect(output).toMatch(/4 pass/)
  expect(output).toMatch(/0 fail/)
  expect(output).not.toMatch(/\b[1-9]\d* (skip|todo)/)
  evidence.recordAssertionEvidence("Read-only policy and execution boundary", output, true)
})
