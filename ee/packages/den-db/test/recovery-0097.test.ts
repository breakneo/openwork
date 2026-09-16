import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { createInterface } from "node:readline/promises"
import { PassThrough } from "node:stream"
import { test } from "node:test"
import { fileURLToPath, pathToFileURL } from "node:url"
import { inspectSchema, journalTable, snapshotShape, stateTable } from "../scripts/migration-baseline.ts"
import { exactShape, loadRecoveryArtifacts, originalHash, originalTimestamp, projectRecovery, recognizeRecovery, validatePlan, verifyRecoveryFiles } from "../scripts/recovery-0097-plan.ts"
import { completionSql, preflightSql, receiptSql, sqlStatements, tailObjects } from "../scripts/recovery-0097-sql.ts"
import { applyRecovery, inspectRecovery, parseRecoveryArgs, recoveryLockName, requireApplyConfirmations, sanitizedFailure, validateServer, validateTerminal } from "../scripts/recovery-0097.ts"
import { invokedDirectly, recoveryConnectionConfig, terminalWizard, wizard } from "../scripts/recover-mysql-0097.ts"

const packageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const artifacts = loadRecoveryArtifacts(path.join(packageDir, "drizzle"))
const database = "recovery_copy"
const options = parseRecoveryArgs(["--apply", "--non-interactive", "--confirm-database", database, "--backup-confirmed", "--writers-stopped"])
const server = { version: "8.4.11", platform: "MySQL Community Server - GPL", mode: "STRICT_TRANS_TABLES,NO_ENGINE_SUBSTITUTION", db: database, readOnly: 0, superReadOnly: 0, autocommit: 1 }

function journalShape() {
  return new Map([
    [`table:${journalTable}`, "BASE TABLE:InnoDB"],
    [`column:${journalTable}.id`, JSON.stringify(["bigint unsigned", false, null, true, false])],
    [`column:${journalTable}.hash`, JSON.stringify(["text", false, null, false, false])],
    [`column:${journalTable}.created_at`, JSON.stringify(["bigint", true, null, false, false])],
    [`index:${journalTable}.PRIMARY`, JSON.stringify([["id"], true, "BTREE"])],
    [`index:${journalTable}.id`, JSON.stringify([["id"], true, "BTREE"])],
  ])
}

function fixture(prefix = 0, applied = 96) {
  const snapshot = artifacts.plan[applied - 1]?.snapshot
  const schema = applied >= 97 && snapshot ? snapshotShape(snapshot) : prefix ? artifacts.safeSteps[prefix - 1].shape : artifacts.initial
  const state = {
    shape: new Map(schema),
    ledger: journalShape(),
    columnMetadata: new Map<string, Record<string, unknown>>(),
    checkClauses: new Map<string, string>(),
    receipts: artifacts.plan.slice(0, applied).map((entry, index): Record<string, unknown> => ({ id: String(index + 1), hash: entry.hash, created_at: String(entry.folderMillis) })),
    server: { ...server },
    granted: true,
    nonempty: "",
    lock: 1,
    otherSessions: false,
    trigger: false,
    foreignKey: false,
    unenforced: false,
    invisible: false,
    partition: false,
    event: false,
    organizationMarker: "synthetic-marker-must-survive",
    failBefore: "",
    failAfter: "",
    beforeQuery: (_sql: string) => {},
    afterQuery: (_sql: string) => {},
  }
  const queries: { sql: string; args: (string | number)[] }[] = []
  let pending: Record<string, unknown> | undefined
  let transaction = false
  function metadata(sql: string) {
    const rows: Record<string, unknown>[] = []
    for (const [key, value] of new Map([...state.shape, ...state.ledger])) {
      const [kind, identifier] = key.split(":")
      const [tbl, name] = identifier.split(".")
      if (sql.startsWith("SELECT table_name AS `name`") && kind === "table") {
        const [tableKind, engine] = value.split(":")
        rows.push({ name: tbl, kind: tableKind, engine })
      }
      if (sql.startsWith("SELECT table_name AS `tbl`, column_name") && kind === "column") {
        const [type, nullable, def, auto, update]: [string, boolean, unknown, boolean, boolean] = JSON.parse(value)
        rows.push({ tbl, name, type, nullable: nullable ? "YES" : "NO", def, extra: `${auto ? "auto_increment" : ""} ${update ? "on update CURRENT_TIMESTAMP(3)" : ""}`, generated: "", ...state.columnMetadata.get(identifier) })
      }
      if (sql.startsWith("SELECT table_name AS `tbl`, index_name") && kind === "index") {
        const [columns, unique, type]: [string[], boolean, string] = JSON.parse(value)
        for (const col of columns) {
          const prefix = /\((\d+)\)$/.exec(col)
          rows.push({ tbl, name, col: col.replace(/\(\d+\)$/, ""), prefix: prefix ? Number(prefix[1]) : null, non_unique: unique ? 0 : 1, type, direction: "A", visible: "YES" })
        }
      }
      if (sql.startsWith("SELECT t.table_name") && kind === "check") rows.push({ tbl, name, kind: "CHECK", clause: state.checkClauses.get(identifier) ?? value, enforced: state.unenforced ? "NO" : "YES" })
    }
    if (sql.startsWith("SELECT t.table_name") && state.foreignKey) rows.push({ tbl: "organization", name: "unexpected", kind: "FOREIGN KEY" })
    return rows
  }
  async function run(sql: string, args: (string | number)[]): Promise<Record<string, unknown>[]> {
    if (sql.startsWith("SELECT VERSION()")) return [state.server]
    if (sql === "SHOW GRANTS FOR CURRENT_USER") return state.granted ? [{ grant: `GRANT ALL PRIVILEGES ON \`${database}\`.* TO 'operator'@'localhost'` }] : []
    if (sql.startsWith("SELECT table_name AS") || sql.startsWith("SELECT t.table_name")) return metadata(sql)
    if (sql.includes("information_schema.TRIGGERS")) return state.trigger ? [{}] : []
    if (sql.includes("information_schema.COLUMNS")) return state.invisible ? [{}] : []
    if (sql.includes("information_schema.PARTITIONS")) return state.partition ? [{}] : []
    if (sql.includes("information_schema.EVENTS")) return state.event ? [{}] : []
    if (sql.includes("information_schema.PROCESSLIST")) return state.otherSessions ? [{}] : []
    if (sql.startsWith("SELECT id, hash, created_at")) return structuredClone(state.receipts)
    if (sql === "SELECT GET_LOCK(?, 0) AS acquired") { assert.equal(args[0], recoveryLockName(database)); return [{ acquired: state.lock }] }
    if (sql === "SELECT RELEASE_LOCK(?)") { assert.equal(args[0], recoveryLockName(database)); return [{ released: 1 }] }
    const guard = /^SELECT 1 FROM `([a-z_]+)` LIMIT 1$/.exec(sql)
    if (guard) { assert.ok(artifacts.affected.includes(guard[1])); return state.nonempty === guard[1] ? [{ present: 1 }] : [] }
    if (["SET SESSION lock_wait_timeout = 15", "SET SESSION innodb_lock_wait_timeout = 15"].includes(sql)) return []
    const step = artifacts.safeSteps.findIndex((step) => step.sql === sql)
    if (step >= 0) {
      assert.equal(recognizeRecovery(artifacts, state.shape), step, "Must execute only the next exact safe-tail statement")
      state.shape = new Map(artifacts.safeSteps[step].shape)
      return []
    }
    if (sql === "START TRANSACTION") { transaction = true; return [] }
    if (sql === `INSERT INTO \`${journalTable}\` (hash, created_at) VALUES (?, ?)`) {
      assert.ok(transaction)
      assert.deepEqual(args, [originalHash, originalTimestamp])
      assert.ok(exactShape(state.shape, artifacts.finalShape))
      pending = { id: "97", hash: args[0], created_at: String(args[1]) }
      return []
    }
    if (sql === "COMMIT") {
      assert.ok(transaction && pending)
      state.receipts.push(pending)
      pending = undefined
      transaction = false
      return []
    }
    if (sql === "ROLLBACK") { pending = undefined; transaction = false; return [] }
    assert.fail("Unexpected query in offline recovery fixture")
  }
  const executor = { query: async (sql: string, args: (string | number)[] = []) => {
    queries.push({ sql, args })
    state.beforeQuery(sql)
    if (state.failBefore === sql) throw Object.assign(new Error("synthetic-secret SQL and row details"), { code: "ER_LOCK_WAIT_TIMEOUT", errno: 1205, sqlState: "HY000" })
    const result = await run(sql, args)
    state.afterQuery(sql)
    if (state.failAfter === sql) throw Object.assign(new Error("synthetic-secret response lost"), { code: "ECONNRESET" })
    return result
  } }
  return { state, executor, queries }
}

