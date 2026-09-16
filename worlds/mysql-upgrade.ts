import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
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
  } });
  const pnpmEntry = values["pnpm-entry"] ?? process.env.npm_execpath;
  if (!pnpmEntry) throw new Error("Pass --pnpm-entry pointing to the installed pnpm.cjs");
  const outputDir = join("evals/results", `mysql-upgrade-${resolveStage(process.env) ?? "default"}`);
  await mkdir(outputDir, { recursive: true });
  await using world = await runMysqlUpgrade({ from: values.from, to: values.to, pnpmEntry, temporaryParent: values["temporary-parent"], recoveryReport: values.recovery ? join(outputDir, "recovery.json") : undefined });
  const report = join(outputDir, "report.json");
  await writeFile(report, `${JSON.stringify(world.report, null, 2)}\n`, { mode: 0o600 });
  const expires = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();
  const timer = setTimeout(() => process.emit("SIGTERM"), 2 * 60 * 60 * 1000);
  try {
    await hold({ name: "mysql-upgrade", outputs: { report, from: world.report.from.sha, to: world.report.to.sha, runtime: world.report.runtime, expires, checks: String(world.report.checks.length) } });
  } finally { clearTimeout(timer); }
}

if (import.meta.main) await main();
