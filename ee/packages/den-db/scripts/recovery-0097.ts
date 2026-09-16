import { createHash } from "node:crypto"
import { inspectSchema, historyPrefix, journalTable, MigrationSafetyError, record, snapshotShape, stateTable } from "./migration-baseline.ts"
import { exactShape, originalHash, originalTimestamp, recognizeRecovery, type RecoveryArtifacts } from "./recovery-0097-plan.ts"
import type { Executor } from "../src/schema-repairs.ts"

export type RecoveryOptions = {
  mode: "dry-run" | "apply" | "interactive"
  nonInteractive: boolean
  confirmDatabase?: string
  backupConfirmed: boolean
  writersStopped: boolean
  caFile?: string
  help: boolean
}

export function parseRecoveryArgs(args: string[]): RecoveryOptions {
  const options: RecoveryOptions = { mode: "dry-run", nonInteractive: false, backupConfirmed: false, writersStopped: false, help: false }
  const seen = new Set<string>()
  let modeSet = false
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (seen.has(arg)) throw new MigrationSafetyError("Duplicate option; see --help.")
    seen.add(arg)
    if (["--dry-run", "--apply", "--interactive"].includes(arg)) {
      if (modeSet) throw new MigrationSafetyError("Choose only one of --dry-run, --apply or --interactive.")
      modeSet = true
      options.mode = arg === "--apply" ? "apply" : arg === "--interactive" ? "interactive" : "dry-run"
    } else if (arg === "--non-interactive") options.nonInteractive = true
    else if (arg === "--backup-confirmed") options.backupConfirmed = true
    else if (arg === "--writers-stopped") options.writersStopped = true
    else if (arg === "--help") options.help = true
    else if (arg === "--confirm-database" || arg === "--ca-file") {
      const value = args[++i]
      if (!value || value.startsWith("--")) throw new MigrationSafetyError("Missing option value; see --help.")
      if (arg === "--confirm-database") options.confirmDatabase = value
      else options.caFile = value
    } else throw new MigrationSafetyError("Unknown option (value withheld); credentials belong only in DATABASE_URL.")
  }
  if (options.mode === "interactive" && options.nonInteractive) throw new MigrationSafetyError("--interactive conflicts with --non-interactive.")
  return options
}

export function requireApplyConfirmations(options: RecoveryOptions, database: string) {
  if (options.confirmDatabase !== database || !options.backupConfirmed || !options.writersStopped) {
    throw new MigrationSafetyError("Apply requires exact --confirm-database, --backup-confirmed and --writers-stopped acknowledgments.")
  }
}

export function validateTerminal(options: RecoveryOptions, tty: boolean) {
  if (options.mode === "interactive" && !tty) throw new MigrationSafetyError("Interactive mode requires a TTY.")
  if (options.mode === "apply" && !tty && !options.nonInteractive) {
    throw new MigrationSafetyError("Non-TTY apply requires --non-interactive and all write acknowledgments.")
  }
}

export function validateServer(server: Record<string, unknown> | undefined, database: string) {
  const version = String(server?.version).match(/^8\.(0|4)\.(\d+)(?:-commercial)?$/)
  const minor = Number(version?.[1])
  const patch = Number(version?.[2])
  if (!version || !(minor === 0 ? patch >= 16 && patch <= 46 : patch <= 11)
    || !(/^MySQL (?:Community Server - GPL|Enterprise Server - Commercial)$/.test(String(server?.platform))
      || (server?.platform === "Homebrew" && server?.version === "8.4.11"))
    || !String(server?.mode).split(",").some((mode) => ["STRICT_TRANS_TABLES", "STRICT_ALL_TABLES"].includes(mode))
    || Number(server?.readOnly) !== 0 || Number(server?.superReadOnly) !== 0
    || Number(server?.autocommit) !== 1 || server?.db !== database) {
    const observed = (value: unknown) => JSON.stringify(String(value ?? "").slice(0, 96))
    throw new MigrationSafetyError(`Unsupported server: require native writable MySQL 8.0.16–8.0.46 or 8.4.0–8.4.11, strict mode, autocommit and the exact selected database. Observed VERSION()=${observed(server?.version)} @@version_comment=${observed(server?.platform)}; report these values to support.`)
  }
}

async function verifyVisibility(executor: Executor, database: string) {
  const permissions = new Set<string>()
  for (const row of await executor.query("SHOW GRANTS FOR CURRENT_USER")) {
    for (const value of Object.values(row)) {
      if (typeof value !== "string") continue
      const grant = /^GRANT (.+) ON (.+) TO /.exec(value)
      if (!grant || !["*.*", `\`${database}\`.*`].includes(grant[2])) continue
      for (const permission of grant[1].split(", ")) permissions.add(permission)
    }
  }
  if (!permissions.has("ALL PRIVILEGES") && !["SELECT", "SHOW VIEW", "TRIGGER", "EVENT", "REFERENCES"].every((privilege) => permissions.has(privilege))) {
    throw new MigrationSafetyError("Cannot establish complete metadata visibility. Require direct database-wide SELECT, SHOW VIEW, TRIGGER, EVENT and REFERENCES grants (or ALL PRIVILEGES); role-only grants are unsupported.")
  }
}