function onlyReads(queries: { sql: string }[]) {
  assert.ok(queries.every(({ sql }) => /^(SELECT|SHOW GRANTS)/.test(sql) && !/GET_LOCK|RELEASE_LOCK|FOR UPDATE/.test(sql)))
}

test("flags default read-only and reject ambiguous/credential arguments without echo", () => {
  assert.equal(parseRecoveryArgs([]).mode, "dry-run")
  assert.equal(parseRecoveryArgs(["--dry-run", "--non-interactive"]).nonInteractive, true)
  for (const args of [["--apply", "--dry-run"], ["--apply", "--apply"], ["--interactive", "--non-interactive"], ["--confirm-database"], ["--ca-file", "--apply"], ["mysql://operator:synthetic-secret@localhost/db"], ["--password", "synthetic-secret"]]) {
    assert.throws(() => parseRecoveryArgs(args), (error) => !sanitizedFailure(error).includes("synthetic-secret"))
  }
  assert.throws(() => validateTerminal(parseRecoveryArgs(["--apply"]), false), /Non-TTY/)
  assert.throws(() => validateTerminal(parseRecoveryArgs(["--interactive"]), false), /TTY/)
  validateTerminal(options, false)
  validateTerminal(parseRecoveryArgs([]), false)
  for (const change of [{ confirmDatabase: "wrong" }, { backupConfirmed: false }, { writersStopped: false }]) {
    assert.throws(() => requireApplyConfirmations({ ...options, ...change }, database), /acknowledgments/)
  }
})

test("wizard safe defaults, cancellation and all write confirmations", async () => {
  assert.equal((await wizard(parseRecoveryArgs(["--interactive"]), database, async () => ""))?.mode, "dry-run")
  assert.equal(await wizard(parseRecoveryArgs(["--interactive"]), database, async () => "cancel"), undefined)
  for (const answers of [["apply", "wrong"], ["apply", database, ""], ["apply", database, "yes", ""]]) {
    await assert.rejects(wizard(parseRecoveryArgs(["--interactive"]), database, async () => answers.shift() ?? ""), /cancelled|acknowledgments/)
  }
  const answers = ["apply", database, "yes", "yes"]
  const chosen = await wizard(parseRecoveryArgs(["--interactive"]), database, async () => answers.shift() ?? "")
  assert.ok(chosen)
  requireApplyConfirmations(chosen, database)
  assert.equal(chosen.mode, "apply")
  await assert.rejects(wizard(parseRecoveryArgs(["--interactive"]), database, async () => { throw new Error("cancelled") }), /cancelled/)
})

