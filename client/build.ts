// Builds the site for one network: a bundle per page, the pages' HTML and the files they fetch.
// Run as a script, it builds dist/ for $GNOMEPIT_NETWORK, local by default.

import { realpathSync } from "node:fs";
import { copyFile, mkdir, readdir, rm } from "node:fs/promises";
import { join, parse } from "node:path";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";

import { networkFor } from "./web/network.ts";

export type BuildOptions = { network: string; outDir: string };

const web = fileURLToPath(new URL("./web/", import.meta.url));

const pages = [
  { html: "index.html", entry: "app.ts" },
  { html: "delvers-preview.html", entry: "delvers-preview.ts" },
];
// Pages that read the chain, so a build without a network has nothing to show on them.
const networkPages = [{ html: "leaderboard.html", entry: "leaderboard-page.ts" }];
const devPages = [
  { html: "adena-check.html", entry: "adena-check.ts" },
  { html: "online-dev.html", entry: "online-dev.ts" },
  { html: "lobby-preview.html", entry: "lobby-preview.ts" },
];
const staticFiles = [
  "cards.json",
  "art/assets.json",
  "art/delvers-cards-v2.json",
  "engine.wasm",
  "wasm_exec.js",
  "sw.js",
];

// browserBundle gives the options that bundle a module for the page, with the shims standing in
// for the Node Buffer and crypto the gno clients call.
export function browserBundle(): esbuild.BuildOptions {
  return {
    bundle: true,
    format: "esm",
    target: "es2022",
    platform: "browser",
    inject: [join(web, "shims/buffer.ts")],
    alias: { crypto: join(web, "shims/crypto.ts") },
  };
}

// build replaces everything in outDir with the site; an unknown network rejects before any write.
export async function build(options: BuildOptions): Promise<void> {
  const network = networkFor(options.network);
  const shipped = [
    ...pages,
    ...(network === null ? [] : networkPages),
    ...(options.network === "local" ? devPages : []),
  ];
  await rm(options.outDir, { recursive: true, force: true });
  await mkdir(join(options.outDir, "art"), { recursive: true });
  await esbuild.build({
    ...browserBundle(),
    entryPoints: shipped.map(({ entry }) => ({ in: join(web, entry), out: parse(entry).name })),
    outdir: options.outDir,
    minify: true,
    define: { GNOMEPIT_NETWORK: JSON.stringify(options.network) },
  });
  // ceiling: names are not hashed and Pages caches each file ten minutes, so for ten minutes after a
  // deploy a visit can pair the new HTML with an old bundle; hashing names and rewriting the HTML lifts it.
  const css = (await readdir(web)).filter((name) => name.endsWith(".css"));
  const art = (await readdir(join(web, "art"))).filter((name) => name.endsWith(".jpg")).map((name) => `art/${name}`);
  const files = [...shipped.map(({ html }) => html), ...css, ...staticFiles, ...art];
  await Promise.all(files.map((file) => copyFile(join(web, file), join(options.outDir, file))));
}

if (realpathSync(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  try {
    await build({
      network: process.env.GNOMEPIT_NETWORK ?? "local",
      outDir: fileURLToPath(new URL("../dist/", import.meta.url)),
    });
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  }
}
