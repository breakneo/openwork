import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import source from "../native-source.json" with { type: "json" };
import { NATIVE_PLUGIN_FILES, validateNativePluginManifest } from "./native-plugin.mjs";

export const nativeSource = Object.freeze(source);
export const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const equal = (left, right) => JSON.stringify(left) === JSON.stringify(right);

export function nativeTarget(platform = process.platform, arch = process.arch) {
  if (!["darwin", "linux", "win32"].includes(platform) || !["arm64", "x64"].includes(arch)) throw new Error("Unsupported Coworker native source target.");
  return `opencode-${platform === "win32" ? "windows" : platform}-${arch}${arch === "x64" ? "-baseline" : ""}`;
}

export function verifyExecutableTarget(bytes, platform, arch) {
  nativeTarget(platform, arch);
  let actual;
  if (platform === "darwin" && bytes.length >= 32 && bytes.readUInt32LE(0) === 0xfeedfacf) actual = { 0x100000c: "arm64", 0x1000007: "x64" }[bytes.readUInt32LE(4)];
  if (platform === "linux" && bytes.length >= 64 && bytes.subarray(0, 4).equals(Buffer.from([127, 69, 76, 70])) && bytes[4] === 2 && bytes[5] === 1) actual = { 183: "arm64", 62: "x64" }[bytes.readUInt16LE(18)];
  if (platform === "win32" && bytes.length >= 64 && bytes.toString("ascii", 0, 2) === "MZ") {
    const offset = bytes.readUInt32LE(60);
    if (offset <= bytes.length - 6 && bytes.readUInt32LE(offset) === 0x4550) actual = { 0xaa64: "arm64", 0x8664: "x64" }[bytes.readUInt16LE(offset + 4)];
  }
  if (actual !== arch) throw new Error("Native executable target header does not match the receipt.");
}

export function validateSourceReceipt(receipt, platform = process.platform, arch = process.arch) {
  const digest = (value) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
  if (receipt?.format !== "coworker-native-build/v1" || !equal(receipt.source, nativeSource)
    || receipt.target !== nativeTarget(platform, arch) || receipt.platform !== platform || receipt.arch !== arch
    || receipt.version !== nativeSource.version || !digest(receipt.binary?.sha256) || !digest(receipt.binary?.unsignedSha256)
    || !Number.isSafeInteger(receipt.binary?.bytes) || receipt.binary.bytes <= 0
    || !receipt.sdk || !digest(receipt.sdk.sha256) || !receipt.sdk.files || Array.isArray(receipt.sdk.files)) throw new Error("Native source receipt does not match pinned source, version, toolchain or target.");
  const files = receipt.sdk.files;
  const required = ["schema/dist/tool.d.ts", "plugin/dist/effect/tool.d.ts", "plugin/dist/promise/tool.d.ts", "sdk/dist/tool.d.ts", "sdk/dist/effect/tool.d.ts"];
  if (required.some((name) => !digest(files[name])) || Object.entries(files).some(([name, hash]) =>
    !/^(schema|plugin|sdk)\/dist\/[a-zA-Z0-9_./-]+\.(js|ts)$/.test(name) || name.split("/").includes("..") || !digest(hash))
    || sha256(JSON.stringify(files)) !== receipt.sdk.sha256) throw new Error("Native source SDK receipt is invalid.");
  return receipt;
}

export function readNativeResource(root, file) {
  const location = path.join(root, file);
  const stat = lstatSync(location);
  if (!stat.isFile() || stat.size === 0) throw new Error(`Missing nonempty regular native resource: ${file}`);
  return readFileSync(location);
}

export function verifyPackagedNativeRuntime(resources, { platform = process.platform, arch = process.arch } = {}) {
  const read = (file) => readNativeResource(resources, file);
  const receipt = validateSourceReceipt(JSON.parse(read("sidecars/native-receipt.json")), platform, arch);
  const filename = platform === "win32" ? "opencode2.exe" : "opencode2";
  const binary = read(`sidecars/${filename}`);
  if (binary.length !== receipt.binary.bytes || sha256(binary) !== receipt.binary.sha256) throw new Error("Packaged native executable failed SHA-256 verification.");
  verifyExecutableTarget(binary, platform, arch);
  const versions = JSON.parse(read("sidecars/versions.json"));
  if (!equal(versions, { opencode2: { version: receipt.version, platform, arch } })) throw new Error("Packaged native version metadata does not match the source receipt.");
  const manifestBytes = read("native-plugins/manifest.json");
  if (sha256(manifestBytes) !== receipt.pluginsSha256) throw new Error("Packaged native SDK/plugin manifest failed SHA-256 verification.");
  const sourceBuild = { version: receipt.version, sha256: receipt.binary.sha256 };
  const manifest = validateNativePluginManifest(JSON.parse(manifestBytes), sourceBuild);
  if (manifest.sdkSourceDiffSha256 !== nativeSource.patchSha256 || manifest.sdkSha256 !== receipt.sdk.sha256) throw new Error("Packaged plugins do not match the native SDK source.");
  for (const entry of Object.values(manifest.entries)) {
    const bytes = read(`native-plugins/${entry.file}`);
    if (bytes.length !== entry.bytes || sha256(bytes) !== entry.sha256) throw new Error("Packaged native plugin failed SHA-256 verification.");
  }
  const files = ["manifest.json", ...NATIVE_PLUGIN_FILES.map((name) => name.replace(/\.js$/, ".mjs"))].sort();
  if (!equal(readdirSync(path.join(resources, "native-plugins")).sort(), files)) throw new Error("Unexpected packaged native plugin resources.");
  return { bin: path.join(resources, "sidecars", filename), sourceBuild, receipt };
}