function scriptedTerminal(answers: string[]) {
  const input = new PassThrough()
  const output = new PassThrough()
  output.on("data", () => {
    const answer = answers.shift()
    setImmediate(() => { if (answer === undefined) input.end(); else input.write(`${answer}\n`) })
  })
  const terminal = createInterface({ input, output, terminal: false })
  return { terminal, cleanup: () => { terminal.close(); input.destroy(); output.destroy() } }
}

test("EOF cancels every pending wizard question through abort without entering apply", { timeout: 5_000 }, async () => {
  for (let answered = 0; answered < 4; answered++) {
    const input = scriptedTerminal(["apply", database, "yes"].slice(0, answered))
    const abort = new AbortController()
    const f = fixture()
    try {
      const run = async () => {
        const chosen = await terminalWizard(parseRecoveryArgs(["--interactive"]), database, input.terminal, abort)
        if (chosen?.mode === "apply") await applyRecovery(f.executor, artifacts, database, chosen, abort.signal)
      }
      await assert.rejects(run(), /Terminal input closed; recovery cancelled/)
      assert.equal(abort.signal.aborted, true)
      assert.equal(f.queries.length, 0)
      assert.equal(input.terminal.listenerCount("close"), 0)
    } finally { input.cleanup() }
  }
})

test("intentional wizard closure does not abort dry-run, cancel or subsequent apply", { timeout: 5_000 }, async () => {
  for (const action of ["dry-run", "cancel", "apply"]) {
    const input = scriptedTerminal(action === "apply" ? ["apply", database, "yes", "yes"] : [action])
    const abort = new AbortController()
    try {
      const chosen = await terminalWizard(parseRecoveryArgs(["--interactive"]), database, input.terminal, abort)
      assert.equal(abort.signal.aborted, false)
      assert.equal(input.terminal.listenerCount("close"), 0)
      if (action === "cancel") assert.equal(chosen, undefined)
      else assert.equal(chosen?.mode, action)
      if (chosen?.mode === "apply") {
        const f = fixture()
        f.state.afterQuery = (sql) => { if (sql === artifacts.safeSteps[0].sql) input.terminal.emit("close") }
        await applyRecovery(f.executor, artifacts, database, chosen, abort.signal)
        assert.equal(abort.signal.aborted, false)
        assert.equal(f.state.receipts.length, 97)
      }
    } finally { input.cleanup() }
  }
})

test("remote TLS requires trust and hostname verification, insecure aliases never override", () => {
  const remote = recoveryConnectionConfig("mysql://operator:synthetic-secret@db.example.test/recovery_copy")
  assert.deepEqual(remote.ssl, { rejectUnauthorized: true, verifyIdentity: true })
  assert.equal(remote.multipleStatements, false)
  assert.equal(remote.connectTimeout, 10_000)
  assert.equal(recoveryConnectionConfig("mysql://operator:synthetic-secret@[::1]/recovery_copy").host, "::1")
  for (const suffix of ["ssl=false", "sslmode=disable", "sslmode=DISABLE", "sslmode=prefer", "sslmode=requiredd", "sslmode=requir", "SSLMODE=require", "sslaccept=accept_invalid_certs", "sslmode=require&sslaccept=loose", "rejectUnauthorized=false", "sslmode=require&sslmode=disable", "ssl-mode=require&sslmode=require", "verifyIdentity=false", "socketPath=/tmp/mysql.sock"]) {
    assert.throws(() => recoveryConnectionConfig(`mysql://operator:synthetic-secret@db.example.test/recovery_copy?${suffix}`), (error) => !sanitizedFailure(error).includes("synthetic-secret"))
  }
  for (const suffix of ["sslmode=require", "sslmode=REQUIRE", "sslmode=required", "ssl-mode=Required", "sslmode=verify-FULL", "ssl-mode=Verify-Ca", "sslaccept=STRICT", "sslaccept=strict&ssl-mode=required"]) {
    for (const host of ["db.example.test", "127.0.0.1"]) {
      assert.deepEqual(recoveryConnectionConfig(`mysql://operator:synthetic-secret@${host}/recovery_copy?${suffix}`).ssl, { rejectUnauthorized: true, verifyIdentity: true }, `${host}?${suffix}`)
    }
  }
  assert.equal(recoveryConnectionConfig("mysql://operator:synthetic-secret@127.0.0.1/recovery_copy").ssl, undefined)
  assert.equal(recoveryConnectionConfig("mysql://operator:synthetic-secret@db.example.test/recovery_copy?sslmode=require", "CA").ssl?.ca, "CA")
  for (const url of ["not-a-url-synthetic-secret", "postgres://operator:synthetic-secret@localhost/db", "mysql://operator:synthetic-secret@localhost/db%0Asecret", "mysql://operator:synthetic-secret@localhost/db#secret"]) assert.throws(() => recoveryConnectionConfig(url))
})

test("platform bounds and strict session requirements are explicit", () => {
  for (const version of ["8.0.16", "8.0.46", "8.4.0", "8.4.11"]) validateServer({ ...server, version }, database)
  validateServer({ ...server, platform: "Homebrew", version: "8.4.11" }, database)
  assert.throws(() => validateServer({ ...server, platform: "Homebrew", version: "8.4.10" }, database), /Unsupported server/)
  for (const change of [
    { version: "5.7.44" }, { version: "8.0.15" }, { version: "8.0.47" }, { version: "8.4.12" }, { version: "9.0.0" },
    { version: "8.0.40-TiDB" }, { version: "10.11-MariaDB" }, { platform: "Aurora MySQL" }, { platform: "Vitess" },
    { mode: "NO_ENGINE_SUBSTITUTION" }, { db: "wrong" }, { readOnly: 1 }, { superReadOnly: 1 }, { autocommit: 0 },
  ]) {
    const observed = { ...server, ...change }
    assert.throws(() => validateServer(observed, database), (error) => {
      const message = sanitizedFailure(error)
      return /^Unsupported server/.test(message) && message.includes(`Observed VERSION()=${JSON.stringify(observed.version)} @@version_comment=${JSON.stringify(observed.platform)}`)
    })
  }
  assert.throws(() => validateServer({ ...server, platform: `${"x".repeat(200)}\n\u0000secret-tail` }, database), (error) => {
    const message = sanitizedFailure(error)
    return message.includes(`@@version_comment=${JSON.stringify("x".repeat(96))}`) && !message.includes("secret-tail") && !message.includes("\n")
  })
  assert.throws(() => validateServer(undefined, database), /Observed VERSION\(\)="" @@version_comment=""/)
})

