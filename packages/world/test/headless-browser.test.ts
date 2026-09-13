import assert from "node:assert/strict";
import test from "node:test";
import { headlessBrowserEnvironment } from "../src/headless-browser.ts";
import { appWebEnvironment, parseAppWebOptions } from "../../../worlds/lib/app-web-options.ts";
import { assertDevHeadlessPlacement } from "../../../worlds/dev-headless.ts";
import { appWebDaytonaReaper } from "../src/app-web-reaper.ts";

const selection = { OPENWORK_WORLD_SELECTED_ENV_KEYS: '["OPENWORK_DEV_HEADLESS_WEB_DEN_PROXY","OPENWORK_DEV_DEN_PROXY_TARGET"]' };

test("headless browser transport is opt-in and leaves loopback defaults unchanged", () => {
  assert.deepEqual(headlessBrowserEnvironment({ openworkUrl: "http://127.0.0.1:8778" }), {});
  assert.deepEqual(headlessBrowserEnvironment({ browserOrigin: "https://5178-signed.example.test", openworkUrl: "http://127.0.0.1:8778" }), {
    OPENWORK_DEV_BROWSER_ORIGIN: "https://5178-signed.example.test", OPENWORK_DEV_OPENWORK_PROXY_TARGET: "http://127.0.0.1:8778",
    VITE_OPENWORK_URL: "https://5178-signed.example.test/api/openwork", VITE_OPENWORK_PORT: "443",
  });
});

test("headless browser transport rejects non-origins and nonloopback targets", () => {
  for (const browserOrigin of ["http://example.test", "https://example.test/path", "https://example.test?token=secret", "https://user:secret@example.test", "invalid"]) {
    assert.throws(() => headlessBrowserEnvironment({ browserOrigin, openworkUrl: "http://127.0.0.1:8778" }));
  }
  assert.throws(() => headlessBrowserEnvironment({ browserOrigin: "https://example.test", openworkUrl: "https://api.example.test" }), /loopback/);
});

test("app-web selects only explicit nonsecret app environment, without Cloud opt-in by default", () => {
  assert.deepEqual(appWebEnvironment({ OPENWORK_TOKEN: "secret", OPENWORK_HOST_TOKEN: "secret", OPENAI_API_KEY: "secret", HOME: "/personal" }), {});
  assert.deepEqual(appWebEnvironment({ ...selection, OPENWORK_DEV_HEADLESS_WEB_DEN_PROXY: "1", OPENWORK_DEV_DEN_PROXY_TARGET: "https://den.example.test/", OTHER: "secret" }), {
    OPENWORK_DEV_HEADLESS_WEB_DEN_PROXY: "1", OPENWORK_DEV_DEN_PROXY_TARGET: "https://den.example.test", VITE_DISABLE_OPENWORK_MODELS: "0",
  });
  for (const target of ["https://user:secret@example.test", "https://example.test?key=secret", "file:///tmp/data", "https://example.test/path"]) {
    assert.throws(() => appWebEnvironment({ ...selection, OPENWORK_DEV_HEADLESS_WEB_DEN_PROXY: "1", OPENWORK_DEV_DEN_PROXY_TARGET: target }));
  }
  assert.throws(() => appWebEnvironment({ ...selection, OPENWORK_DEV_HEADLESS_WEB_DEN_PROXY: "maybe" }));
});

test("app-web requires exact Daytona source and rejects cloud/reuse flags", () => {
  const ref = "a".repeat(40);
  assert.deepEqual(parseAppWebOptions([], {}), { place: "local", ref: undefined, lifetimeMinutes: 120 });
  assert.deepEqual(parseAppWebOptions(["--ref", ref], { OPENWORK_WORLD_PLACE: "daytona" }), { place: "daytona", ref, lifetimeMinutes: 120 });
  assert.equal(parseAppWebOptions(["--lifetime", "30"], {}).lifetimeMinutes, 30);
  for (const value of ["0", "1", "9", "1431", "1441", "-1", "NaN"]) assert.throws(() => parseAppWebOptions(["--lifetime", value], {}));
  for (const args of [[], ["--ref", "main"], ["--cloud"], ["--ref", ref, "--reuse", "other"]]) {
    assert.throws(() => parseAppWebOptions(args, { OPENWORK_WORLD_PLACE: "daytona" }));
  }
  assert.throws(() => parseAppWebOptions(["--ref", ref], {}));
  assert.throws(() => parseAppWebOptions([], { OPENWORK_WORLD_PLACE: "elsewhere" }));
});

test("app-web consumes only CLI-selected settings and rejects secret or unknown selections", () => {
  const ambient = { OPENWORK_DEV_HEADLESS_WEB_DEN_PROXY: "1", OPENWORK_DEV_DEN_PROXY_TARGET: "https://den.example.test" };
  assert.deepEqual(appWebEnvironment({ ...ambient, OPENWORK_WORLD_SELECTED_ENV_KEYS: "[]" }), {});
  assert.deepEqual(appWebEnvironment(ambient), {});
  for (const marker of ['["OPENWORK_DEV_HEADLESS_WEB_DEN_PROXY"]', '["OPENWORK_DEV_DEN_PROXY_TARGET"]']) {
    assert.throws(() => appWebEnvironment({ ...ambient, OPENWORK_WORLD_SELECTED_ENV_KEYS: marker }), /together/);
  }
  assert.throws(() => appWebEnvironment({ ...ambient, ...selection, OPENWORK_DEV_HEADLESS_WEB_DEN_PROXY: "0" }), /together/);
  for (const marker of ['["OPENWORK_TOKEN"]', '["HOME"]', '[1]', '{}', 'invalid']) {
    assert.throws(() => appWebEnvironment({ ...ambient, OPENWORK_WORLD_SELECTED_ENV_KEYS: marker }));
  }
});

test("dev-headless explicitly rejects nonlocal placement without changing its local default", () => {
  assert.doesNotThrow(() => assertDevHeadlessPlacement({}));
  assert.doesNotThrow(() => assertDevHeadlessPlacement({ OPENWORK_WORLD_PLACE: "local" }));
  assert.throws(() => assertDevHeadlessPlacement({ OPENWORK_WORLD_PLACE: "daytona" }), /only --place local/);
});

test("app-web reaper deletes only the ledger-owned sandbox and retains failed deletion", async () => {
  const entry = { kind: "app-web-daytona", id: "sandbox-id", match: "sandbox-id", at: "now" };
  const calls: string[][] = [];
  const context = { cwd: "/tmp", allowedTmpRoots: [], exec: async (command: string, args: string[]) => {
    calls.push([command, ...args]); return { code: 0, stdout: "", stderr: "" };
  } };
  assert.deepEqual(await appWebDaytonaReaper(entry, context), { status: "reaped" });
  assert.equal(calls[0]?.at(-1), entry.id);
  assert.equal((await appWebDaytonaReaper({ ...entry, match: "other" }, context)).status, "skipped");
  assert.equal(calls.length, 1);
  assert.equal((await appWebDaytonaReaper(entry, { ...context, exec: async () => ({ code: 1, stdout: "", stderr: "failed" }) })).status, "skipped");
  for (const stream of ["stdout", "stderr"]) {
    assert.equal((await appWebDaytonaReaper(entry, { ...context, exec: async () => ({ code: 1, stdout: "", stderr: "", [stream]: "Sandbox not found" }) })).status, "missing");
  }
});
