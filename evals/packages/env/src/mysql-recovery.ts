import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createConnection } from "mysql2/promise";
import type { Connection, RowDataPacket } from "mysql2/promise";
import { record } from "../../../../ee/packages/den-db/scripts/migration-baseline.ts";
import { loadRecoveryArtifacts } from "../../../../ee/packages/den-db/scripts/recovery-0097-plan.ts";
import { applyRecovery, parseRecoveryArgs } from "../../../../ee/packages/den-db/scripts/recovery-0097.ts";
import type { DbHandle } from "./place.ts";

const repo = fileURLToPath(new URL("../../../..", import.meta.url));
const dbPackage = join(repo, "ee/packages/den-db");
const cli = "scripts/recover-mysql-0097.ts";
type ProcessResult = { code: number | null; signal?: string | null; stdout: string; stderr: string };
type Prompt = { prompt: string; reply: string };

export function recoveryApplyArgs(database: string): string[] {
  return ["--apply", "--non-interactive", "--confirm-database", database, "--backup-confirmed", "--writers-stopped"];
}

export function assertReadOnlyQueries(queries: string[]): void {
  assert.ok(queries.every(sql => /^(SELECT|SHOW)\b/i.test(sql) && !/GET_LOCK|RELEASE_LOCK|FOR UPDATE|INTO\s+(?:OUTFILE|DUMPFILE)/i.test(sql)), "Read-only CLI must not write, SET, acquire locks or export data");
}

async function processRun(bin: string, args: string[], env: NodeJS.ProcessEnv): Promise<ProcessResult> {
  const child = spawn(bin, args, { cwd: dbPackage, env, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", chunk => { stdout += String(chunk); });
  child.stderr.on("data", chunk => { stderr += String(chunk); });
  const timer = setTimeout(() => child.kill("SIGKILL"), 110_000);
  try {
    return await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => resolve({ code, signal, stdout, stderr }));
    });
  } finally { clearTimeout(timer); }
}

async function query(url: string, sql: string) {
  const connection = await createConnection(url);
  try { await connection.query(sql); } finally { await connection.end(); }
}

async function snapshot(url: string) {
  const connection = await createConnection(url);
  try {
    const [tables] = await connection.query<RowDataPacket[]>("SHOW FULL TABLES WHERE Table_type='BASE TABLE'");
    const schema: unknown[] = [];
    const data: unknown[] = [];
    const applicationData: unknown[] = [];
    for (const table of tables) {
      const name: unknown = Object.values(table)[0];
      assert.equal(typeof name, "string");
      assert.ok(typeof name === "string" && /^[a-zA-Z0-9_]+$/.test(name));
      const [ddl] = await connection.query<RowDataPacket[]>(`SHOW CREATE TABLE \`${name}\``);
      schema.push([name, ddl]);
      const [rows] = await connection.query<RowDataPacket[]>(`SELECT * FROM \`${name}\``);
      const contents = rows.map(row => JSON.stringify(row)).sort();
      data.push([name, contents]);
      if (name !== "__drizzle_migrations") applicationData.push([name, contents]);
    }
    const [ledger] = await connection.query<RowDataPacket[]>("SELECT id, hash, created_at FROM __drizzle_migrations ORDER BY id");
    const [primaryKeys] = await connection.query<RowDataPacket[]>("SELECT TABLE_NAME, COLUMN_NAME FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND INDEX_NAME='PRIMARY' ORDER BY TABLE_NAME, SEQ_IN_INDEX");
    const [marker] = await connection.query<RowDataPacket[]>("SELECT * FROM organization WHERE id='org_upgrade_fixture'");
    const [settings] = await connection.query<RowDataPacket[]>("SELECT @@GLOBAL.sql_require_primary_key AS globalPk, @@SESSION.sql_require_primary_key AS sessionPk, VERSION() AS version, @@version_comment AS platform, @@SESSION.sql_mode AS mode, @@GLOBAL.read_only AS readOnly, @@GLOBAL.super_read_only AS superReadOnly, @@SESSION.autocommit AS autocommit, DATABASE() AS db");
    const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
    return { schemaSha256: digest(schema), dataSha256: digest(data), applicationDataSha256: digest(applicationData), ledger, primaryKeys, marker, settings };
  } finally { await connection.end(); }
}