test("bundle SQL: completion is exactly the safe tail plus the original receipt and preflight is read-only", () => {
  const completion = completionSql(artifacts)
  assert.deepEqual(sqlStatements(completion), [...artifacts.safeSteps.map((step) => step.sql), receiptSql])
  assert.equal(receiptSql, `INSERT INTO \`${journalTable}\` (hash, created_at) VALUES ('${originalHash}', ${originalTimestamp});`)
  assert.equal(sqlStatements(completion).filter((statement) => statement.startsWith("INSERT")).length, 1)
  assert.doesNotMatch(completion.split("\n").filter((line) => !line.startsWith("--")).join("\n"), /DROP|PRIMARY KEY|IF NOT EXISTS|DELETE|UPDATE |sql_require_primary_key|START TRANSACTION|BEGIN|COMMIT|SET /)
  assert.match(completion, /^-- .*completion SQL/)
  for (const line of completion.split("\n")) assert.ok(/^(--(?: .*)?|[^-].*|\s*)$/.test(line) && !/\s$/.test(line), JSON.stringify(line))
  const preflight = preflightSql(artifacts)
  const statements = sqlStatements(preflight)
  assert.equal(statements.length, 9)
  for (const statement of statements) {
    assert.match(statement, /^(SELECT|SHOW)\b/)
    assert.doesNotMatch(statement, /\b(?:GET_LOCK|RELEASE_LOCK|FOR UPDATE|LOCK IN SHARE MODE|INTO\s+(?:OUTFILE|DUMPFILE)|SET|INSERT|ALTER|CREATE|DROP|DELETE|UPDATE)\b/i)
  }
  assert.ok(preflight.includes(artifacts.plan[95].hash) && preflight.includes(String(artifacts.plan[95].folderMillis)) && !preflight.includes(originalHash))
  for (const table of [...artifacts.affected, ...artifacts.primaryTables]) assert.ok(preflight.includes(`'${table}'`), table)
  assert.match(preflight, /Expected: receipts = 96/)
  assert.match(preflight, /Expected: 12 rows, every has_rows = 0/)
  assert.match(preflight, /Expected: tail_objects_present = 0/)
  const tail = tailObjects(artifacts)
  assert.deepEqual([tail.columns.length, tail.indexes.length, tail.checks.length], [13, 28, 1])
  for (const mutate of [
    (plan: typeof artifacts.safeSteps) => { plan[0].sql = plan[0].sql.slice(0, -1) },
    (plan: typeof artifacts.safeSteps) => { plan[5].sql = plan[5].sql.replace("ADD", "DROP") },
    (plan: typeof artifacts.safeSteps) => { plan.pop() },
  ]) {
    const mutated = structuredClone(artifacts)
    mutate(mutated.safeSteps)
    assert.throws(() => completionSql(mutated), /does not match the pinned artifacts/)
  }
  assert.throws(() => loadRecoveryArtifacts(path.join(packageDir, "missing-recovery-artifacts")), /Missing recovery artifacts/)
})

test("pinned metadata projects exactly line 85 and every safe prefix without PK changes", () => {
  assert.equal(artifacts.safeSteps.length, 43)
  assert.equal(artifacts.safeSteps[0].line, 94)
  assert.equal(artifacts.safeSteps.at(-1)?.line, 150)
  assert.equal(artifacts.affected.length, 12)
  assert.equal(artifacts.primaryTables.length, 8)
  assert.equal(recognizeRecovery(artifacts, artifacts.initial), 0)
  assert.ok(artifacts.initial.has("index:gateway_keys.gateway_keys_key_hash"))
  assert.ok(!artifacts.initial.has("index:gateway_keys.gateway_keys_status"))
  for (const [index, step] of artifacts.safeSteps.entries()) {
    assert.equal(recognizeRecovery(artifacts, step.shape), index + 1)
    assert.doesNotMatch(step.sql, /DROP|PRIMARY KEY|IF NOT EXISTS|DELETE|INSERT|UPDATE /)
    for (const table of artifacts.primaryTables) {
      for (const key of [`index:${table}.PRIMARY`, `column:${table}.id`]) assert.equal(step.shape.get(key), artifacts.initial.get(key))
    }
  }
  assert.ok(exactShape(artifacts.safeSteps.at(-1)?.shape ?? new Map(), artifacts.finalShape))
})

test("changed SQL bytes, SQL hashes, snapshots, timestamps, chain and history length refuse", () => {
  for (const mutate of [
    (plan: typeof artifacts.plan) => { plan[96].sql[0] += " " },
    (plan: typeof artifacts.plan) => { plan[0].sql[0] += " " },
    (plan: typeof artifacts.plan) => { plan[96].hash = "changed" },
    (plan: typeof artifacts.plan) => { plan[95].folderMillis++ },
    (plan: typeof artifacts.plan) => { plan[96].tag = "0097_other" },
    (plan: typeof artifacts.plan) => { const snapshot = plan[95].snapshot; assert.ok(snapshot); snapshot.id = "changed" },
    (plan: typeof artifacts.plan) => { const snapshot = plan[100].snapshot; assert.ok(snapshot); delete snapshot.tables.organization.columns.name },
    (plan: typeof artifacts.plan) => { plan.pop() },
  ]) {
    const plan = structuredClone(artifacts.plan)
    mutate(plan)
    assert.throws(() => validatePlan(plan), /Unsupported recovery artifacts/)
    assert.throws(() => projectRecovery(plan), /Unsupported recovery artifacts/)
  }
})

