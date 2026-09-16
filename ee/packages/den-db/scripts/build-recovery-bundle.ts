import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { copyFileSync, cpSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { invokedDirectly } from "./recover-mysql-0097.ts"
import { loadRecoveryArtifacts } from "./recovery-0097-plan.ts"
import { completionSql, preflightSql, receiptSql, sqlStatements } from "./recovery-0097-sql.ts"

const packageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const bundleName = "openwork-mysql-0097-recovery"
const outputDir = path.join(packageDir, "dist", "recovery-bundle")
const bundleDir = path.join(outputDir, bundleName)

function run(command: string, args: string[], options: { cwd?: string; inherit?: boolean } = {}) {
  const result = spawnSync(command, args, { cwd: options.cwd ?? packageDir, encoding: "utf8", stdio: options.inherit ? "inherit" : "pipe", env: process.env })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} exited with status ${result.status}${result.stderr ? `\n${result.stderr}` : ""}`)
  return result.stdout ?? ""
}

function sha256(file: string) {
  const bytes = readFileSync(file)
  return createHash("sha256").update(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength)).digest("hex")
}

function walk(directory: string, relative = ""): string[] {
  return readdirSync(directory, { withFileTypes: true })
    .sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))
    .flatMap((entry) => {
      const relativePath = relative ? `${relative}/${entry.name}` : entry.name
      if (entry.isDirectory()) return walk(path.join(directory, entry.name), relativePath)
      if (!entry.isFile()) throw new Error(`Unsupported bundle entry ${relativePath}`)
      return [relativePath]
    })
}

export function buildRecoveryBundle() {
  const dirty = run("git", ["status", "--porcelain", "--untracked-files=all", "--", "drizzle"]).trim()
  if (dirty) throw new Error(`Refusing to build: drizzle/ differs from the committed migration assets:\n${dirty}`)
  const shortSha = run("git", ["rev-parse", "--short=9", "HEAD"]).trim()
  if (!/^[0-9a-f]{9}$/.test(shortSha)) throw new Error("Could not determine the HEAD commit")
  rmSync(bundleDir, { recursive: true, force: true })
  mkdirSync(bundleDir, { recursive: true })
  run(process.execPath, [path.join(packageDir, "node_modules", "tsup", "dist", "cli-default.js"), "--config", "tsup.recovery.config.ts"], { inherit: true })
  const cli = path.join(bundleDir, "bin", "recover-0097.mjs")
  const bundle = readFileSync(cli, "utf8")
  if (!bundle.startsWith("#!/usr/bin/env node\n")) throw new Error("Bundle lost its shebang")
  if (bundle.replace(/import\(\s*["']drizzle-kit\/api["']\s*\)/g, "").includes("drizzle-kit")) throw new Error("Bundle must not load drizzle-kit at runtime")
  cpSync(path.join(packageDir, "drizzle"), path.join(bundleDir, "drizzle"), { recursive: true })
  const artifacts = loadRecoveryArtifacts(path.join(bundleDir, "drizzle"))
  const completion = completionSql(artifacts)
  const expected = [...artifacts.safeSteps.map((step) => step.sql), receiptSql]
  if (JSON.stringify(sqlStatements(completion)) !== JSON.stringify(expected)) throw new Error("Completion SQL does not match the safe tail and receipt")
  const preflight = preflightSql(artifacts)
  if (!sqlStatements(preflight).every((statement) => /^(SELECT|SHOW)\b/.test(statement))) throw new Error("Preflight SQL must be read-only")
  mkdirSync(path.join(bundleDir, "sql"))
  writeFileSync(path.join(bundleDir, "sql", "0097-preflight.sql"), preflight)
  writeFileSync(path.join(bundleDir, "sql", "0097-complete.sql"), completion)
  copyFileSync(path.join(packageDir, "docs", "recovery-bundle-README.md"), path.join(bundleDir, "README.md"))
  const files = walk(bundleDir)
  writeFileSync(path.join(bundleDir, "SHA256SUMS"), `${files.map((file) => `${sha256(path.join(bundleDir, file))}  ${file}`).join("\n")}\n`)
  const zip = path.join(outputDir, `${bundleName}-${shortSha}.zip`)
  rmSync(zip, { force: true })
  run("zip", ["-r", "-X", "-q", zip, bundleName], { cwd: outputDir })
  const bundleFiles = walk(bundleDir)
  const bundleBytes = bundleFiles.reduce((total, file) => total + statSync(path.join(bundleDir, file)).size, 0)
  return { dir: bundleDir, zip, sha256: sha256(zip), files: bundleFiles.length, bundleBytes }
}

if (invokedDirectly(process.argv[1], import.meta.url)) {
  console.log(JSON.stringify(buildRecoveryBundle(), null, 2))
}
