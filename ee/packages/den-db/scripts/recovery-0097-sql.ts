import { journalTable, MigrationSafetyError } from "./migration-baseline.ts"
import { originalHash, originalTimestamp, type RecoveryArtifacts } from "./recovery-0097-plan.ts"

const identifierPattern = /^[a-z_]+$/

function requireGenerated(condition: unknown): asserts condition {
  if (!condition) throw new MigrationSafetyError("Recovery SQL generation does not match the pinned artifacts; use the reviewed, unchanged source checkout.")
}

function identifier(value: string) {
  requireGenerated(identifierPattern.test(value))
  return `\`${value}\``
}

function comments(lines: string[]) {
  return lines.map((line) => (line ? `-- ${line}` : "--")).join("\n")
}

function tableList(tables: string[]) {
  return tables.map((table) => `'${table}'`).join(", ")
}

export const receiptSql = `INSERT INTO ${identifier(journalTable)} (hash, created_at) VALUES ('${originalHash}', ${originalTimestamp});`

export function tailObjects(artifacts: RecoveryArtifacts) {
  const columns: [string, string][] = []
  const indexes: [string, string][] = []
  const checks: [string, string][] = []
  for (const step of artifacts.safeSteps) {
    const column = /^ALTER TABLE `([a-z_]+)` ADD `([a-z_]+)` /.exec(step.sql)
    const constraint = /^ALTER TABLE `([a-z_]+)` ADD CONSTRAINT `([a-z_]+)` (UNIQUE|CHECK)\s*\(/.exec(step.sql)
    const index = /^CREATE INDEX `([a-z_]+)` ON `([a-z_]+)` /.exec(step.sql)
    if (column) columns.push([column[1], column[2]])
    else if (constraint && constraint[3] === "UNIQUE") indexes.push([constraint[1], constraint[2]])
    else if (constraint) checks.push([constraint[1], constraint[2]])
    else if (index) indexes.push([index[2], index[1]])
    else requireGenerated(/^ALTER TABLE `[a-z_]+` MODIFY COLUMN `[a-z_]+` /.test(step.sql))
  }
  const kinds: [string, [string, string][]][] = [["column", columns], ["index", indexes], ["check", checks]]
  for (const [kind, pairs] of kinds) {
    for (const [table, object] of pairs) {
      const key = `${kind}:${table}.${object}`
      requireGenerated(!artifacts.initial.has(key) && artifacts.finalShape.has(key))
    }
  }
  requireGenerated(columns.length + indexes.length + checks.length === artifacts.safeSteps.length - 1)
  return { columns, indexes, checks }
}

export function completionSql(artifacts: RecoveryArtifacts) {
  const lines = artifacts.safeSteps.map((step) => step.line)
  const first = lines[0]
  const last = lines.at(-1)
  requireGenerated(first !== undefined && last !== undefined && artifacts.safeSteps.length === 43)
  const statements = artifacts.safeSteps.map((step) => {
    requireGenerated(step.sql.endsWith(";") && !/DROP|PRIMARY KEY|IF NOT EXISTS|DELETE|INSERT|UPDATE |sql_require_primary_key/.test(step.sql))
    return `${comments([`original 0097 SQL line ${step.line}`])}\n${step.sql}`
  })
  const header = comments([
    "OpenWork Den MySQL migration 0097 (0097_gateway_access_matrix): completion SQL",
    "Generated from the pinned migration artifacts by scripts/build-recovery-bundle.ts; do not edit.",
    "",
    "Scope: finishes ONLY migration 0097 from its line-86 failure state (partial apply under",
    `sql_require_primary_key=ON). It runs the ${artifacts.safeSteps.length} remaining original statements unchanged`,
    `(original SQL lines ${first}-${last}, skipping only the eight DROP PRIMARY KEY / ADD PRIMARY KEY pairs whose`,
    "primary keys already exist) and then records the single original 0097 receipt. It does not run 0098+;",
    "the normal release upgrade does that afterwards.",
    "",
    "Prerequisites (all mandatory):",
    "  1. A verified, restorable backup of schema AND data.",
    "  2. Every application writer, worker, cron/job, Helm hook and migration runner is stopped.",
    "  3. sql/0097-preflight.sql was run against this exact database and EVERY result matched its",
    "     expected value (96 receipts, twelve empty gateway tables, primary keys present, tail not started).",
    "  4. Run with the mysql client against the exact target database, without --force.",
    "",
    "This file never drops, adds or changes a primary key and leaves sql_require_primary_key unchanged.",
    "It changes no global or session settings and touches no application data rows.",
    "There is no transaction wrapper: MySQL DDL statements commit implicitly, so a failure leaves",
    "the statements before it applied. On any error STOP and do not rerun this file; run the bundled",
    "CLI dry-run (node bin/recover-0097.mjs) instead, which recognizes every partial state and resumes safely.",
  ])
  const receipt = comments([
    "Original 0097 migration receipt (SQL hash and journal timestamp from the pinned artifacts).",
    "Run only after all statements above succeeded.",
  ])
  return `${[header, ...statements, `${receipt}\n${receiptSql}`].join("\n\n")}\n`
}

export function preflightSql(artifacts: RecoveryArtifacts) {
  const previous = artifacts.plan[95]
  const source = previous.snapshot
  requireGenerated(source && artifacts.affected.length === 12 && artifacts.primaryTables.length === 8)
  const affected = [...artifacts.affected].sort()
  const renamed = [...artifacts.primaryTables].sort()
  const sources = Object.values(source.tables).map((table) => table.name).filter((table) => !artifacts.initial.has(`table:${table}`)).sort()
  const remaining = [...artifacts.initial.keys()].filter((key) => key.startsWith("table:inference")).map((key) => key.slice("table:".length)).sort()
  requireGenerated(sources.length === 8 && sources.every((table) => table.startsWith("inference_")) && remaining.length > 0)
  const tail = tailObjects(artifacts)
  const pairs = (values: [string, string][]) => values.map(([table, object]) => `('${table}', '${object}')`).join(", ")
  const emptiness = affected.map((table) => `SELECT '${table}' AS table_name, EXISTS (SELECT 1 FROM ${identifier(table)}) AS has_rows`).join("\nUNION ALL\n")
  const sections: [string[], string][] = [
    [["1. Migration ledger has exactly the original 96 receipts.", "Expected: receipts = 96"],
      `SELECT COUNT(*) AS receipts FROM ${identifier(journalTable)};`],
    [[`2. The last receipt is migration 96 (${previous.tag}).`, `Expected: hash = ${previous.hash}`, `          created_at = ${previous.folderMillis}`],
      `SELECT id, hash, created_at FROM ${identifier(journalTable)} ORDER BY id DESC LIMIT 1;`],
    [["3. The twelve gateway tables created or renamed by 0097 exist.", `Expected: ${affected.length} rows:`, ...affected.map((table) => `  ${table}`)],
      "SHOW TABLES LIKE 'gateway%';"],
    [["4. The eight tables renamed by 0097 no longer exist under their old names.", "Expected: 0 rows (Empty set)"],
      `SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN (${tableList(sources)}) ORDER BY TABLE_NAME;`],
    [["5. Only the inference tables that 0097 leaves in place remain.", `Expected: ${remaining.length} rows:`, ...remaining.map((table) => `  ${table}`)],
      "SHOW TABLES LIKE 'inference%';"],
    [["6. Server version, platform banner and primary-key enforcement.", "Expected: version 8.0.16-8.0.46 or 8.4.0-8.4.11, platform 'MySQL Community Server - GPL' or",
      "          'MySQL Enterprise Server - Commercial', sql_require_primary_key = 1 (ON, the setting that caused",
      "          this failure; the completion SQL works with either value). Other platform",
      "          banners are not supported by this bundle; send the values to support."],
      "SELECT VERSION() AS version, @@version_comment AS platform, @@sql_require_primary_key AS sql_require_primary_key;"],
    [["7. Every renamed table still has its primary key on id (0097 never needs to recreate one).", `Expected: ${renamed.length} rows, one per table, each with COLUMN_NAME = id:`, ...renamed.map((table) => `  ${table}`)],
      `SELECT TABLE_NAME, COLUMN_NAME FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND INDEX_NAME = 'PRIMARY' AND TABLE_NAME IN (${tableList(renamed)}) ORDER BY TABLE_NAME, SEQ_IN_INDEX;`],
    [["8. All twelve affected gateway tables are empty (row contents are never read).", `Expected: ${affected.length} rows, every has_rows = 0`],
      `${emptiness};`],
    [["9. None of the remaining 0097 statements has been applied yet (line-86 failure state).", "Expected: tail_objects_present = 0. Any other value means a partial tail was applied:",
      "          do not run sql/0097-complete.sql; use the bundled CLI (bin/recover-0097.mjs), which", "          recognizes and resumes every partial state."],
      [
        "SELECT COUNT(*) AS tail_objects_present FROM (",
        `  SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND (TABLE_NAME, COLUMN_NAME) IN (${pairs(tail.columns)})`,
        "  UNION ALL",
        `  SELECT 1 FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND SEQ_IN_INDEX = 1 AND (TABLE_NAME, INDEX_NAME) IN (${pairs(tail.indexes)})`,
        "  UNION ALL",
        `  SELECT 1 FROM information_schema.TABLE_CONSTRAINTS WHERE CONSTRAINT_SCHEMA = DATABASE() AND CONSTRAINT_TYPE = 'CHECK' AND (TABLE_NAME, CONSTRAINT_NAME) IN (${pairs(tail.checks)})`,
        ") AS tail;",
      ].join("\n")],
  ]
  const header = comments([
    "OpenWork Den MySQL migration 0097 (0097_gateway_access_matrix): read-only preflight",
    "Generated from the pinned migration artifacts by scripts/build-recovery-bundle.ts; do not edit.",
    "",
    "Every statement below is a SELECT or SHOW. Nothing is written, locked or changed.",
    "Run it against the exact target database, for example:",
    "  MYSQL_PWD=<password> mysql --protocol=tcp -h <host> -P <port> -u <user> --table --skip-comments -vv <database> < sql/0097-preflight.sql",
    "(--table --skip-comments -vv echoes each statement before its result and prints",
    "\"Empty set\" instead of nothing for checks that expect 0 rows.)",
    "Compare every result with the Expected comment above its statement. If anything differs,",
    "STOP, keep writers stopped and send the complete output to support. Do not run",
    "sql/0097-complete.sql unless every check matched.",
  ])
  return `${[header, ...sections.map(([notes, sql]) => `${comments(notes)}\n${sql}`)].join("\n\n")}\n`
}

export function sqlStatements(text: string) {
  const body = text.split("\n").filter((line) => !/^--(?: |$)/.test(line) && line.trim() !== "").join("\n")
  return body.split(/;\n|;$/).map((statement) => statement.trim()).filter(Boolean).map((statement) => `${statement};`)
}
