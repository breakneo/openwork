import type { Reaper } from "./reaper.ts";

export const appWebDaytonaReaper: Reaper = async (entry, context) => {
  if (!/^[a-zA-Z0-9-]+$/.test(entry.id) || entry.match !== entry.id) {
    return { status: "skipped", reason: "invalid owned sandbox identity" };
  }
  const result = await context.exec("sh", ["-c", 'printf "y\\n" | daytona delete "$1"', "app-web-reaper", entry.id], 60_000);
  if (result.code === 0) return { status: "reaped" };
  if (/sandbox.*not found|sandbox.*does not exist/i.test(`${result.stdout}\n${result.stderr}`)) return { status: "missing" };
  return { status: "skipped", reason: "owned app-web sandbox deletion failed" };
};
