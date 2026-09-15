import assert from "node:assert/strict";
import { test } from "node:test";
import { releaseTag, safeEnvironment } from "../src/mysql-upgrade.ts";

test("upgrade accepts only exact release tag syntax", () => {
  assert.equal(releaseTag("v0.18.35"), "v0.18.35");
  assert.equal(releaseTag("v0.18.48"), "v0.18.48");
  for (const value of ["dev", "HEAD", "v0.18.48;exit", "--help", "v0.18.48-beta.1", "../v0.18.48"]) {
    assert.throws(() => releaseTag(value), /exact/);
  }
});

test("bootstrap environment is an allowlist rather than inherited credentials", () => {
  const env = safeEnvironment("/fixture/bin");
  assert.equal(env.PATH, "/fixture/bin");
  assert.equal(env.pnpm_config_verify_deps_before_run, "false");
  assert.deepEqual(Object.keys(env).sort(), ["HOME", "NODE_ENV", "PATH", "TMPDIR", "pnpm_config_verify_deps_before_run"].sort());
  assert.equal(env.DATABASE_URL, undefined);
  assert.equal(env.DEN_DB_ENCRYPTION_KEY, undefined);
  assert.equal(env.NODE_OPTIONS, undefined);
});
