import { build } from "esbuild";
import { chmod, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";

const result = await build({
  entryPoints: { server: "src/server.ts", cli: "src/cli.ts" },
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  outdir: "runtime",
  outExtension: { ".js": ".mjs" },
  banner: { js: 'import { createRequire as __createRequire } from "node:module"; const require = __createRequire(import.meta.url);' },
  legalComments: "external",
  metafile: true,
  logLevel: "info",
});
await Promise.all(["runtime/server.mjs", "runtime/cli.mjs"].map(path => chmod(path, 0o755)));

// Keep complete dependency license texts with the standalone distribution.
const packages = new Map();
for (const input of Object.keys(result.metafile.inputs).filter(path => path.startsWith("node_modules/"))) {
  let directory = dirname(resolve(input));
  while (directory.includes(`${sep}node_modules`)) {
    try {
      const metadata = JSON.parse(await readFile(join(directory, "package.json"), "utf8"));
      if (metadata.name) { packages.set(metadata.name, { directory, metadata }); break; }
    } catch { /* Input files may be several levels below the package root. */ }
    directory = dirname(directory);
  }
}
const notices = [];
for (const [name, { directory, metadata }] of [...packages].sort(([a], [b]) => a.localeCompare(b))) {
  const licenseFiles = (await readdir(directory)).filter(name => /^(?:licen[sc]e|copying|notice)(?:\.|$)/i.test(name)).sort();
  const texts = await Promise.all(licenseFiles.map(name => readFile(join(directory, name), "utf8")));
  notices.push(`${name} ${metadata.version} (${metadata.license ?? "see notices"})\n${"=".repeat(72)}\n${texts.join("\n\n") || "See the corresponding .LEGAL.txt bundle notices."}`);
}
await writeFile("runtime/THIRD_PARTY_LICENSES.txt", notices.join("\n\n") + "\n");
