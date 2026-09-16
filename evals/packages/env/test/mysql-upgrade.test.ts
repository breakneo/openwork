import assert from "node:assert/strict";
import { test } from "node:test";
import { releaseTag, safeEnvironment } from "../src/mysql-upgrade.ts";
import { assertReadOnlyQueries, mysqlClientArgs, recoveryApplyArgs } from "../src/mysql-recovery.ts";

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

test("recovery CLI write invocation requires all explicit acknowledgments", () => {
  assert.deepEqual(recoveryApplyArgs("isolated_fixture"), ["--apply", "--non-interactive", "--confirm-database", "isolated_fixture", "--backup-confirmed", "--writers-stopped"]);
});

test("mysql client invocation keeps the password out of argv and targets the exact database over TCP", () => {
  const client = mysqlClientArgs("mysql://root:synthetic%2Fsecret@127.0.0.1:33061/recovery_fixture");
  assert.deepEqual(client.args, ["--protocol=tcp", "-h127.0.0.1", "-P33061", "-uroot", "recovery_fixture"]);
  assert.deepEqual(client.env, { MYSQL_PWD: "synthetic/secret" });
  assert.ok(client.args.every(arg => !arg.includes("secret")));
  assert.equal(mysqlClientArgs("mysql://root:pw@127.0.0.1/db").args[2], "-P3306");
  for (const url of ["postgres://root:pw@127.0.0.1/db", "mysql://root:pw@127.0.0.1/db;drop", "mysql://root:pw@127.0.0.1/"]) assert.throws(() => mysqlClientArgs(url));
});

test("SQL trace guard rejects writes, session changes and named locks", () => {
  assertReadOnlyQueries([]);
  assertReadOnlyQueries(["SELECT VERSION()", "SHOW GRANTS FOR CURRENT_USER"]);
  for (const sql of ["SET SESSION lock_wait_timeout=15", "ALTER TABLE t ADD c int", "INSERT INTO t VALUES (1)", "DELETE FROM t", "SELECT GET_LOCK('x',0)", "SELECT RELEASE_LOCK('x')", "SELECT * FROM t FOR UPDATE", "SELECT 1 INTO OUTFILE '/tmp/file'"]) {
    assert.throws(() => assertReadOnlyQueries([sql]), /Read-only CLI/);
  }
});