function verifyJournalShape(shape: Map<string, string>) {
  const expected = new Map([
    [`table:${journalTable}`, "BASE TABLE:InnoDB"],
    [`column:${journalTable}.id`, JSON.stringify(["bigint unsigned", false, null, true, false])],
    [`column:${journalTable}.hash`, JSON.stringify(["text", false, null, false, false])],
    [`column:${journalTable}.created_at`, JSON.stringify(["bigint", true, null, false, false])],
    [`index:${journalTable}.PRIMARY`, JSON.stringify([["id"], true, "BTREE"])],
  ])
  const actual = new Map([...shape].filter(([key]) => key === `table:${journalTable}` || key.includes(`:${journalTable}.`)))
  const serialIndex = `index:${journalTable}.id`
  if (actual.get(serialIndex) === expected.get(`index:${journalTable}.PRIMARY`)) actual.delete(serialIndex)
  if (!exactShape(expected, actual)) throw new MigrationSafetyError("Unexpected migration ledger schema; no ledger changes permitted.")
  for (const key of [...shape.keys()]) if (key === `table:${journalTable}` || key.includes(`:${journalTable}.`)) shape.delete(key)
}

export async function inspectRecovery(executor: Executor, artifacts: RecoveryArtifacts, database: string) {
  validateServer((await executor.query("SELECT VERSION() AS version, @@version_comment AS platform, @@SESSION.sql_mode AS mode, @@GLOBAL.read_only AS readOnly, @@GLOBAL.super_read_only AS superReadOnly, @@SESSION.autocommit AS autocommit, DATABASE() AS db"))[0], database)
  await verifyVisibility(executor, database)
  const { shape, tables } = await inspectSchema(executor, new Set())
  if (tables.includes(stateTable)) throw new MigrationSafetyError("A local migration state table exists. This recovery does not clear or interpret local interruption markers.")
  verifyJournalShape(shape)
  const unusualColumns = await executor.query("SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND (EXTRA LIKE '%INVISIBLE%' OR EXTRA LIKE '%STORAGE%' OR SRS_ID IS NOT NULL) LIMIT 1")
  if (unusualColumns.length) throw new MigrationSafetyError("Unsupported column metadata.")
  if ((await executor.query("SELECT 1 FROM information_schema.PARTITIONS WHERE TABLE_SCHEMA=DATABASE() AND PARTITION_NAME IS NOT NULL LIMIT 1")).length) {
    throw new MigrationSafetyError("Partitioned tables are unsupported.")
  }
  if ((await executor.query("SELECT 1 FROM information_schema.EVENTS WHERE EVENT_SCHEMA=DATABASE() LIMIT 1")).length) {
    throw new MigrationSafetyError("Database events exist; this tool does not disable them.")
  }
  const receipts = await executor.query(`SELECT id, hash, created_at FROM \`${journalTable}\` ORDER BY id`)
  let previous = 0n
  for (const row of receipts) {
    const id = String(row.id)
    if (!/^[1-9]\d*$/.test(id) || BigInt(id) <= previous) throw new MigrationSafetyError("Invalid ledger receipt identity/order.")
    previous = BigInt(id)
    if (!/^[1-9]\d*$/.test(String(row.created_at))) throw new MigrationSafetyError("Invalid ledger timestamp encoding.")
  }
  const applied = historyPrefix(artifacts.plan, receipts)
  if (applied >= 97) {
    const snapshot = artifacts.plan[applied - 1]?.snapshot
    if (!snapshot || !exactShape(snapshotShape(snapshot), shape)) {
      throw new MigrationSafetyError("Canonical 0097+ receipt exists but schema does not match its recorded snapshot; no mutation permitted.")
    }
    return { completed: true, prefix: artifacts.safeSteps.length, applied, receipts }
  }
  if (applied !== 96) throw new MigrationSafetyError("Incomplete recovery requires exactly the original 96-receipt prefix; older, missing or different histories are unsupported.")
  const prefix = recognizeRecovery(artifacts, shape)
  for (const table of artifacts.affected) {
    if ((await executor.query(`SELECT 1 FROM \`${table}\` LIMIT 1`)).length) {
      throw new MigrationSafetyError("An affected gateway table is nonempty; the original empty-source contract is not satisfied. No row contents disclosed.")
    }
  }
  return { completed: false, prefix, applied, receipts }
}

export function recoveryLockName(database: string) {
  return `ow-dev:${createHash("sha256").update(database.toLowerCase()).digest("hex").slice(0, 56)}`
}

