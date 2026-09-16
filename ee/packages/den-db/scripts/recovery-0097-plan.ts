import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import path from "node:path"
import { loadMigrationPlan, MigrationSafetyError, snapshotShape, type MigrationPlan } from "./migration-baseline.ts"

export const originalHash = "96e872e1fdf004ff4cdf66715a589a442dff80170f2b47e70204b38a2fd09470"
export const originalTimestamp = 1788895934602
const journalHash = "ab0233a9c568dea31b9d53499cba470eaf8fc07c257f16858018f73904dfaa14"
const manifestHash = "cab94553429262dccbbc22129662717ec9878cd9688c21c7943b13f186fc6a55"
const snapshotPins = [
  ["0096", "62c1d2787cd6064a258238dfc1c066bfa3bde1dbf4a33b4ebc8f1af906a74282"],
  ["0097", "64a86086082e0906028aa0064514658ebee7a8fe2b0ecb2e6f589e61b9fca5b5"],
]

export type RecoveryStep = { sql: string; line: number; shape: Map<string, string> }
export type RecoveryArtifacts = ReturnType<typeof projectRecovery>

function digest(value: string) {
  return createHash("sha256").update(value).digest("hex")
}

function requireArtifact(condition: unknown): asserts condition {
  if (!condition) throw new MigrationSafetyError("Unsupported recovery artifacts; use the reviewed, unchanged source checkout.")
}

export function exactShape(expected: Map<string, string>, actual: Map<string, string>) {
  return expected.size === actual.size && [...expected].every(([key, value]) => actual.get(key) === value)
}

export function validatePlan(plan: MigrationPlan) {
  requireArtifact(plan.length === 101)
  for (const entry of plan) requireArtifact(digest(entry.sql.join("--> statement-breakpoint")) === entry.hash)
  requireArtifact(digest(JSON.stringify(plan.map((entry) => ({
    tag: entry.tag, when: entry.folderMillis, hash: entry.hash, snapshot: digest(JSON.stringify(entry.snapshot ?? null)),
  })))) === manifestHash)
  requireArtifact(plan[96].hash === originalHash && plan[96].folderMillis === originalTimestamp)
}

export function verifyRecoveryFiles(read: (relativePath: string) => string) {
  requireArtifact(digest(read("meta/_journal.json")) === journalHash)
  for (const [tag, hash] of snapshotPins) {
    requireArtifact(digest(read(`meta/${tag}_snapshot.json`)) === hash)
  }
}

export function loadRecoveryArtifacts(folder: string) {
  verifyRecoveryFiles((relativePath) => readFileSync(path.join(folder, relativePath), "utf8"))
  return projectRecovery(loadMigrationPlan(folder))
}

