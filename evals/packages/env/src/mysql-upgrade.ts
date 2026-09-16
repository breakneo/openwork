import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { allocateFreePort } from "@openwork/cdp";
import { killLocalPid } from "@openwork/hosts";
import { trackResource } from "@openwork/world";
import { createConnection } from "mysql2/promise";
import type { RowDataPacket } from "mysql2";
import type { RecoveryCli } from "./mysql-recovery.ts";
import { ephemeralDatabaseName, resolvePlace } from "./place.ts";

const exec = promisify(execFile);
const repo = fileURLToPath(new URL("../../../..", import.meta.url));
const packages = ["packages/types", "ee/packages/utils", "ee/packages/den-db"];

export function releaseTag(value: string): string {
  if (!/^v0\.\d+\.\d+$/.test(value)) throw new Error("Expected an exact v0.x.y release tag");
  return value;
}

export function safeEnvironment(path: string): NodeJS.ProcessEnv {
  return { PATH: path, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR, NODE_ENV: "test", pnpm_config_verify_deps_before_run: "false" };
}

async function command(bin: string, args: string[], cwd: string, env: NodeJS.ProcessEnv) {
  return exec(bin, args, { cwd, env, timeout: 300_000, maxBuffer: 32 * 1024 * 1024 });
}

async function linkDependencies(source: string, target: string, releaseRoot: string) {
  await mkdir(target, { recursive: true });
  for (const entry of await readdir(source)) {
    if (entry === ".bin") continue;
    if (entry.startsWith("@")) {
      await mkdir(join(target, entry), { recursive: true });
      for (const name of await readdir(join(source, entry))) {
        const internal = entry === "@openwork" && name === "types" ? "packages/types"
          : entry === "@openwork-ee" && name === "utils" ? "ee/packages/utils" : undefined;
        await symlink(internal ? join(releaseRoot, internal) : join(source, entry, name), join(target, entry, name));
      }
    } else {
      await symlink(join(source, entry), join(target, entry));
    }
  }
  await mkdir(join(target, ".bin"), { recursive: true });
  for (const name of ["tsup", "drizzle-kit", "tsc"]) {
    const entry = name === "tsup" ? "tsup/dist/cli-default.js" : name === "drizzle-kit" ? "drizzle-kit/bin.cjs" : "typescript/bin/tsc";
    await symlink(join(target, entry), join(target, ".bin", name));
  }
}

async function prepareRelease(root: string, tag: string, env: NodeJS.ProcessEnv) {
  releaseTag(tag);
  const sha = (await command("git", ["rev-parse", `${tag}^{commit}`], repo, env)).stdout.trim();
  const releaseRoot = join(root, tag);
  await mkdir(releaseRoot);
  const archive = join(root, `${tag}.tar`);
  await command("git", ["archive", "--format=tar", `--output=${archive}`, sha, ...packages], repo, env);
  await command("tar", ["-xf", archive, "-C", releaseRoot], repo, env);
  for (const pkg of packages) await linkDependencies(join(repo, pkg, "node_modules"), join(releaseRoot, pkg, "node_modules"), releaseRoot);
  for (const pkg of packages) {
    const cwd = join(releaseRoot, pkg);
    console.log(`[mysql-upgrade] building ${tag} ${pkg}`);
    await command(process.execPath, [join(cwd, "node_modules/tsup/dist/cli-default.js")], cwd, env);
  }
  const db = join(releaseRoot, "ee/packages/den-db");
  await command(process.execPath, [join(db, "node_modules/tsup/dist/cli-default.js"), "--config", "tsup.scripts.config.ts"], db, env);
  await command(process.execPath, ["scripts/build-assets.mjs"], db, env);
  const detailed = join(db, "dist/diagnose.mjs");
  await writeFile(detailed, `import { bootstrapDenDb } from './scripts/bootstrap.js';\ntry { await bootstrapDenDb(); } catch (error) {\n const chain = []; const seen = new Set();\n while (error instanceof Error && !seen.has(error)) { seen.add(error); chain.push({name:error.name,message:error.message,code:error.code,errno:error.errno,sqlState:error.sqlState}); error=error.cause; }\n console.error(JSON.stringify({chain})); process.exitCode=1;\n}\n`);
  const sql = await readFile(join(db, "dist/current-schema.sql"));
  const bootstrap = await readFile(join(db, "scripts/bootstrap.ts"));
  const migration = await readFile(join(db, "drizzle/0097_gateway_access_matrix.sql")).catch(() => Buffer.from(""));
  return { tag, sha, db, schemaSha256: createHash("sha256").update(sql).digest("hex"), bootstrapSha256: createHash("sha256").update(bootstrap).digest("hex"), migration0097Sha256: createHash("sha256").update(migration).digest("hex") };
}