type RecoveryInput = {
  admin: Connection;
  env: NodeJS.ProcessEnv;
  reportPath: string;
  fixture(required: boolean): Promise<DbHandle>;
  bootstrap(url: string): Promise<ProcessResult>;
};

export async function runMysqlRecovery(input: RecoveryInput) {
  const artifacts = loadRecoveryArtifacts(join(dbPackage, "drizzle"));
  assert.equal(artifacts.safeSteps.length, 43);
  const sources: Record<string, string> = {};
  for (const name of [cli, "scripts/recovery-0097.ts", "scripts/recovery-0097-plan.ts", "scripts/migration-baseline.ts", "src/mysql-config.ts"]) {
    sources[name] = createHash("sha256").update(await readFile(join(dbPackage, name))).digest("hex");
  }
  const cases: { name: string; status: string; error?: string }[] = [];
  const commands: { label: string; command: string[]; result: ProcessResult; queries: string[]; pty?: boolean }[] = [];
  const snapshots: { label: string; state: Awaited<ReturnType<typeof snapshot>> }[] = [];
  const injections: { label: string; executed: string[]; completedSteps: number }[] = [];
  const metadataDrifts: { label: string; prefix: number; receiptCount: number; healthy: RowDataPacket[]; changed: RowDataPacket[]; mutationSql: string[]; restoreSql: string[] }[] = [];
  const report = {
    status: "running", runtime: process.version, sources, cases, commands, snapshots, injections, metadataDrifts,
    plannedCases: 33,
    counts: { passed: 0, failed: 0, skipped: 0, unexecuted: 33 },
    limitations: [
      "Native isolated MySQL only; no remote TLS, managed database, container, Helm or application health validation",
      "Exact release-tag source builds use installed dependency versions, not release-lockfile installs",
      "Synthetic organization and gateway rows only; no production credentials or data",
      "Interruption uses an executor fault against actual MySQL; CLI resume is a fresh process, not a network outage simulation",
    ],
  };
  const save = () => writeFile(input.reportPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  async function check(name: string, run: () => Promise<void>) {
    console.log(`[mysql-recovery] ${name}`);
    try {
      await run();
      cases.push({ name, status: "passed" });
      report.counts.passed++;
    } catch (error) {
      cases.push({ name, status: "failed", error: error instanceof Error ? error.message : "Unknown harness failure" });
      report.counts.failed++;
      report.status = "failed";
      throw error;
    } finally {
      report.counts.unexecuted = report.plannedCases - cases.length;
      await save();
    }
  }
  async function capture(label: string, url: string) {
    const state = await snapshot(url);
    snapshots.push({ label, state });
    return state;
  }
  const [adminRows] = await input.admin.query<RowDataPacket[]>("SELECT CONNECTION_ID() AS id");
  const adminId = Number(adminRows[0]?.id);
  assert.ok(Number.isInteger(adminId));
  await input.admin.query("SET GLOBAL log_output='TABLE'");
  async function run(label: string, database: DbHandle, args: string[], prompts?: Prompt[]) {
    await input.admin.query("TRUNCATE TABLE mysql.general_log");
    await input.admin.query("SET GLOBAL general_log=ON");
    let result: ProcessResult;
    try {
      const env = { ...input.env, DATABASE_URL: database.url };
      const nodeArgs = ["--import", "tsx", cli, ...args];
      if (prompts) {
        const wrapper = await processRun("python3", [join(repo, "evals/packages/env/src/mysql-recovery-pty.py"), JSON.stringify(prompts), process.execPath, ...nodeArgs], env);
        assert.equal(wrapper.code, 0, wrapper.stderr);
        const value: unknown = JSON.parse(wrapper.stdout);
        assert.ok(record(value) && typeof value.code === "number" && typeof value.stdout === "string" && typeof value.stderr === "string");
        assert.equal(value.pty, true);
        assert.equal(value.timedOut, false, value.stdout);
        assert.equal(value.answeredPrompts, prompts.length, value.stdout);
        result = { code: value.code, stdout: value.stdout, stderr: value.stderr };
      } else result = await processRun(process.execPath, nodeArgs, env);
    } finally { await input.admin.query("SET GLOBAL general_log=OFF"); }
    assert.ok(!result.stdout.includes(new URL(database.url).password) && !result.stderr.includes(new URL(database.url).password), "CLI leaked synthetic credential");
    const [rows] = await input.admin.query<RowDataPacket[]>("SELECT argument FROM mysql.general_log WHERE command_type='Query' AND thread_id<>? ORDER BY event_time", [adminId]);
    const queries = rows.map(row => String(row.argument));
    commands.push({ label, command: [process.execPath, "--import", "tsx", cli, ...args], result, queries, ...(prompts ? { pty: true } : {}) });
    assert.ok(!queries.some(sql => /PRIMARY KEY|sql_require_primary_key\s*=|SET\s+GLOBAL/i.test(sql)), "Recovery must not mutate PKs or global settings");
    await save();
    return { ...result, queries };
  }
  async function unchanged(label: string, database: DbHandle, args: string[], code: number, output: RegExp, prompts?: Prompt[]) {
    const before = await capture(`${label}:before`, database.url);
    const result = await run(label, database, args, prompts);
    const after = await capture(`${label}:after`, database.url);
    assert.deepEqual(after, before, `${label}: schema, ledger, data, PKs and settings must remain unchanged`);
    assert.equal(result.code, code, result.stderr || result.stdout);
    assert.match(result.stdout + result.stderr, output);
    assertReadOnlyQueries(result.queries);
  }
  async function complete(label: string, database: DbHandle, prompts?: Prompt[]) {
    const before = await capture(`${label}:before`, database.url);
    const result = await run(label, database, prompts ? ["--interactive"] : recoveryApplyArgs(database.name), prompts);
    const after = await capture(`${label}:after`, database.url);
    assert.equal(result.code, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /0097 verified complete/);
    assert.equal(after.ledger.length, 97);
    assert.deepEqual(after.ledger.slice(0, 96), before.ledger);
    assert.equal(after.ledger[96]?.hash, artifacts.plan[96].hash);
    assert.equal(Number(after.ledger[96]?.created_at), artifacts.plan[96].folderMillis);
    assert.equal(after.applicationDataSha256, before.applicationDataSha256);
    assert.deepEqual(after.primaryKeys, before.primaryKeys);
    assert.deepEqual(after.marker, before.marker);
    assert.deepEqual(after.settings, before.settings);
    assert.equal(after.settings[0]?.globalPk, 1);
    const ddl = result.queries.filter(sql => /^(ALTER|CREATE) /i.test(sql));
    assert.ok(ddl.length > 0 && ddl.length <= 43);
    assert.deepEqual(ddl, artifacts.safeSteps.slice(43 - ddl.length).map(step => step.sql.replace(/;$/, "")));
    assert.equal(result.queries.filter(sql => /^INSERT INTO `__drizzle_migrations`/.test(sql)).length, 1);
  }
  try {
    let main: DbHandle | undefined;
    await check("PK ON: release bootstrap reproduces line-86 failure with 96 receipts", async () => {
      main = await input.fixture(true);
      const state = await capture("reproduced", main.url);
      assert.equal(state.ledger.length, 96);
      assert.equal(state.settings[0]?.globalPk, 1);
      assert.equal(state.marker.length, 1);
      for (const table of artifacts.primaryTables) assert.ok(state.primaryKeys.some(row => row.TABLE_NAME === table && row.COLUMN_NAME === "id"));
    });
    assert.ok(main);
    const database = main;
    await check("default invocation is read-only at prefix 0", () => unchanged("default", database, [], 0, /0\/43 safe-tail/));
    await check("explicit dry-run is read-only at prefix 0", () => unchanged("dry-run", database, ["--dry-run"], 0, /Read-only inspection complete/));
    const refusals = [
      { name: "apply without noninteractive", args: ["--apply"], output: /Non-TTY/ },
      { name: "apply missing all acknowledgments", args: ["--apply", "--non-interactive"], output: /acknowledgments/ },
      { name: "apply missing backup", args: recoveryApplyArgs(database.name).filter(arg => arg !== "--backup-confirmed"), output: /acknowledgments/ },
      { name: "apply missing writers acknowledgment", args: recoveryApplyArgs(database.name).filter(arg => arg !== "--writers-stopped"), output: /acknowledgments/ },
      { name: "apply wrong database", args: recoveryApplyArgs("wrong_fixture"), output: /acknowledgments/ },
      { name: "interactive without TTY", args: ["--interactive"], output: /requires a TTY/ },
    ];
    for (const refusal of refusals) await check(refusal.name, () => unchanged(refusal.name, database, refusal.args, 1, refusal.output));
    await check("noninteractive recovery records 0097 and preserves every PK and marker", () => complete("apply", database));
    await check("97-receipt dry-run no-op", () => unchanged("97 dry-run", database, ["--dry-run"], 0, /97-receipt history/));
    await check("97-receipt apply no-op", () => unchanged("97 apply", database, recoveryApplyArgs(database.name), 0, /Read-only no-op/));
    await check("original .48 bootstrap completes 101 and clean rerun stays stable with PK ON", async () => {
      const before = await capture("before normal bootstrap", database.url);
      const first = await input.bootstrap(database.url);
      commands.push({ label: "normal .48 bootstrap", command: [process.execPath, "dist/scripts/bootstrap.js"], result: first, queries: [] });
      assert.equal(first.code, 0, first.stderr);
      const after = await capture("after normal bootstrap", database.url);
      assert.equal(after.ledger.length, 101);
      assert.deepEqual(after.ledger.slice(0, 97), before.ledger);
      assert.deepEqual(after.marker, before.marker);
      assert.deepEqual(after.settings, before.settings);
      for (const key of before.primaryKeys) assert.ok(after.primaryKeys.some(row => row.TABLE_NAME === key.TABLE_NAME && row.COLUMN_NAME === key.COLUMN_NAME));
      const retry = await input.bootstrap(database.url);
      commands.push({ label: "normal .48 rerun", command: [process.execPath, "dist/scripts/bootstrap.js"], result: retry, queries: [] });
      assert.equal(retry.code, 0, retry.stderr);
      assert.deepEqual(await capture("after normal bootstrap retry", database.url), after);
    });
    await check("101-receipt PK ON dry-run no-op", () => unchanged("101 ON dry-run", database, ["--dry-run"], 0, /101-receipt history/));
    await check("101-receipt PK ON apply no-op", () => unchanged("101 ON apply", database, recoveryApplyArgs(database.name), 0, /101-receipt history/));
    await check("clean PK OFF .35 to .48 upgrade: 101-receipt dry-run and apply no-op", async () => {
      const clean = await input.fixture(false);
      const state = await capture("clean PK OFF", clean.url);
      assert.equal(state.ledger.length, 101);
      assert.equal(state.settings[0]?.globalPk, 0);
      await unchanged("101 OFF dry-run", clean, ["--dry-run"], 0, /101-receipt history/);
      await unchanged("101 OFF apply", clean, recoveryApplyArgs(clean.name), 0, /101-receipt history/);
    });
    for (const fault of ["fourth-ddl", "before-receipt", "after-receipt-before-commit"]) {
      await check(`interruption ${fault}: fresh CLI recognizes prefix and resumes`, async () => {
        const interrupted = await input.fixture(true);
        const before = await capture(`${fault}:initial`, interrupted.url);
        const connection = await createConnection(interrupted.url);
        let completedSteps = 0;
        const executed: string[] = [];
        const injected = new Error(`Injected harness fault: ${fault}`);
        try {
          const executor = { query: async (sql: string, values: (string | number)[] = []) => {
            if ((fault === "fourth-ddl" && sql === artifacts.safeSteps[3].sql)
              || (fault === "before-receipt" && sql.startsWith("INSERT INTO `__drizzle_migrations`"))
              || (fault === "after-receipt-before-commit" && sql === "COMMIT")) throw injected;
            const [rows] = await connection.query(sql, values);
            executed.push(sql);
            if (artifacts.safeSteps.some(step => step.sql === sql)) {
              completedSteps++;
              const [keys] = await connection.query<RowDataPacket[]>("SELECT TABLE_NAME, COLUMN_NAME FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND INDEX_NAME='PRIMARY' ORDER BY TABLE_NAME, SEQ_IN_INDEX");
              assert.deepEqual(keys, before.primaryKeys);
            }
            const result: unknown = rows;
            return Array.isArray(result) ? result.filter(record) : [];
          } };
          await assert.rejects(applyRecovery(executor, artifacts, interrupted.name, parseRecoveryArgs(recoveryApplyArgs(interrupted.name))), error => error === injected);
        } finally { await connection.end(); }
        injections.push({ label: fault, executed, completedSteps });
        assert.equal(completedSteps, fault === "fourth-ddl" ? 3 : 43);
        const partial = await capture(`${fault}:partial`, interrupted.url);
        assert.equal(partial.applicationDataSha256, before.applicationDataSha256);
        assert.deepEqual(partial.ledger, before.ledger);
        assert.deepEqual(partial.primaryKeys, before.primaryKeys);
        assert.deepEqual(partial.marker, before.marker);
        assert.deepEqual(partial.settings, before.settings);
        await unchanged(`${fault}:inspect`, interrupted, ["--dry-run"], 0, new RegExp(`${completedSteps}/43 safe-tail`));
        if (completedSteps < 43) await complete(`${fault}:resume`, interrupted);
        else {
          const result = await run(`${fault}:resume`, interrupted, recoveryApplyArgs(interrupted.name));
          assert.equal(result.code, 0, result.stderr);
          assert.match(result.stdout, /0097 verified complete/);
          assert.ok(!result.queries.some(sql => /^(ALTER|CREATE) /i.test(sql)));
          const resumed = await capture(`${fault}:resumed`, interrupted.url);
          assert.equal(resumed.ledger.length, 97);
          assert.deepEqual(resumed.ledger.slice(0, 96), before.ledger);
          assert.equal(resumed.ledger[96]?.hash, artifacts.plan[96].hash);
          assert.equal(Number(resumed.ledger[96]?.created_at), artifacts.plan[96].folderMillis);
          assert.equal(resumed.applicationDataSha256, before.applicationDataSha256);
          assert.deepEqual(resumed.primaryKeys, before.primaryKeys);
          assert.deepEqual(resumed.marker, before.marker);
          assert.deepEqual(resumed.settings, before.settings);
        }
      });
    }
    const mutations = [
      { name: "nonempty gateway", sql: "INSERT INTO gateway_model_groups (id,gateway_provider_id,name) VALUES ('synthetic_group','synthetic_provider','Synthetic recovery fixture')", output: /nonempty/ },
      { name: "schema drift", sql: "ALTER TABLE organization ADD recovery_drift int", output: /Schema is not the supported/ },
      { name: "missing PK", sql: "SET SESSION sql_require_primary_key=OFF", output: /Schema is not the supported/ },
      { name: "history mismatch", sql: "UPDATE __drizzle_migrations SET hash=REPEAT('0',64) WHERE id=1", output: /history|receipt|hash|journal/i },
    ];
    for (const mutation of mutations) {
      await check(`${mutation.name} refuses dry-run and apply without changing schema, ledger or data`, async () => {
        const invalid = await input.fixture(true);
        if (mutation.name === "missing PK") {
          const connection = await createConnection(invalid.url);
          try {
            await connection.query(mutation.sql);
            await connection.query("ALTER TABLE gateway_rollup_lock DROP PRIMARY KEY");
          } finally { await connection.end(); }
        } else await query(invalid.url, mutation.sql);
        await unchanged(`${mutation.name}:dry-run`, invalid, ["--dry-run"], 1, mutation.output);
        await unchanged(`${mutation.name}:apply`, invalid, recoveryApplyArgs(invalid.name), 1, mutation.output);
      });
    }
    const interactive = await input.fixture(true);
    const choose = "Choose dry-run / apply / cancel [dry-run]: ";
    const exact = "Type the exact database name shown above (blank cancels): ";
    const backup = "Verified restorable backup and approved recovery window? Type yes [no]: ";
    const writers = "Stopped ALL app writers, workers, callbacks, jobs, cronjobs, Helm hooks and migration runners? Type yes [no]: ";
    await check("actual PTY: empty choice defaults to dry-run", () => unchanged("PTY default", interactive, ["--interactive"], 0, /Read-only inspection complete/, [{ prompt: choose, reply: "\n" }]));
    await check("actual PTY: explicit dry-run", () => unchanged("PTY dry-run", interactive, ["--interactive"], 0, /Read-only inspection complete/, [{ prompt: choose, reply: "dry-run\n" }]));
    await check("actual PTY: cancel", () => unchanged("PTY cancel", interactive, ["--interactive"], 0, /Cancelled; no changes/, [{ prompt: choose, reply: "cancel\n" }]));
    await check("actual PTY: wrong database refuses", () => unchanged("PTY wrong database", interactive, ["--interactive"], 1, /confirmation did not match/, [{ prompt: choose, reply: "apply\n" }, { prompt: exact, reply: "wrong_fixture\n" }]));
    await check("actual PTY: Ctrl-C cancels without writes", () => unchanged("PTY Ctrl-C", interactive, ["--interactive"], 1, /Rerun --dry-run/i, [{ prompt: choose, reply: "\u0003" }]));
    await check("actual PTY: EOF cancels without writes", () => unchanged("PTY EOF", interactive, ["--interactive"], 1, /Rerun --dry-run/i, [{ prompt: choose, reply: "\u0004" }]));
    await check("actual PTY: typed database, backup and writers acknowledgments complete recovery", () => complete("PTY apply", interactive, [
      { prompt: choose, reply: "apply\n" }, { prompt: exact, reply: `${interactive.name}\n` }, { prompt: backup, reply: "yes\n" }, { prompt: writers, reply: "yes\n" },
    ]));
    const canonicalCheck = artifacts.safeSteps.find(step => step.sql.startsWith("ALTER TABLE `gateway_provider_access` ADD CONSTRAINT `gateway_provider_access_audience` CHECK"));
    assert.ok(canonicalCheck);
    assert.equal(canonicalCheck.sql.split("'member:'").length, 2);
    const dropCheck = "ALTER TABLE gateway_provider_access DROP CHECK gateway_provider_access_audience";
    const literalDrifts = [
      {
        name: "apikey default literal preserves ON UPDATE text",
        metadataSql: "SELECT COLUMN_DEFAULT AS value FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='apikey' AND COLUMN_NAME='config_id'",
        mutationSql: ["ALTER TABLE apikey ALTER COLUMN config_id SET DEFAULT 'default ON UPDATE anything'"],
        restoreSql: ["ALTER TABLE apikey ALTER COLUMN config_id SET DEFAULT 'default'"],
        healthyValue: /^default$/,
        changedValue: /^default ON UPDATE anything$/,
        refusal: /Schema is not the supported/,
      },
      {
        name: "gateway CHECK literal preserves embedded whitespace",
        metadataSql: "SELECT CHECK_CLAUSE AS value FROM information_schema.CHECK_CONSTRAINTS WHERE CONSTRAINT_SCHEMA=DATABASE() AND CONSTRAINT_NAME='gateway_provider_access_audience'",
        mutationSql: [dropCheck, canonicalCheck.sql.replace("'member:'", "'mem ber:'")],
        restoreSql: [dropCheck, canonicalCheck.sql],
        healthyValue: /_utf8mb4\\'member:\\'/,
        changedValue: /_utf8mb4\\'mem ber:\\'/,
        refusal: /Unsupported CHECK literal serialization/,
      },
    ];
    for (const drift of literalDrifts) {
      await check(`real metadata drift: ${drift.name} refuses both modes at prefix 43 without receipt`, async () => {
        const invalid = await input.fixture(true);
        const initial = await capture(`${drift.name}:initial`, invalid.url);
        const prepare = await createConnection(invalid.url);
        try {
          for (const step of artifacts.safeSteps) await prepare.query(step.sql);
        } finally { await prepare.end(); }
        const healthy = await capture(`${drift.name}:healthy prefix 43`, invalid.url);
        assert.equal(healthy.ledger.length, 96);
        assert.deepEqual(healthy.ledger, initial.ledger);
        assert.deepEqual(healthy.primaryKeys, initial.primaryKeys);
        assert.deepEqual(healthy.settings, initial.settings);
        assert.equal(healthy.settings[0]?.globalPk, 1);
        assert.equal(healthy.applicationDataSha256, initial.applicationDataSha256);
        await unchanged(`${drift.name}:healthy control`, invalid, ["--dry-run"], 0, /43\/43 safe-tail/);
        const connection = await createConnection(invalid.url);
        try {
          const [before] = await connection.query<RowDataPacket[]>(drift.metadataSql);
          assert.equal(before.length, 1);
          assert.match(String(before[0]?.value), drift.healthyValue);
          for (const sql of drift.mutationSql) await connection.query(sql);
          const [after] = await connection.query<RowDataPacket[]>(drift.metadataSql);
          assert.equal(after.length, 1);
          assert.match(String(after[0]?.value), drift.changedValue);
          metadataDrifts.push({ label: drift.name, prefix: 43, receiptCount: healthy.ledger.length, healthy: before, changed: after, mutationSql: drift.mutationSql, restoreSql: drift.restoreSql });
        } finally { await connection.end(); }
        const changed = await capture(`${drift.name}:mutated`, invalid.url);
        assert.notEqual(changed.schemaSha256, healthy.schemaSha256);
        assert.equal(changed.dataSha256, healthy.dataSha256);
        assert.deepEqual(changed.primaryKeys, healthy.primaryKeys);
        assert.deepEqual(changed.settings, healthy.settings);
        await unchanged(`${drift.name}:dry-run refusal`, invalid, ["--dry-run"], 1, drift.refusal);
        await unchanged(`${drift.name}:apply refusal`, invalid, recoveryApplyArgs(invalid.name), 1, drift.refusal);
        for (const sql of drift.restoreSql) await query(invalid.url, sql);
        await unchanged(`${drift.name}:restored control`, invalid, ["--dry-run"], 0, /43\/43 safe-tail/);
        const restored = await capture(`${drift.name}:restored`, invalid.url);
        assert.deepEqual(restored.ledger, healthy.ledger);
        assert.equal(restored.applicationDataSha256, healthy.applicationDataSha256);
      });
    }
    await check("recovery source bytes unchanged throughout verification", async () => {
      for (const [name, hash] of Object.entries(sources)) assert.equal(createHash("sha256").update(await readFile(join(dbPackage, name))).digest("hex"), hash);
    });
    report.status = "passed";
    await save();
    return report;
  } finally { await input.admin.query("SET GLOBAL general_log=OFF"); }
}