function sameReceipts(left: Record<string, unknown>[], right: Record<string, unknown>[]) {
  return left.length === right.length && left.every((row, index) =>
    ["id", "hash", "created_at"].every((key) => String(row[key]) === String(right[index][key])))
}

export async function applyRecovery(executor: Executor, artifacts: RecoveryArtifacts, database: string, options: RecoveryOptions, signal?: AbortSignal) {
  if (options.mode !== "apply") throw new MigrationSafetyError("Write execution requires explicit apply mode.")
  requireApplyConfirmations(options, database)
  const checkCancelled = () => { if (signal?.aborted) throw new MigrationSafetyError("Recovery cancelled; inspect again with --dry-run.") }
  checkCancelled()
  const before = await inspectRecovery(executor, artifacts, database)
  if (before.completed) return before
  const lock = recoveryLockName(database)
  if (Number((await executor.query("SELECT GET_LOCK(?, 0) AS acquired", [lock]))[0]?.acquired) !== 1) {
    throw new MigrationSafetyError("Database recovery lock unavailable; no automatic retry.")
  }
  let transaction = false
  try {
    checkCancelled()
    if ((await executor.query("SELECT 1 FROM information_schema.PROCESSLIST WHERE DB=DATABASE() AND ID<>CONNECTION_ID() LIMIT 1")).length) {
      throw new MigrationSafetyError("Other visible database connections exist. Stop all writers and migration runners before applying.")
    }
    const state = await inspectRecovery(executor, artifacts, database)
    if (state.completed) return state
    if (!sameReceipts(before.receipts, state.receipts)) throw new MigrationSafetyError("History changed while acquiring the lock; inspect again.")
    checkCancelled()
    await executor.query("SET SESSION lock_wait_timeout = 15")
    await executor.query("SET SESSION innodb_lock_wait_timeout = 15")
    for (let index = state.prefix; index < artifacts.safeSteps.length; index++) {
      checkCancelled()
      await executor.query(artifacts.safeSteps[index].sql)
    }
    checkCancelled()
    const verified = await inspectRecovery(executor, artifacts, database)
    if (verified.completed || verified.prefix !== artifacts.safeSteps.length || !sameReceipts(state.receipts, verified.receipts)) {
      throw new MigrationSafetyError("Final target schema/history changed; receipt not written by this run.")
    }
    await executor.query("START TRANSACTION")
    transaction = true
    const lockedReceipts = await executor.query(`SELECT id, hash, created_at FROM \`${journalTable}\` ORDER BY id FOR UPDATE`)
    if (historyPrefix(artifacts.plan, lockedReceipts) !== 96 || !sameReceipts(state.receipts, lockedReceipts)) {
      throw new MigrationSafetyError("Original 96 receipts changed; receipt not written by this run.")
    }
    const final = await inspectRecovery(executor, artifacts, database)
    if (final.completed || final.prefix !== artifacts.safeSteps.length || !sameReceipts(state.receipts, final.receipts)) {
      throw new MigrationSafetyError("Schema or history changed inside the receipt transaction; no receipt recorded.")
    }
    checkCancelled()
    await executor.query(`INSERT INTO \`${journalTable}\` (hash, created_at) VALUES (?, ?)`, [originalHash, originalTimestamp])
    checkCancelled()
    await executor.query("COMMIT")
    transaction = false
    const result = await inspectRecovery(executor, artifacts, database)
    if (!result.completed || result.applied !== 97 || !sameReceipts(state.receipts, result.receipts.slice(0, 96))) {
      throw new MigrationSafetyError("Post-commit verification failed; commit may have completed. Rerun --dry-run, never blindly retry.")
    }
    return result
  } finally {
    try {
      if (transaction) await executor.query("ROLLBACK")
    } finally {
      await executor.query("SELECT RELEASE_LOCK(?)", [lock])
    }
  }
}

export function sanitizedFailure(error: unknown) {
  if (error instanceof MigrationSafetyError) return error.message
  const details: string[] = []
  if (record(error)) {
    if (typeof error.code === "string" && /^(?:ER_[A-Z0-9_]{1,64}|E(?:CONNRESET|CONNREFUSED|TIMEDOUT|PIPE|HOSTUNREACH)|PROTOCOL_CONNECTION_LOST|HANDSHAKE_SSL_ERROR)$/.test(error.code)) details.push(`code=${error.code}`)
    if (typeof error.errno === "number" && Number.isSafeInteger(error.errno) && error.errno >= 0 && error.errno <= 65535) details.push(`errno=${error.errno}`)
    if (typeof error.sqlState === "string" && /^[0-9A-Z]{5}$/.test(error.sqlState)) details.push(`sqlState=${error.sqlState}`)
  }
  return `Recovery failed${details.length ? ` (${details.join(", ")})` : ""}; database details withheld. A statement or commit may have completed. Rerun --dry-run; do not blindly retry.`
}
