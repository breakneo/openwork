import { defineConfig } from "tsup"

export default defineConfig({
  entry: { "recover-0097": "scripts/recover-mysql-0097.ts" },
  outDir: "dist/recovery-bundle/openwork-mysql-0097-recovery/bin",
  outExtension: () => ({ js: ".mjs" }),
  format: ["esm"],
  dts: false,
  platform: "node",
  target: "node20",
  splitting: false,
  sourcemap: false,
  minify: false,
  treeshake: true,
  clean: false,
  noExternal: [/^(?!node:|drizzle-kit)/],
  external: ["drizzle-kit", "drizzle-kit/api"],
  banner: {
    js: "#!/usr/bin/env node\nimport { createRequire as __createRequire } from 'node:module';\nconst require = __createRequire(import.meta.url);",
  },
})
