import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { sha256, verifyPackagedNativeRuntime } from "../electron/packaged-native-runtime.mjs";

function codesign(args) {
  const result = spawnSync("/usr/bin/codesign", args, { stdio: "inherit", timeout: 120_000 });
  if (result.error || result.status !== 0) throw new Error(`Native executable signing failed (${result.status ?? result.error?.code}).`);
}

export async function sign(options, packager, { runCodesign = codesign, signApp } = {}) {
  const resources = path.join(options.app, "Contents/Resources");
  const before = verifyPackagedNativeRuntime(resources);
  if (!options.identity || options.platform !== "darwin") throw new Error("Native source signing requires the builder's resolved macOS identity.");
  const fileOptions = options.optionsForFile(before.bin);
  const args = ["--force", "--sign", options.identity];
  if (options.keychain) args.push("--keychain", options.keychain);
  if (fileOptions.entitlements) args.push("--entitlements", fileOptions.entitlements);
  if (fileOptions.hardenedRuntime) args.push("--options", "runtime");
  if (options.identity !== "-") args.push("--timestamp");
  runCodesign([...args, before.bin]);
  runCodesign(["--verify", "--strict", before.bin]);
  const bytes = readFileSync(before.bin);
  const receipt = structuredClone(before.receipt);
  receipt.binary.sha256 = sha256(bytes);
  receipt.binary.bytes = bytes.length;
  const manifestFile = path.join(resources, "native-plugins/manifest.json");
  const manifest = JSON.parse(readFileSync(manifestFile));
  manifest.executableSha256 = receipt.binary.sha256;
  const manifestBytes = `${JSON.stringify(manifest, null, 2)}\n`;
  writeFileSync(manifestFile, manifestBytes);
  receipt.pluginsSha256 = sha256(manifestBytes);
  writeFileSync(path.join(resources, "sidecars/native-receipt.json"), `${JSON.stringify(receipt, null, 2)}\n`);
  verifyPackagedNativeRuntime(resources);
  const originalIgnore = options.ignore;
  const signedOptions = { ...options, ignore: (file) => file === before.bin || originalIgnore?.(file) === true };
  if (!signApp) {
    const require = createRequire(import.meta.url);
    const builderRequire = createRequire(require.resolve("electron-builder"));
    signApp = builderRequire("app-builder-lib/out/codeSign/macCodeSign.js").sign;
  }
  await signApp(signedOptions);
  verifyPackagedNativeRuntime(resources);
  runCodesign(["--verify", "--deep", "--strict", options.app]);
}
