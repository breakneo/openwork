import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { runMysqlUpgrade } from "../evals/packages/env/src/mysql-upgrade.ts";
import { hold } from "../packages/world/src/hold.ts";
import { resolveStage } from "../packages/world/src/stage.ts";

export async function main(): Promise<void> {
  if (process.env.OPENWORK_WORLD_PLACE !== "local") throw new Error("mysql-upgrade requires --place local and an installed mysqld");
  const { values } = parseArgs({ options: {
    from: { type: "string", default: "v0.18.35" },
    to: { type: "string", default: "v0.18.48" },
    "pnpm-entry": { type: "string" },
    "temporary-parent": { type: "string" },
    recovery: { type: "boolean", default: false },
    "recovery-bundle": { type: "string" },
    "recovery-node": { type: "string" },
  } });
  const pnpmEntry = values["pnpm-entry"] ?? process.env.npm_execpath;
  if (!pnpmEntry) throw new Error("Pass --pnpm-entry pointing to the installed pnpm.cjs");
  const bundle = values["recovery-bundle"] ? resolve(values["recovery-bundle"]) : undefined;
  if (values["recovery-node"] && !bundle) throw new Error("--recovery-node requires --recovery-bundle");
  const outputDir = join("evals/results", `mysql-upgrade-${resolveStage(process.env) ?? "default"}`);
  await mkdir(outputDir, { recursive: true });
  await using world = await runMysqlUpgrade({
    from: values.from, to: values.to, pnpmEntry, temporaryParent: values["temporary-parent"],
    recoveryReport: values.recovery || bundle ? join(outputDir, "recovery.json") : undefined,
    recoveryCli: bundle ? { node: values["recovery-node"] ?? process.execPath, args: [join(bundle, "bin/recover-0097.mjs")], label: "recovery bundle" } : undefined,
    recoverySqlFile: bundle ? join(bundle, "sql/0097-complete.sql") : undefined,
  });
  const report = join(outputDir, "report.json");
  await writeFile(report, `${JSON.stringify(world.report, null, 2)}\n`, { mode: 0o600 });
  const expires = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();
  const timer = setTimeout(() => process.emit("SIGTERM"), 2 * 60 * 60 * 1000);
  try {
    await hold({ name: "mysql-upgrade", outputs: { report, from: world.report.from.sha, to: world.report.to.sha, runtime: world.report.runtime, expires, checks: String(world.report.checks.length) } });
  } finally { clearTimeout(timer); }
}

if (import.meta.main) await main();