test("raw journal and both projection snapshot byte identities are mandatory", () => {
  for (const changed of ["meta/_journal.json", "meta/0096_snapshot.json", "meta/0097_snapshot.json"]) {
    for (const append of [" ", "\n", "changed"]) {
      assert.throws(() => verifyRecoveryFiles((name) => readFileSync(path.join(packageDir, "drizzle", name), "utf8") + (name === changed ? append : "")), /Unsupported recovery artifacts/)
    }
    assert.throws(() => verifyRecoveryFiles((name) => {
      if (name === changed) throw new Error("Missing artifact")
      return readFileSync(path.join(packageDir, "drizzle", name), "utf8")
    }), /Missing artifact/)
  }
})

test("dry-run executes only read statements and no row-content probes", async () => {
  const f = fixture()
  const result = await inspectRecovery(f.executor, artifacts, database)
  assert.equal(result.prefix, 0)
  assert.equal(result.completed, false)
  onlyReads(f.queries)
  assert.equal(f.queries.filter(({ sql }) => /^SELECT 1 FROM `gateway_/.test(sql)).length, 12)
  assert.ok(f.queries.every(({ sql }) => !/SELECT \*|SELECT (?:name|email|password)|COUNT\(/.test(sql)))
})

test("recovery refuses modified varchar defaults and actual quote characters in partial and completed states", async () => {
  for (const [prefix, applied] of [[0, 96], [43, 96], [0, 97], [0, 101]]) {
    const healthy = fixture(prefix, applied)
    healthy.state.columnMetadata.set("apikey.config_id", { def: "default" })
    await inspectRecovery(healthy.executor, artifacts, database)
    for (const def of ["default ON UPDATE anything", "default ON UPDATE CURRENT_TIMESTAMP(3)", "'default'", "''default''", '"default"', "DEFAULT"]) {
      const f = fixture(prefix, applied)
      f.state.columnMetadata.set("apikey.config_id", { def })
      await assert.rejects(inspectRecovery(f.executor, artifacts, database), /Schema is not|schema does not match/)
      onlyReads(f.queries)
    }
  }
})

test("CHECK normalization preserves literal text while accepting known native serialization", async () => {
  const native = "(((`org_membership_id` is null) or (`team_id` is null)) and (`audience_key` = (case when (`org_membership_id` is not null) then concat(_utf8mb4'member:',`org_membership_id`) when (`team_id` is not null) then concat(_utf8mb4'team:',`team_id`) else _utf8mb4'organization' end)))"
  for (const [prefix, applied] of [[26, 96], [43, 96], [0, 97], [0, 101]]) {
    for (const clause of [native, native.replace(/_utf8mb4'(member:|team:|organization)'/g, "_utf8mb4\\'$1\\'")]) {
      const f = fixture(prefix, applied)
      f.state.checkClauses.set("gateway_provider_access.gateway_provider_access_audience", clause)
      await inspectRecovery(f.executor, artifacts, database)
      onlyReads(f.queries)
    }
    for (const literal of ["'mem ber:'", "'mem`ber:'", "'mem\nber:'", "'member: '", "'MEMBER:'", "'mem''ber:'", String.raw`'mem\'ber:'`, "'mem(ber:)'", String.raw`'_utf8mb4\'member:\''`]) {
      const f = fixture(prefix, applied)
      f.state.checkClauses.set("gateway_provider_access.gateway_provider_access_audience", native.replace("'member:'", literal))
      await assert.rejects(inspectRecovery(f.executor, artifacts, database), /Schema is not|schema does not match|Unsupported CHECK/)
      onlyReads(f.queries)
    }
  }
})

test("default normalization is type-aware and decodes SQL literals only in snapshots", async () => {
  const source = artifacts.plan[96].snapshot
  assert.ok(source)
  const cases: { type: string; snapshotDefault: unknown; actualDefault: unknown; extra?: string; equal: boolean }[] = [
    { type: "varchar(255)", snapshotDefault: "'true'", actualDefault: "true", equal: true },
    { type: "varchar(255)", snapshotDefault: "'true'", actualDefault: "1", equal: false },
    { type: "varchar(255)", snapshotDefault: "'1'", actualDefault: "true", equal: false },
    { type: "varchar(255)", snapshotDefault: "'false'", actualDefault: "0", equal: false },
    { type: "varchar(255)", snapshotDefault: "'default ON UPDATE anything'", actualDefault: "default ON UPDATE anything", equal: true },
    { type: "varchar(255)", snapshotDefault: "'auto_increment'", actualDefault: "auto_increment", equal: true },
    { type: "varchar(255)", snapshotDefault: "'foo''bar'", actualDefault: "foo'bar", equal: true },
    { type: "varchar(255)", snapshotDefault: "'''default'''", actualDefault: "'default'", equal: true },
    { type: "varchar(255)", snapshotDefault: "'''default'''", actualDefault: "default", equal: false },
    { type: "varchar(255)", snapshotDefault: "'json_array()'", actualDefault: "(JSON_ARRAY())", equal: false },
    { type: "varchar(255)", snapshotDefault: "'CURRENT_TIMESTAMP'", actualDefault: "now()", equal: false },
    { type: "varchar(255)", snapshotDefault: "'CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP'", actualDefault: "CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP", equal: true },
    { type: "boolean", snapshotDefault: true, actualDefault: "1", equal: true },
    { type: "boolean", snapshotDefault: false, actualDefault: "0", equal: true },
    { type: "json", snapshotDefault: "(JSON_ARRAY())", actualDefault: "json_array()", equal: true },
    { type: "json", snapshotDefault: "(json_object())", actualDefault: "json_object()", equal: true },
    ...["timestamp(3)", "datetime(3)"].flatMap((type) => [
      { type, snapshotDefault: "CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3)", actualDefault: "CURRENT_TIMESTAMP(3)", extra: "on update CURRENT_TIMESTAMP(3)", equal: true },
      { type, snapshotDefault: "CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3)", actualDefault: "CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3)", extra: "on update CURRENT_TIMESTAMP(3)", equal: false },
    ]),
  ]
  for (const scenario of cases) {
    const snapshot: typeof source = structuredClone(source)
    snapshot.tables.apikey.columns.config_id.type = scenario.type
    snapshot.tables.apikey.columns.config_id.default = scenario.snapshotDefault
    const expected = snapshotShape(snapshot).get("column:apikey.config_id")
    const f = fixture()
    f.state.columnMetadata.set("apikey.config_id", { type: scenario.type === "boolean" ? "tinyint(1)" : scenario.type, def: scenario.actualDefault, extra: scenario.extra ?? "" })
    const actual = (await inspectSchema(f.executor)).shape.get("column:apikey.config_id")
    assert.equal(expected === actual, scenario.equal, JSON.stringify(scenario))
  }
})

test("unknown schema, missing PKs, altered id, unexpected objects and earlier states refuse", async () => {
  const snapshot = artifacts.plan[95].snapshot
  assert.ok(snapshot)
  const shapes = [snapshotShape(snapshot), new Map<string, string>()]
  for (const key of [...artifacts.primaryTables.flatMap((table) => [`index:${table}.PRIMARY`, `column:${table}.id`]), "column:organization.name", "index:account.account_account_id_provider_id"]) {
    const shape = new Map(artifacts.initial)
    shape.delete(key)
    shapes.push(shape)
  }
  for (const [key, value] of [
    ["column:gateway_providers.id", JSON.stringify(["varchar(255)", false, null, false, false])],
    ["table:unexpected_view", "VIEW:null"], ["table:unexpected", "BASE TABLE:InnoDB"], ["table:organization", "BASE TABLE:MyISAM"],
    ["index:gateway_keys.unexpected", JSON.stringify([["id"], false, "BTREE"])],
    ["check:gateway_keys.unexpected", "1=1"], ["table:" + stateTable, "BASE TABLE:InnoDB"],
  ]) shapes.push(new Map([...artifacts.initial, [key, value]]))
  for (const shape of shapes) {
    const f = fixture()
    f.state.shape = shape
    await assert.rejects(inspectRecovery(f.executor, artifacts, database))
    onlyReads(f.queries)
  }
  for (const flag of ["trigger", "foreignKey", "invisible", "partition", "event"]) {
    const f = fixture()
    Object.assign(f.state, { [flag]: true })
    await assert.rejects(inspectRecovery(f.executor, artifacts, database))
  }
  const check = fixture(43)
  check.state.unenforced = true
  await assert.rejects(inspectRecovery(check.executor, artifacts, database), /unenforced check/)
  const grants = fixture()
  grants.state.granted = false
  await assert.rejects(inspectRecovery(grants.executor, artifacts, database), /metadata visibility/)
  const ledger = fixture()
  ledger.state.ledger.set(`column:${journalTable}.unexpected`, JSON.stringify(["int", true, null, false, false]))
  await assert.rejects(inspectRecovery(ledger.executor, artifacts, database), /ledger schema/)
})

test("all 12 affected nonempty tables refuse, including target awaiting receipt", async () => {
  for (const table of artifacts.affected) {
    for (const prefix of [0, 43]) {
      const f = fixture(prefix)
      f.state.nonempty = table
      await assert.rejects(applyRecovery(f.executor, artifacts, database, options), /nonempty/)
      onlyReads(f.queries)
    }
  }
})

test("missing, reordered, duplicate, unknown and mis-timestamped receipts refuse", async () => {
  for (const mutate of [
    (rows: Record<string, unknown>[]) => { rows[0].hash = "wrong" },
    (rows: Record<string, unknown>[]) => { rows[95].created_at = originalTimestamp },
    (rows: Record<string, unknown>[]) => { rows[5].created_at = "001" },
    (rows: Record<string, unknown>[]) => { rows[1].id = "1" },
    (rows: Record<string, unknown>[]) => { rows.splice(3, 1) },
    (rows: Record<string, unknown>[]) => { rows.pop() },
    (rows: Record<string, unknown>[]) => { rows.push({ ...rows[95], id: "97" }) },
    (rows: Record<string, unknown>[]) => { rows.reverse() },
    (rows: Record<string, unknown>[]) => { rows.length = 0 },
  ]) {
    const f = fixture()
    mutate(f.state.receipts)
    await assert.rejects(inspectRecovery(f.executor, artifacts, database))
    onlyReads(f.queries)
  }
})

test("canonical 0097+ completed states are fully verified read-only no-ops, never emptiness-guarded", async () => {
  for (let applied = 97; applied <= artifacts.plan.length; applied++) {
    const f = fixture(0, applied)
    f.state.nonempty = artifacts.affected[0]
    const result = await applyRecovery(f.executor, artifacts, database, options)
    assert.equal(result.applied, applied)
    assert.equal(result.completed, true)
    onlyReads(f.queries)
    f.state.shape.delete("column:organization.name")
    await assert.rejects(applyRecovery(f.executor, artifacts, database, options), /no mutation permitted/)
    onlyReads(f.queries)
  }
})

test("no write path without explicit apply and all acknowledgments", async () => {
  for (const invalid of [{ ...options, mode: "dry-run" }, { ...options, backupConfirmed: false }, { ...options, writersStopped: false }, { ...options, confirmDatabase: "wrong" }]) {
    const f = fixture()
    await assert.rejects(applyRecovery(f.executor, artifacts, database, parseRecoveryArgs([
      invalid.mode === "apply" ? "--apply" : "--dry-run", "--non-interactive",
      "--confirm-database", invalid.confirmDatabase ?? "", ...(invalid.backupConfirmed ? ["--backup-confirmed"] : []), ...(invalid.writersStopped ? ["--writers-stopped"] : []),
    ])))
    assert.equal(f.queries.length, 0)
  }
})

test("lock conflict, competing sessions and post-lock changes prevent DDL", async () => {
  assert.equal(recoveryLockName("Case"), recoveryLockName("case"))
  assert.notEqual(recoveryLockName(database), recoveryLockName("other"))
  for (const setup of [
    (f: ReturnType<typeof fixture>) => { f.state.lock = 0 },
    (f: ReturnType<typeof fixture>) => { f.state.otherSessions = true },
    (f: ReturnType<typeof fixture>) => { f.state.afterQuery = (sql) => { if (sql.includes("GET_LOCK")) f.state.nonempty = artifacts.affected[0] } },
    (f: ReturnType<typeof fixture>) => { f.state.afterQuery = (sql) => { if (sql.includes("GET_LOCK")) f.state.shape.delete("column:organization.name") } },
    (f: ReturnType<typeof fixture>) => { f.state.afterQuery = (sql) => { if (sql.includes("GET_LOCK")) f.state.receipts[0].hash = "changed" } },
  ]) {
    const f = fixture()
    setup(f)
    await assert.rejects(applyRecovery(f.executor, artifacts, database, options))
    assert.ok(f.queries.every(({ sql }) => /^(SELECT|SHOW)/.test(sql)))
    if (f.state.lock) assert.equal(f.queries.at(-1)?.sql, "SELECT RELEASE_LOCK(?)")
  }
})

test("all safe-tail interruption prefixes resume with exactly one original receipt", async () => {
  for (let prefix = 0; prefix <= artifacts.safeSteps.length; prefix++) {
    const f = fixture(prefix)
    const original = structuredClone(f.state.receipts)
    await applyRecovery(f.executor, artifacts, database, options)
    assert.deepEqual(f.state.receipts.slice(0, 96), original)
    assert.equal(f.state.receipts.length, 97)
    assert.equal(f.state.organizationMarker, "synthetic-marker-must-survive")
    const ddl = f.queries.filter(({ sql }) => artifacts.safeSteps.some((step) => step.sql === sql))
    assert.deepEqual(ddl.map(({ sql }) => sql), artifacts.safeSteps.slice(prefix).map((step) => step.sql))
    assert.equal(f.queries.filter(({ sql }) => sql.startsWith("INSERT")).length, 1)
    const receipt = f.queries.findIndex(({ sql }) => sql.startsWith("INSERT"))
    const lockedHistory = f.queries.findIndex(({ sql }) => sql.endsWith("FOR UPDATE"))
    assert.ok(lockedHistory < receipt && lockedHistory > 0)
    assert.equal(f.queries.at(-1)?.sql, "SELECT RELEASE_LOCK(?)")
    assert.ok(f.queries.every(({ sql }) => !/DROP|DELETE|UPDATE `|sql_require_primary_key|IF NOT EXISTS/.test(sql)))
  }
})

