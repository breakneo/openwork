import { build } from "esbuild";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { isBuiltin, createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { nativePluginSources } from "./prepare-native-plugins.mjs";

async function digest(file) {
  const hash = createHash("sha256");
  for await (const bytes of createReadStream(file)) hash.update(bytes);
  return hash.digest("hex");
}

export async function readNativeSourceFixture(manifestPath) {
  if (!path.isAbsolute(manifestPath)) throw new Error("The source fixture requires an absolute build manifest path.");
  const expectedManifest = process.env.OPENWORK_COWORKER_NATIVE_SOURCE_MANIFEST_SHA256;
  if (expectedManifest && (!/^[0-9a-f]{64}$/.test(expectedManifest) || await digest(manifestPath) !== expectedManifest)) throw new Error("The native source build manifest does not match its supplied SHA-256.");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  if (manifest.kind !== "local-modified-source-native-candidate" || !path.isAbsolute(manifest.source?.directory ?? "")
    || !path.isAbsolute(manifest.executable?.path ?? "") || !/^[0-9a-f]{64}$/.test(manifest.executable.sha256)) throw new Error("Invalid native source fixture provenance.");
  if (await digest(manifest.executable.path) !== manifest.executable.sha256) throw new Error("The native source executable does not match its build receipt.");
  const contracts = manifest.sdkArtifacts?.verifiedContractArtifacts;
  if (!contracts || ["packages/schema/dist/tool.d.ts", "packages/plugin/dist/effect/tool.d.ts"].some((key) => !/^[0-9a-f]{64}$/.test(contracts[key]))) throw new Error("The matching SDK scope contract receipts are required.");
  for (const [relative, expected] of Object.entries(contracts)) {
    if (!/^packages\/(schema|plugin|sdk)\/dist\/.+\.(js|d\.ts)$/.test(relative) || relative.includes("..") || await digest(path.join(manifest.source.directory, relative)) !== expected) throw new Error("The native SDK contract does not match its build receipt.");
  }
  for (const name of ["plugin", "schema"]) {
    const pkg = JSON.parse(await readFile(path.join(manifest.source.directory, "packages", name, "package.json"), "utf8"));
    if (pkg.name !== `@opencode/${name}` || pkg.version !== "2.0.5") throw new Error("Unexpected native source package identity.");
  }
  if (manifest.hookContract?.nativeAdvertisedFields?.filesystemScopeVersion !== 1 || manifest.hookContract.nativeAdvertisedFields.filesystemScopeProjectResolution !== 1) throw new Error("The source build receipt does not include native project resolution.");
  return manifest;
}

export async function prepareNativeSourceBundles(manifest, directory) {
  const plugins = await installNativeSourceFixture(manifest, directory);
  const entries = {};
  for (const [index, name] of Object.keys(nativePluginSources()).entries()) {
    const bytes = await readFile(path.join(fileURLToPath(plugins[index]), "server.js"));
    const file = name.replace(/\.js$/, ".mjs");
    await writeFile(path.join(directory, file), bytes);
    entries[name] = { file, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
  }
  const sourceBuild = { version: manifest.executable.versionOutput.replace(/^opencode v/, ""), sha256: manifest.executable.sha256 };
  const bundleManifest = { format: "coworker-native-source-plugins/v1", opencodeVersion: sourceBuild.version, executableSha256: sourceBuild.sha256,
    sdkSourceDiffSha256: manifest.source.combinedDiffSha256, dependencies: { "@opencode/plugin": "2.0.5", "@opencode/schema": "2.0.5" }, entries };
  await writeFile(path.join(directory, "manifest.json"), JSON.stringify(bundleManifest, null, 2) + "\n");
  return { directory, sourceBuild };
}

export async function installNativeSourceFixture(manifest, directory, extraSources = {}, { includeCoworkerPlugins = true } = {}) {
  const sourceRoot = manifest.source.directory;
  const require = createRequire(path.join(sourceRoot, "packages/plugin/package.json"));
  const packages = { effect: require.resolve("effect"), zod: require.resolve("zod") };
  const resolver = { name: "matching-native-source-sdk", setup(plugin) {
    plugin.onResolve({ filter: /^@opencode(?:-ai)?\/(plugin|schema)(\/.*)?$/ }, (args) => {
      const match = /^@opencode(?:-ai)?\/(plugin|schema)(?:\/(.*))?$/.exec(args.path);
      const relative = match[2] === "effect" ? "effect/index" : match[2] ?? "index";
      if (relative.includes("..")) throw new Error("Invalid native SDK import.");
      return { path: path.join(sourceRoot, "packages", match[1], "dist", `${relative}.js`) };
    });
    plugin.onResolve({ filter: /^(effect|zod)$/ }, (args) => ({ path: packages[args.path] }));
  } };
  const plugins = [];
  const entries = {};
  for (const [name, contents] of Object.entries({ ...(includeCoworkerPlugins ? nativePluginSources() : {}), ...extraSources })) {
    if (!/^[a-z0-9-]+\.js$/.test(name)) throw new Error("Invalid fixture plugin name.");
    const result = await build({ stdin: { contents, sourcefile: name, resolveDir: sourceRoot, loader: "js" }, plugins: [resolver], bundle: true,
      platform: "node", format: "esm", target: "node22", write: false, metafile: true, logLevel: "silent" });
    if (Object.values(result.metafile.outputs).some((output) => output.imports.some((item) => item.external && !isBuiltin(item.path)))) throw new Error("A native source fixture bundle retained external imports.");
    const root = path.join(directory, ".opencode", "coworker-plugins", name.replace(/\.js$/, ""));
    await mkdir(root, { recursive: true });
    const bytes = result.outputFiles[0].contents;
    await writeFile(path.join(root, "server.js"), bytes);
    await writeFile(path.join(root, "package.json"), '{"private":true,"type":"module"}\n');
    entries[name] = { sha256: createHash("sha256").update(bytes).digest("hex"), bytes: bytes.length };
    plugins.push(pathToFileURL(root).href);
  }
  await writeFile(path.join(directory, "native-source-fixture.json"), JSON.stringify({ format: "coworker-native-source-fixture/v1", executableSha256: manifest.executable.sha256,
    sourceBaseSha: manifest.source.baseSha, sourceDiffSha256: manifest.source.combinedDiffSha256, packages: ["@opencode/plugin@2.0.5", "@opencode/schema@2.0.5"], entries }, null, 2));
  return plugins;
}
