import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { nativeSource, nativeTarget, sha256, validateSourceReceipt, verifyExecutableTarget } from "../electron/packaged-native-runtime.mjs";

const repo = fileURLToPath(new URL("../../../", import.meta.url));
const cacheRoot = fileURLToPath(new URL("../resources/sidecars/.native-source/", import.meta.url));
export const nativeBuildKey = (platform = process.platform, arch = process.arch) => sha256(JSON.stringify({ source: nativeSource, target: nativeTarget(platform, arch), recipe: 1 }));

function run(command, args, cwd, env, capture = false) {
  const result = spawnSync(command, args, { cwd, env, encoding: "utf8", stdio: capture ? "pipe" : "inherit", timeout: 30 * 60_000 });
  if (result.error || result.status !== 0) throw new Error(`Native build ${command} ${args.join(" ")} failed (${result.status ?? result.error?.code}).${capture ? `\n${result.stderr}` : ""}`);
  return result.stdout?.trim();
}

function environment(root) {
  const env = {};
  for (const key of ["PATH", "SystemRoot", "SYSTEMROOT", "COMSPEC", "PATHEXT", "WINDIR", "NUMBER_OF_PROCESSORS"]) if (process.env[key]) env[key] = process.env[key];
  for (const name of ["home", "tmp", "home/.config", "home/.cache", "home/.local/share", "home/.local/state"]) mkdirSync(path.join(root, name), { recursive: true });
  return { ...env, HOME: path.join(root, "home"), USERPROFILE: path.join(root, "home"), TMPDIR: path.join(root, "tmp"), TMP: path.join(root, "tmp"), TEMP: path.join(root, "tmp"),
    XDG_CONFIG_HOME: path.join(root, "home/.config"), XDG_CACHE_HOME: path.join(root, "home/.cache"), XDG_DATA_HOME: path.join(root, "home/.local/share"), XDG_STATE_HOME: path.join(root, "home/.local/state"),
    GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null", GIT_TERMINAL_PROMPT: "0", HUSKY: "0", RECORD: "false",
    OPENCODE_VERSION: nativeSource.version, OPENCODE_CHANNEL: nativeSource.channel };
}

function sdkFiles(root) {
  const files = {};
  function walk(directory, relative) {
    for (const name of readdirSync(directory).sort()) {
      const file = path.join(directory, name);
      const key = `${relative}/${name}`;
      const stat = lstatSync(file);
      if (stat.isDirectory()) walk(file, key);
      else if (stat.isFile() && /\.(js|ts)$/.test(name)) files[key] = sha256(readFileSync(file));
      else throw new Error(`Unexpected native SDK output: ${key}`);
    }
  }
  for (const name of ["schema", "plugin", "sdk"]) walk(path.join(root, "packages", name, "dist"), `${name}/dist`);
  return files;
}

export function verifySourceTree(root, env) {
  if (run("git", ["rev-parse", "HEAD"], root, env, true) !== nativeSource.commit
    || run("git", ["write-tree"], root, env, true) !== nativeSource.tree) throw new Error("Native source checkout does not match the pinned patched tree.");
  run("git", ["diff", "--exit-code", "--no-ext-diff"], root, env, true);
  if (run("git", ["ls-files", "--others", "--exclude-standard"], root, env, true)) throw new Error("Native source checkout has unexpected untracked inputs.");
  if (sha256(readFileSync(path.join(root, "bun.lock"))) !== nativeSource.lockSha256) throw new Error("Native lockfile checksum mismatch.");
}