test("each uncertain DDL response is attempted once, no receipt, then recognized on fresh inspection", async () => {
  for (const [index, step] of artifacts.safeSteps.entries()) {
    const f = fixture(index)
    f.state.failAfter = step.sql
    await assert.rejects(applyRecovery(f.executor, artifacts, database, options))
    assert.equal(f.state.receipts.length, 96)
    assert.equal(f.queries.filter(({ sql }) => sql === step.sql).length, 1)
    assert.ok(!f.queries.some(({ sql }) => sql.startsWith("INSERT")))
    assert.equal(f.queries.at(-1)?.sql, "SELECT RELEASE_LOCK(?)")
    f.state.failAfter = ""
    assert.equal((await inspectRecovery(f.executor, artifacts, database)).prefix, index + 1)
  }
})

test("failed DDL before commit remains at same prefix without an automatic retry", async () => {
  const f = fixture()
  f.state.failBefore = artifacts.safeSteps[0].sql
  await assert.rejects(applyRecovery(f.executor, artifacts, database, options))
  assert.equal(recognizeRecovery(artifacts, f.state.shape), 0)
  assert.equal(f.queries.filter(({ sql }) => sql === f.state.failBefore).length, 1)
  assert.equal(f.state.receipts.length, 96)
})

test("fresh pre-apply inspection after human confirmation is not stale", async () => {
  const f = fixture()
  await inspectRecovery(f.executor, artifacts, database)
  const answers = [database, "yes", "yes"]
  const chosen = await wizard({ ...options, nonInteractive: false }, database, async () => {
    f.state.nonempty = artifacts.affected[0]
    return answers.shift() ?? ""
  })
  assert.ok(chosen)
  await assert.rejects(applyRecovery(f.executor, artifacts, database, chosen), /nonempty/)
  onlyReads(f.queries)
})

