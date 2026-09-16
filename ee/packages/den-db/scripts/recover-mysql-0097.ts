import { readFileSync, realpathSync } from "node:fs"
import path from "node:path"
import { createInterface } from "node:readline/promises"
import { fileURLToPath } from "node:url"
import mysql from "mysql2/promise"
import { parseMySqlConnectionConfig } from "../src/mysql-config.ts"
import { MigrationSafetyError, record } from "./migration-baseline.ts"
import { loadRecoveryArtifacts } from "./recovery-0097-plan.ts"
import { applyRecovery, inspectRecovery, parseRecoveryArgs, requireApplyConfirmations, sanitizedFailure, validateTerminal, type RecoveryOptions } from "./recovery-0097.ts"

export const recoveryHelp = `0097 partial MySQL upgrade recovery (reviewed source checkout or recovery bundle)
Default: --dry-run; reads only, no named locks or session SETs.
Options: --dry-run | --interactive | --apply
         --non-interactive --confirm-database NAME --backup-confirmed --writers-stopped
         --ca-file PATH --help
Connection: DATABASE_URL environment only. Never pass credentials as arguments.
Remote TLS verifies both certificate trust and hostname; insecure URL options are rejected.
Apply requires a verified backup and all writers/migration jobs paused.
The named lock coordinates cooperating tools only, not app/Helm writes.
On interruption, rerun --dry-run; never retry an uncertain SQL statement manually.`

export function recoveryConnectionConfig(databaseUrl: string, ca?: string) {
  try {
    const url = new URL(databaseUrl)
    if (url.protocol !== "mysql:" || url.hash) throw new Error()
    const config = parseMySqlConnectionConfig(databaseUrl)
    if (!/^[a-zA-Z0-9_$-]{1,64}$/.test(config.database) || !/^[a-zA-Z0-9.:[\]-]+$/.test(config.host)
      || !Number.isInteger(config.port) || config.port < 1 || config.port > 65535) throw new Error()
    const seen = new Set<string>()
    for (const [key, value] of url.searchParams) {
      if (seen.has(key)) throw new Error()
      seen.add(key)
      const mode = value.trim().toLowerCase()
      if (key === "sslaccept" ? mode !== "strict" : ["sslmode", "ssl-mode"].includes(key)
        ? !["verify-full", "verify-ca", "require", "required"].includes(mode) : true) throw new Error()
    }
    if (seen.has("sslmode") && seen.has("ssl-mode")) throw new Error()
    if (config.host === "[::1]") config.host = "::1"
    const remote = !["localhost", "127.0.0.1", "::1"].includes(config.host)
    return {
      ...config,
      ssl: remote || config.ssl || ca ? { rejectUnauthorized: true, verifyIdentity: true, ...(ca ? { ca } : {}) } : undefined,
      connectTimeout: 10_000,
      multipleStatements: false,
      supportBigNumbers: true,
      bigNumberStrings: true,
    }
  } catch {
    throw new MigrationSafetyError("Invalid DATABASE_URL or insecure/unknown URL options (values withheld). Require mysql scheme, a safe database name and verified TLS; see --help.")
  }
}

type Ask = (prompt: string) => Promise<string>
export async function wizard(options: RecoveryOptions, database: string, ask: Ask): Promise<RecoveryOptions | undefined> {
  let mode = options.mode
  if (mode === "interactive") {
    const answer = (await ask("Choose dry-run / apply / cancel [dry-run]: ")).trim().toLowerCase()
    if (!answer || answer === "dry-run" || answer === "d") mode = "dry-run"
    else if (answer === "apply" || answer === "a") mode = "apply"
    else if (answer === "cancel" || answer === "c") return undefined
    else throw new MigrationSafetyError("Unrecognized choice; cancelled without changes.")
  }
  if (mode !== "apply") return { ...options, mode }
  const confirmDatabase = await ask("Type the exact database name shown above (blank cancels): ")
  if (confirmDatabase !== database) throw new MigrationSafetyError("Database confirmation did not match; cancelled without changes.")
  const backupConfirmed = await ask("Verified restorable backup and approved recovery window? Type yes [no]: ") === "yes"
  if (!backupConfirmed) throw new MigrationSafetyError("Backup not confirmed; cancelled without changes.")
  const writersStopped = await ask("Stopped ALL app writers, workers, callbacks, jobs, cronjobs, Helm hooks and migration runners? Type yes [no]: ") === "yes"
  const confirmed = { ...options, mode, confirmDatabase, backupConfirmed, writersStopped }
  requireApplyConfirmations(confirmed, database)
  return confirmed
}