export function projectRecovery(plan: MigrationPlan) {
  validatePlan(plan)
  const source = plan[95].snapshot
  const target = plan[96].snapshot
  requireArtifact(source && target && target.prevId === source.id)
  const current = structuredClone(source)
  const finalShape = snapshotShape(target)
  const safeSteps: RecoveryStep[] = []
  const affected = new Set<string>()
  const primaryTables = new Set<string>()
  let initial: Map<string, string> | undefined
  let drops = 0
  let adds = 0
  let offset = 0
  for (const packet of plan[96].sql) {
    const sql = packet.trim()
    const leading = packet.slice(0, packet.indexOf(sql))
    const line = 1 + offset + (leading.match(/\n/g)?.length ?? 0)
    offset += packet.match(/\n/g)?.length ?? 0
    const create = /^CREATE TABLE `([a-z_]+)` \(/.exec(sql)
    const rename = /^RENAME TABLE `([a-z_]+)` TO `([a-z_]+)`;$/.exec(sql)
    const renameColumn = /^ALTER TABLE `([a-z_]+)` RENAME COLUMN `([a-z_]+)` TO `([a-z_]+)`;$/.exec(sql)
    const dropIndex = /^ALTER TABLE `([a-z_]+)` DROP INDEX `([a-z_]+)`;$/.exec(sql)
    const dropStandalone = /^DROP INDEX `([a-z_]+)` ON `([a-z_]+)`;$/.exec(sql)
    const removedIndex = dropIndex ? { table: dropIndex[1], name: dropIndex[2] }
      : dropStandalone ? { table: dropStandalone[2], name: dropStandalone[1] } : undefined
    const primary = /^ALTER TABLE `([a-z_]+)` (DROP PRIMARY KEY|ADD PRIMARY KEY\(`id`\));$/.exec(sql)
    const column = /^ALTER TABLE `([a-z_]+)` (?:MODIFY COLUMN|ADD) `([a-z_]+)` /.exec(sql)
    const constraint = /^ALTER TABLE `([a-z_]+)` ADD CONSTRAINT `([a-z_]+)` (UNIQUE|CHECK)\s*\(/.exec(sql)
    const index = /^CREATE INDEX `([a-z_]+)` ON `([a-z_]+)` /.exec(sql)
    if (create) {
      requireArtifact(!current.tables[create[1]] && target.tables[create[1]])
      const table = structuredClone(target.tables[create[1]])
      table.indexes = Object.fromEntries(Object.entries(table.indexes).filter(([, value]) => value.isUnique))
      table.checkConstraint = {}
      current.tables[create[1]] = table
      affected.add(create[1])
    } else if (rename) {
      const table = current.tables[rename[1]]
      requireArtifact(table && !current.tables[rename[2]])
      delete current.tables[rename[1]]
      table.name = rename[2]
      current.tables[rename[2]] = table
      affected.add(rename[2])
    } else if (renameColumn) {
      const table = current.tables[renameColumn[1]]
      const definition = table.columns[renameColumn[2]]
      requireArtifact(definition && !table.columns[renameColumn[3]])
      delete table.columns[renameColumn[2]]
      table.columns[renameColumn[3]] = { ...definition, name: renameColumn[3] }
      for (const collection of [table.indexes, table.uniqueConstraints, table.compositePrimaryKeys]) {
        for (const value of Object.values(collection)) {
          value.columns = value.columns.map((name) => name.replaceAll(renameColumn[2], renameColumn[3]))
        }
      }
    } else if (removedIndex) {
      const table = current.tables[removedIndex.table]
      requireArtifact(table.indexes[removedIndex.name] || table.uniqueConstraints[removedIndex.name])
      delete table.indexes[removedIndex.name]
      delete table.uniqueConstraints[removedIndex.name]
    } else if (primary) {
      if (!initial) {
        requireArtifact(line === 86 && primary[1] === "gateway_request_logs")
        initial = snapshotShape(current)
      }
      const key = `index:${primary[1]}.PRIMARY`
      requireArtifact(snapshotShape(current).get(key) === finalShape.get(key)
        && finalShape.get(key) === JSON.stringify([["id"], true, "BTREE"]))
      const id = snapshotShape(current).get(`column:${primary[1]}.id`)
      requireArtifact(id !== undefined && id === finalShape.get(`column:${primary[1]}.id`))
      primaryTables.add(primary[1])
      if (primary[2].startsWith("DROP")) drops++
      else adds++
      continue
    } else if (column) {
      requireArtifact(initial && target.tables[column[1]]?.columns[column[2]])
      current.tables[column[1]].columns[column[2]] = structuredClone(target.tables[column[1]].columns[column[2]])
    } else if (constraint) {
      requireArtifact(initial)
      const name = constraint[2]
      if (constraint[3] === "CHECK") {
        requireArtifact(target.tables[constraint[1]].checkConstraint[name])
        current.tables[constraint[1]].checkConstraint[name] = structuredClone(target.tables[constraint[1]].checkConstraint[name])
      } else {
        const definition = target.tables[constraint[1]].indexes[name]
        requireArtifact(definition?.isUnique)
        current.tables[constraint[1]].indexes[name] = structuredClone(definition)
      }
    } else if (index) {
      requireArtifact(initial && target.tables[index[2]].indexes[index[1]])
      current.tables[index[2]].indexes[index[1]] = structuredClone(target.tables[index[2]].indexes[index[1]])
    } else {
      requireArtifact(false)
    }
    if (initial) safeSteps.push({ sql, line, shape: snapshotShape(current) })
  }
  requireArtifact(initial && drops === 8 && adds === 8 && primaryTables.size === 8 && affected.size === 12)
  requireArtifact(exactShape(snapshotShape(current), finalShape))
  return { plan, initial, finalShape, safeSteps, affected: [...affected], primaryTables: [...primaryTables] }
}

export function recognizeRecovery(artifacts: RecoveryArtifacts, shape: Map<string, string>) {
  if (exactShape(artifacts.initial, shape)) return 0
  const index = artifacts.safeSteps.findIndex((step) => exactShape(step.shape, shape))
  if (index < 0) throw new MigrationSafetyError("Schema is not the supported line-86 failure state or an exact safe-tail prefix. No guessing or automatic repair is permitted.")
  return index + 1
}