test("target schema and full prefix are rechecked before receipt, including inside transaction", async () => {
  for (const point of ["final-schema", "final-history", "transaction-history", "transaction-schema", "transaction-data"]) {
    const f = fixture(42)
    f.state.afterQuery = (sql) => {
      if (sql === artifacts.safeSteps[42].sql) {
        if (point === "final-schema") f.state.shape.delete("column:organization.name")
        if (point === "final-history") f.state.receipts[0].hash = "changed"
      }
      if (sql === "START TRANSACTION") {
        if (point === "transaction-history") f.state.receipts[0].hash = "changed"
        if (point === "transaction-schema") f.state.shape.delete("column:organization.name")
        if (point === "transaction-data") f.state.nonempty = artifacts.affected[0]
      }
    }
    await assert.rejects(applyRecovery(f.executor, artifacts, database, options))
    assert.ok(!f.queries.some(({ sql }) => sql.startsWith("INSERT")))
    if (point === "transaction-history") assert.ok(f.queries.some(({ sql }) => sql === "ROLLBACK"))
    assert.equal(f.queries.at(-1)?.sql, "SELECT RELEASE_LOCK(?)")
  }
})

test("cancelled apply cleans up, and uncertain COMMIT becomes a read-only no-op on retry", async () => {
  const abort = new AbortController()
  const f = fixture()
  f.state.afterQuery = (sql) => { if (sql === artifacts.safeSteps[0].sql) abort.abort() }
  await assert.rejects(applyRecovery(f.executor, artifacts, database, options, abort.signal), /cancelled/)
  assert.equal(f.state.receipts.length, 96)
  assert.equal(f.queries.at(-1)?.sql, "SELECT RELEASE_LOCK(?)")
  const before = fixture()
  await assert.rejects(applyRecovery(before.executor, artifacts, database, options, abort.signal), /cancelled/)
  assert.equal(before.queries.length, 0)
  const commit = fixture(43)
  commit.state.failAfter = "COMMIT"
  await assert.rejects(applyRecovery(commit.executor, artifacts, database, options))
  assert.equal(commit.state.receipts.length, 97)
  commit.state.failAfter = ""
  commit.queries.length = 0
  await applyRecovery(commit.executor, artifacts, database, options)
  onlyReads(commit.queries)
  const insert = fixture(43)
  insert.state.failAfter = `INSERT INTO \`${journalTable}\` (hash, created_at) VALUES (?, ?)`
  await assert.rejects(applyRecovery(insert.executor, artifacts, database, options))
  assert.equal(insert.state.receipts.length, 96)
  assert.ok(insert.queries.some(({ sql }) => sql === "ROLLBACK"))
})