export function prepareNativeSource({ requireCached = false } = {}) {
  if (sha256(readFileSync(path.join(repo, nativeSource.patch))) !== nativeSource.patchSha256) throw new Error("Native dependency patch checksum mismatch.");
  const target = nativeTarget();
  const directory = path.join(cacheRoot, nativeBuildKey());
  const sourceDirectory = path.join(directory, "source");
  const binary = path.join(directory, "cli", target.replace(/^opencode-/, "cli-"), "bin", process.platform === "win32" ? "opencode.exe" : "opencode");
  const receiptFile = path.join(directory, "build-receipt.json");
  if (run("bun", ["--version"], repo, { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot }, true) !== nativeSource.bunVersion) throw new Error(`Native source builds require Bun ${nativeSource.bunVersion} on PATH.`);
  const present = existsSync(directory);
  if (requireCached && !existsSync(receiptFile)) throw new Error("Prepare the native source in the nonsigning build step before packaging with Apple credentials.");
  if (present && !existsSync(receiptFile)) throw new Error(`Incomplete native build cache: ${directory}. Inspect it and move it aside before retrying; no stale fallback is allowed.`);
  mkdirSync(directory, { recursive: true });
  const env = environment(directory);
  if (run("bun", ["--version"], repo, env, true) !== nativeSource.bunVersion) throw new Error(`Native source builds require Bun ${nativeSource.bunVersion} on PATH.`);
  if (!present) {
    mkdirSync(sourceDirectory);
    run("git", ["init", "--quiet"], sourceDirectory, env);
    run("git", ["-c", "core.autocrlf=false", "fetch", "--depth=1", "--no-tags", nativeSource.repository, nativeSource.commit], sourceDirectory, env);
    run("git", ["-c", "core.autocrlf=false", "checkout", "--detach", "FETCH_HEAD"], sourceDirectory, env);
    run("git", ["apply", "--check", "--index", "--whitespace=error-all", path.join(repo, nativeSource.patch)], sourceDirectory, env);
    run("git", ["apply", "--index", "--whitespace=error-all", path.join(repo, nativeSource.patch)], sourceDirectory, env);
    verifySourceTree(sourceDirectory, env);
    run("bun", ["install", "--frozen-lockfile"], sourceDirectory, env);
    for (const name of ["schema", "plugin", "sdk"]) run("bun", ["run", "--cwd", `packages/${name}`, "build"], sourceDirectory, env);
    run("bun", ["run", "--cwd", "packages/cli", "build", `--target=${target}`, "--skip-install", "--skip-web-ui", `--outdir=${path.join(directory, "cli")}`], sourceDirectory, env);
  }
  verifySourceTree(sourceDirectory, env);
  for (const name of ["schema", "plugin", "sdk"]) {
    const pkg = JSON.parse(readFileSync(path.join(sourceDirectory, "packages", name, "package.json")));
    if (pkg.name !== `@opencode/${name}` || pkg.version !== nativeSource.sdkVersion) throw new Error("Native SDK package identity mismatch.");
  }
  const require = createRequire(path.join(sourceDirectory, "packages/plugin/package.json"));
  for (const name of ["effect", "zod"]) if (JSON.parse(readFileSync(require.resolve(`${name}/package.json`))).version !== nativeSource[`${name}Version`]) throw new Error(`Native ${name} version mismatch.`);
  if (!lstatSync(binary).isFile()) throw new Error("Native source executable must be a regular file.");
  const bytes = readFileSync(binary);
  if ([repo, repo.replaceAll("\\", "/")].some((directory) => bytes.includes(Buffer.from(directory)))) throw new Error("Native executable contains a private source build path.");
  verifyExecutableTarget(bytes, process.platform, process.arch);
  const files = sdkFiles(sourceDirectory);
  const receipt = { format: "coworker-native-build/v1", source: nativeSource, target, platform: process.platform, arch: process.arch, version: nativeSource.version,
    binary: { sha256: sha256(bytes), unsignedSha256: sha256(bytes), bytes: bytes.length }, sdk: { sha256: sha256(JSON.stringify(files)), files } };
  validateSourceReceipt(receipt);
  if (present) {
    const previous = JSON.parse(readFileSync(receiptFile));
    validateSourceReceipt(previous);
    if (JSON.stringify(receipt) !== JSON.stringify(previous)) throw new Error("Native build cache content does not match its receipt; refusing stale or modified artifacts.");
  }
  const versionEnv = { ...env };
  delete versionEnv.OPENCODE_VERSION;
  delete versionEnv.OPENCODE_CHANNEL;
  if (run(binary, ["--version"], directory, versionEnv, true) !== `opencode v${nativeSource.version}`) throw new Error("Native source executable version mismatch.");
  if (!present) {
    writeFileSync(`${receiptFile}.tmp`, `${JSON.stringify(receipt, null, 2)}\n`);
    renameSync(`${receiptFile}.tmp`, receiptFile);
  }
  console.log(`Native source ${present ? "verified cache" : "fresh build"}: ${target} ${receipt.binary.sha256}`);
  return { sourceDirectory, binary, receipt };
}

export async function stageNativeSource({ resources, requireCached = false, prepareBundles }) {
  const candidate = prepareNativeSource({ requireCached });
  const plugins = path.join(resources, "native-plugins");
  await prepareBundles({ sourceDirectory: candidate.sourceDirectory, outputDirectory: plugins, receipt: candidate.receipt });
  const sidecars = path.join(resources, "sidecars");
  mkdirSync(sidecars, { recursive: true });
  cpSync(candidate.binary, path.join(sidecars, process.platform === "win32" ? "opencode2.exe" : "opencode2"));
  const receipt = { ...candidate.receipt, pluginsSha256: sha256(readFileSync(path.join(plugins, "manifest.json"))) };
  writeFileSync(path.join(sidecars, "native-receipt.json"), `${JSON.stringify(receipt, null, 2)}\n`);
  writeFileSync(path.join(sidecars, "versions.json"), `${JSON.stringify({ opencode2: { version: receipt.version, platform: receipt.platform, arch: receipt.arch } }, null, 2)}\n`);
  return { receipt, license: readFileSync(path.join(candidate.sourceDirectory, "LICENSE")) };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) prepareNativeSource();