export async function terminalWizard(options: RecoveryOptions, database: string, terminal: ReturnType<typeof createInterface>, abort: AbortController) {
  const inputClosed = () => abort.abort(new MigrationSafetyError("Terminal input closed; recovery cancelled."))
  terminal.once("close", inputClosed)
  try {
    abort.signal.throwIfAborted()
    const chosen = await wizard(options, database, (prompt) => terminal.question(prompt, { signal: abort.signal }))
    abort.signal.throwIfAborted()
    return chosen
  } catch (error) {
    abort.signal.throwIfAborted()
    throw error
  } finally {
    terminal.removeListener("close", inputClosed)
    terminal.close()
  }
}

export async function main(args = process.argv.slice(2)) {
  let options = parseRecoveryArgs(args)
  if (options.help) { console.log(recoveryHelp); return }
  const tty = Boolean(process.stdin.isTTY && process.stdout.isTTY)
  validateTerminal(options, tty)
  const ca = options.caFile ? readFileSync(options.caFile, "utf8") : undefined
  if (ca !== undefined && (ca.length > 1_048_576 || !ca.includes("-----BEGIN CERTIFICATE-----"))) throw new MigrationSafetyError("Invalid CA bundle; contents withheld.")
  const config = recoveryConnectionConfig(process.env.DATABASE_URL ?? "", ca)
  if (options.nonInteractive && options.mode === "apply") requireApplyConfirmations(options, config.database)
  const artifacts = loadRecoveryArtifacts(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../drizzle"))
  console.log(`Target host=${JSON.stringify(config.host)} port=${config.port} database=${JSON.stringify(config.database)} TLS=${config.ssl ? "verify-identity" : "loopback plaintext"}`)
  const abort = new AbortController()
  let connection: mysql.Connection | undefined
  let terminal: ReturnType<typeof createInterface> | undefined
  const cancel = () => {
    abort.abort()
    terminal?.close()
    connection?.destroy()
  }
  process.once("SIGINT", cancel)
  process.once("SIGTERM", cancel)
  try {
    connection = await mysql.createConnection(config)
    if (abort.signal.aborted) throw new MigrationSafetyError("Recovery cancelled; rerun --dry-run.")
    const activeConnection = connection
    const executor = { query: async (sql: string, values: (string | number)[] = []) => {
      const [rows] = await activeConnection.query({ sql, timeout: 30_000 }, values)
      const result: unknown = rows
      return Array.isArray(result) ? result.filter(record) : []
    } }
    const initial = await inspectRecovery(executor, artifacts, config.database)
    if (initial.completed) {
      console.log(`Read-only no-op: exact ${initial.applied}-receipt history and recorded normalized schema verified. No recovery required; application/data health not assessed.`)
      return
    }
    console.log(`Supported incomplete state: ${initial.prefix}/${artifacts.safeSteps.length} safe-tail statements complete; all 12 affected tables empty. Eight canonical id primary keys preserved.`)
    console.log(`Remaining original SQL line numbers: ${artifacts.safeSteps.slice(initial.prefix).map((step) => step.line).join(", ") || "none; target awaits verified receipt"}`)
    if (!options.nonInteractive && options.mode !== "dry-run") {
      const promptTerminal = createInterface({ input: process.stdin, output: process.stdout })
      terminal = promptTerminal
      promptTerminal.on("SIGINT", cancel)
      const chosen = await terminalWizard(options, config.database, promptTerminal, abort)
      if (!chosen) { console.log("Cancelled; no changes."); return }
      options = chosen
    }
    if (options.mode === "dry-run") {
      console.log("Read-only inspection complete. No SQL writes, session SETs or named locks. This is not authorization to resume writers.")
      return
    }
    await applyRecovery(executor, artifacts, config.database, options, abort.signal)
    console.log("0097 verified complete with its original receipt. Keep writers paused; run remaining migrations through the normal reviewed Helm upgrade, then validate before resuming traffic.")
  } finally {
    terminal?.close()
    try {
      if (abort.signal.aborted) connection?.destroy()
      else await connection?.end()
    } finally {
      process.removeListener("SIGINT", cancel)
      process.removeListener("SIGTERM", cancel)
    }
  }
}

export function invokedDirectly(entry: string | undefined, moduleUrl: string) {
  if (!entry) return false
  try {
    return realpathSync(path.resolve(entry)) === realpathSync(fileURLToPath(moduleUrl))
  } catch {
    return false
  }
}

if (invokedDirectly(process.argv[1], import.meta.url)) {
  main().catch((error: unknown) => {
    console.error(`[den-db recovery] ${sanitizedFailure(error)} Rerun --dry-run before further action.`)
    process.exitCode = 1
  })
}