test("cleanup still releases lock after rollback failure and never retries committed recovery", async () => {
  const rollback = fixture(43)
  rollback.state.failAfter = `INSERT INTO \`${journalTable}\` (hash, created_at) VALUES (?, ?)`
  rollback.state.failBefore = "ROLLBACK"
  await assert.rejects(applyRecovery(rollback.executor, artifacts, database, options))
  assert.equal(rollback.queries.at(-1)?.sql, "SELECT RELEASE_LOCK(?)")
  const release = fixture(43)
  release.state.failBefore = "SELECT RELEASE_LOCK(?)"
  await assert.rejects(applyRecovery(release.executor, artifacts, database, options))
  assert.equal(release.state.receipts.length, 97)
  release.state.failBefore = ""
  release.queries.length = 0
  await applyRecovery(release.executor, artifacts, database, options)
  onlyReads(release.queries)
})

test("driver errors never reveal SQL, URLs, credentials, paths or row contents", () => {
  const error = Object.assign(new Error("synthetic-secret mysql://operator:synthetic-secret@localhost/db INSERT row"), { code: "ER_DUP_ENTRY", errno: 1062, sqlState: "23000", sql: "secret SQL", sqlMessage: "secret row" })
  const output = sanitizedFailure(error)
  assert.match(output, /code=ER_DUP_ENTRY, errno=1062, sqlState=23000/)
  assert.doesNotMatch(output, /synthetic-secret|mysql:\/\/|secret SQL|secret row/)
  assert.doesNotMatch(sanitizedFailure({ code: "secret-password", errno: "secret", sqlState: "secret-password" }), /secret-password/)
})

test("entry detection follows symlinked and relative invocations without running on import", () => {
  const cli = path.join(packageDir, "scripts/recover-mysql-0097.ts")
  const url = pathToFileURL(cli).href
  assert.equal(invokedDirectly(cli, url), true)
  assert.equal(invokedDirectly(path.relative(process.cwd(), cli), url), true)
  assert.equal(invokedDirectly(undefined, url), false)
  assert.equal(invokedDirectly(path.join(packageDir, "scripts/recovery-0097.ts"), url), false)
  assert.equal(invokedDirectly(path.join(packageDir, "missing.mjs"), url), false)
  const directory = mkdtempSync(path.join(tmpdir(), "ow-recovery-entry-"))
  try {
    symlinkSync(path.dirname(cli), path.join(directory, "linked"))
    assert.equal(invokedDirectly(path.join(directory, "linked", "recover-mysql-0097.ts"), url), true)
    assert.equal(invokedDirectly(path.join(directory, "linked", "recovery-0097.ts"), url), false)
  } finally { rmSync(directory, { recursive: true, force: true }) }
})

test("CLI help needs no database and noninteractive invalid apply fails without prompting or credential output", () => {
  const cli = path.join(packageDir, "scripts/recover-mysql-0097.ts")
  const help = spawnSync(process.execPath, ["--import", "tsx", cli, "--help"], { cwd: packageDir, encoding: "utf8", env: { ...process.env, DATABASE_URL: "" } })
  assert.equal(help.status, 0)
  assert.match(help.stdout, /Default: --dry-run/)
  for (const args of [["--apply"], ["--apply", "--non-interactive"], ["--password", "synthetic-secret"]]) {
    const child = spawnSync(process.execPath, ["--import", "tsx", cli, ...args], { cwd: packageDir, encoding: "utf8", timeout: 10_000, env: { ...process.env, DATABASE_URL: "mysql://operator:synthetic-secret@127.0.0.1/recovery_copy" } })
    assert.equal(child.status, 1)
    assert.doesNotMatch(child.stdout + child.stderr, /synthetic-secret|Type the exact|Choose dry-run/)
  }
})