async function bootstrap(db: string, url: string, diagnostic: boolean, env: NodeJS.ProcessEnv) {
  const child = spawn(process.execPath, [diagnostic ? "dist/diagnose.mjs" : "dist/scripts/bootstrap.js"], {
    cwd: db, env: { ...env, DATABASE_URL: url, DB_MODE: "mysql", DEN_DB_ENCRYPTION_KEY: "isolated-mysql-upgrade-fixture-key-000000000000" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", chunk => { stdout += String(chunk); });
  child.stderr.on("data", chunk => { stderr += String(chunk); });
  const timer = setTimeout(() => child.kill("SIGKILL"), 120_000);
  try {
    const code = await new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("exit", resolve); });
    return { code, stdout, stderr };
  } finally { clearTimeout(timer); }
}

async function inspect(url: string) {
  const sql = await createConnection(url);
  try {
    const [ledger] = await sql.query<RowDataPacket[]>("SELECT count(*) AS count, max(created_at) AS latest FROM __drizzle_migrations");
    const [tables] = await sql.query<RowDataPacket[]>("SHOW TABLES");
    const [indexes] = await sql.query<RowDataPacket[]>("SELECT TABLE_NAME, COLUMN_NAME FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND INDEX_NAME='PRIMARY' ORDER BY TABLE_NAME, SEQ_IN_INDEX");
    const [marker] = await sql.query<RowDataPacket[]>("SELECT id, name FROM organization WHERE id='org_upgrade_fixture'");
    const [settings] = await sql.query<RowDataPacket[]>("SELECT @@version AS version, @@sql_require_primary_key AS requiredPrimaryKey");
    return { ledger, tables: tables.map(row => Object.values(row)[0]), indexes, marker, settings };
  } finally { await sql.end(); }
}

export async function runMysqlUpgrade(input: { from: string; to: string; temporaryParent?: string; pnpmEntry: string; recoveryReport?: string; recoveryCli?: RecoveryCli; recoverySqlFile?: string }) {
  releaseTag(input.from);
  releaseTag(input.to);
  if (input.recoveryReport && (input.from !== "v0.18.35" || input.to !== "v0.18.48")) throw new Error("Recovery validation requires exact v0.18.35 -> v0.18.48 releases");
  if ((input.recoveryCli || input.recoverySqlFile) && !input.recoveryReport) throw new Error("Recovery CLI or SQL overrides require recovery validation");
  const stack = new AsyncDisposableStack();
  try {
    const root = await mkdtemp(join(input.temporaryParent ?? tmpdir(), "ow-mysql-"));
    stack.defer(() => rm(root, { recursive: true, force: true }));
    await trackResource({ kind: "tmpdir", id: root, label: "mysql-upgrade" });
    const bin = join(root, "bin");
    await mkdir(bin);
    await symlink(input.pnpmEntry, join(bin, "pnpm"));
    const env = safeEnvironment(`${bin}:${dirname(process.execPath)}:${process.env.PATH ?? ""}`);
    const from = await prepareRelease(root, input.from, env);
    const to = await prepareRelease(root, input.to, env);
    const data = join(root, "data");
    await mkdir(data);
    const password = randomBytes(24).toString("hex");
    const init = join(root, "init.sql");
    await writeFile(init, `ALTER USER 'root'@'localhost' IDENTIFIED BY '${password}';\n`, { mode: 0o600 });
    console.log("[mysql-upgrade] initializing isolated MySQL");
    await command("mysqld", ["--no-defaults", "--initialize-insecure", `--datadir=${data}`], root, env);
    const port = await allocateFreePort();
    const child = spawn("mysqld", ["--no-defaults", `--datadir=${data}`, `--port=${port}`, "--bind-address=127.0.0.1", "--mysqlx=0", `--socket=${join(root, "s")}`, `--pid-file=${join(root, "mysql.pid")}`, `--log-error=${join(root, "mysql.log")}`, `--init-file=${init}`], { cwd: root, env, detached: true, stdio: "ignore" });
    child.on("error", error => console.error(error.message));
    const pid = child.pid;
    if (!pid) throw new Error("MySQL did not spawn");
    stack.defer(async () => { await killLocalPid(pid, { graceMs: 15_000 }); });
    await trackResource({ kind: "process", id: String(pid), label: "isolated-mysqld", match: data });
    const url = `mysql://root:${password}@127.0.0.1:${port}/mysql`;
    let ready = false;
    for (let i = 0; i < 120; i++) {
      try { const connection = await createConnection(url); await connection.end(); ready = true; break; } catch { await delay(500); }
      if (child.exitCode !== null) break;
    }
    if (!ready) throw new Error(`MySQL startup failed: ${await readFile(join(root, "mysql.log"), "utf8")}`);
    await rm(init);
    const admin = await createConnection(url);
    stack.defer(() => admin.end());
    const results = [];
    for (const required of [false, true]) {
      await admin.query(`SET GLOBAL sql_require_primary_key=${required ? "ON" : "OFF"}`);
      for (const diagnostic of [false, true]) {
        const place = resolvePlace({ OPENWORK_EVAL_MYSQL_URL: url });
        const database = stack.use(await place.db(ephemeralDatabaseName("upgrade")));
        console.log(`[mysql-upgrade] requiredPrimaryKey=${required} diagnostic=${diagnostic}`);
        const baseline = await bootstrap(from.db, database.url, diagnostic, env);
        assert.equal(baseline.code, 0, baseline.stderr);
        const connection = await createConnection(database.url);
        try { await connection.query("INSERT INTO organization (id, name, slug) VALUES ('org_upgrade_fixture','Upgrade fixture','upgrade-fixture')"); } finally { await connection.end(); }
        const before = await inspect(database.url);
        const first = await bootstrap(to.db, database.url, diagnostic, env);
        const afterFirst = await inspect(database.url);
        const retry = await bootstrap(to.db, database.url, diagnostic, env);
        const afterRetry = await inspect(database.url);
        results.push({ required, diagnostic, baseline, before, first, afterFirst, retry, afterRetry });
      }
    }
    const dependencies: Record<string, unknown> = {};
    for (const name of ["mysql2", "drizzle-orm", "drizzle-kit", "tsup"]) {
      const metadata: unknown = JSON.parse(await readFile(join(to.db, "node_modules", name, "package.json"), "utf8"));
      if (typeof metadata !== "object" || metadata === null || !("version" in metadata)) throw new Error(`Missing version for ${name}`);
      dependencies[name] = metadata.version;
    }
    const checks: string[] = [];
    if (input.from === "v0.18.35" && input.to === "v0.18.48") {
      for (const result of results) {
        const label = `PK ${result.required ? "ON" : "OFF"}, ${result.diagnostic ? "diagnostic" : "CLI"}`;
        assert.equal(result.before.ledger[0]?.count, 76);
        assert.equal(result.first.code, result.required ? 1 : 0, result.first.stderr);
        assert.equal(result.retry.code, result.required ? 1 : 0, result.retry.stderr);
        assert.deepEqual(result.before.marker, result.afterFirst.marker);
        assert.deepEqual(result.before.marker, result.afterRetry.marker);
        assert.deepEqual(result.afterFirst.ledger, result.afterRetry.ledger);
        assert.equal(result.afterFirst.ledger[0]?.count, result.required ? 96 : 101);
        assert.ok(result.afterFirst.tables.includes("gateway_credential_sets"));
        assert.ok(result.afterFirst.tables.includes("gateway_request_logs"));
        assert.ok(!result.afterFirst.tables.includes("inference_request_logs"));
        assert.ok(result.afterFirst.indexes.some(row => row.TABLE_NAME === "gateway_request_logs" && row.COLUMN_NAME === "id"));
        if (result.required) {
          assert.match(result.first.stderr, /ALTER TABLE `gateway_request_logs` DROP PRIMARY KEY/);
          assert.match(result.retry.stderr, /CREATE TABLE `gateway_credential_sets`/);
          if (result.diagnostic) {
            assert.match(result.first.stderr, /ER_TABLE_WITHOUT_PK/);
            assert.match(result.first.stderr, /"errno":3750/);
            assert.match(result.retry.stderr, /ER_TABLE_EXISTS_ERROR/);
            assert.match(result.retry.stderr, /"errno":1050/);
          } else {
            assert.doesNotMatch(result.first.stderr, /ER_TABLE_WITHOUT_PK|sql_require_primary_key/);
            assert.doesNotMatch(result.retry.stderr, /ER_TABLE_EXISTS_ERROR|already exists/);
          }
        }
        checks.push(`${label}: expected upgrade/retry, ledger, partial DDL, primary key and marker verified`);
      }
    }
    const recovery = input.recoveryReport ? await (await import("./mysql-recovery.ts")).runMysqlRecovery({
      admin, env, reportPath: input.recoveryReport, cli: input.recoveryCli, sqlFile: input.recoverySqlFile,
      bootstrap: databaseUrl => bootstrap(to.db, databaseUrl, false, env),
      fixture: async required => {
        await admin.query(`SET GLOBAL sql_require_primary_key=${required ? "ON" : "OFF"}`);
        const place = resolvePlace({ OPENWORK_EVAL_MYSQL_URL: url });
        const database = stack.use(await place.db(ephemeralDatabaseName("recovery")));
        const baseline = await bootstrap(from.db, database.url, false, env);
        assert.equal(baseline.code, 0, baseline.stderr);
        const connection = await createConnection(database.url);
        try { await connection.query("INSERT INTO organization (id, name, slug) VALUES ('org_upgrade_fixture','Upgrade fixture','upgrade-fixture')"); } finally { await connection.end(); }
        const before = await inspect(database.url);
        assert.equal(before.ledger[0]?.count, 76);
        const upgrade = await bootstrap(to.db, database.url, false, env);
        assert.equal(upgrade.code, required ? 1 : 0, upgrade.stderr);
        if (required) assert.match(upgrade.stderr, /ALTER TABLE `gateway_request_logs` DROP PRIMARY KEY/);
        const after = await inspect(database.url);
        assert.equal(after.ledger[0]?.count, required ? 96 : 101);
        assert.deepEqual(after.marker, before.marker);
        return database;
      },
    }) : undefined;
    if (recovery) checks.push(...recovery.cases.map(result => result.name));
    const report = { from, to, runtime: process.version, dependencies, checks, results, recovery: recovery ? { report: input.recoveryReport, status: recovery.status, counts: recovery.counts, cli: recovery.cli, bundle: recovery.bundle } : undefined, limitations: ["Source-built release bootstrap and SQL; not published container bytes", "Uses installed workspace dependency versions, not fresh release lockfile installs", "Synthetic organization marker only; no production data or populated inference fixture", "Local native MySQL; not managed MySQL or Docker deployment"] };
    return { report, root, async [Symbol.asyncDispose]() { await stack.disposeAsync(); } };
  } catch (error) { await stack.disposeAsync(); throw error; }
}
