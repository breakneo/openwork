import { defaultWorldCliPaths, main } from "./cli.ts";
import { appWebDaytonaReaper } from "./app-web-reaper.ts";

/** Standalone script-world CLI. */
export function runStandaloneWorldCli(
  argv: string[] = process.argv.slice(2),
  cwdInput: string = process.cwd(),
): Promise<number> {
  return main(argv, { ...defaultWorldCliPaths(cwdInput), reapers: { "app-web-daytona": appWebDaytonaReaper } });
}
