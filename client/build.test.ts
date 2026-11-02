import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "./build.ts";

async function tempDir(t: TestContext): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "gnomepit-build-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

async function built(t: TestContext, network: string): Promise<string> {
  const out = await tempDir(t);
  await build({ network, outDir: out });
  return out;
}

test("an unknown network stops the build before it writes anything", async (t) => {
  const out = await tempDir(t);
  await writeFile(join(out, "keep.txt"), "kept");
  await assert.rejects(build({ network: "nowhere", outDir: out }), /unknown network "nowhere"/);
  assert.equal(await readFile(join(out, "keep.txt"), "utf8"), "kept");
  const run = spawnSync(process.execPath, [fileURLToPath(new URL("./build.ts", import.meta.url))], {
    env: { ...process.env, GNOMEPIT_NETWORK: "nowhere" },
    encoding: "utf8",
  });
  assert.equal(run.status, 1);
  assert.match(run.stderr, /unknown network "nowhere"/);
});

test("run through a symlink to the checkout, the script still refuses an unknown network", async (t) => {
  const checkout = join(await tempDir(t), "checkout");
  await symlink(fileURLToPath(new URL("..", import.meta.url)), checkout);
  const run = spawnSync(process.execPath, [join(checkout, "client", "build.ts")], {
    env: { ...process.env, GNOMEPIT_NETWORK: "nowhere" },
    encoding: "utf8",
  });
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /unknown network "nowhere"/);
});

test("an offline build ships the game and no dev page; a local build adds the dev pages", async (t) => {
  const offline = await built(t, "offline");
  for (const file of [
    "index.html",
    "app.js",
    "engine.wasm",
    "wasm_exec.js",
    "cards.json",
    "art/assets.json",
    "art/duel-table.jpg",
    "art/mountain-hall-v2.jpg",
    "hall.css",
  ]) {
    assert.ok(existsSync(join(offline, file)), file);
  }
  const devPages = ["adena-check.html", "online-dev.html"];
  for (const page of devPages) assert.ok(!existsSync(join(offline, page)), page);
  for (const file of ["delvers-preview.html", "art/delvers-cards-v2.json"]) {
    assert.ok(!existsSync(join(offline, file)), file);
  }
  const networkFiles = ["leaderboard.html", "leaderboard-page.js"];
  for (const file of networkFiles) assert.ok(!existsSync(join(offline, file)), file);
  const local = await built(t, "local");
  for (const page of devPages) assert.ok(existsSync(join(local, page)), page);
  for (const file of networkFiles) assert.ok(existsSync(join(local, file)), file);
  for (const out of [offline, local]) {
    assert.doesNotMatch(await readFile(join(out, "app.js"), "utf8"), /GNOMEPIT_NETWORK/);
  }
});

test("every font a stylesheet loads ships, with its licence", async (t) => {
  const offline = await built(t, "offline");
  const fonts = new Set<string>();
  for (const sheet of (await readdir(offline)).filter((name) => name.endsWith(".css"))) {
    for (const [, font] of (await readFile(join(offline, sheet), "utf8")).matchAll(/url\(["']?(fonts\/[^"')]+)/g)) {
      if (font !== undefined) fonts.add(font);
    }
  }
  assert.ok(fonts.size > 0, "no stylesheet loads a font");
  for (const font of fonts) assert.ok(existsSync(join(offline, font)), font);
  for (const licence of ["fonts/OFL-Alegreya.txt", "fonts/OFL-Alegreya-Sans.txt"]) {
    assert.ok(existsSync(join(offline, licence)), licence);
  }
});

test("a build empties its output first, so nothing from an earlier build is published", async (t) => {
  const out = await tempDir(t);
  await writeFile(join(out, "online-dev.html"), "stale");
  await build({ network: "offline", outDir: out });
  assert.ok(!existsSync(join(out, "online-dev.html")));
});

test("the shipped pages use relative URLs, so they load under a Pages subpath", async (t) => {
  const offline = await built(t, "offline");
  assert.doesNotMatch(await readFile(join(offline, "index.html"), "utf8"), /(src|href)="\//);
  const shipped = await readdir(offline);
  for (const script of shipped.filter((name) => name.endsWith(".js"))) {
    assert.doesNotMatch(await readFile(join(offline, script), "utf8"), /(src|href)="\//, script);
  }
  for (const sheet of shipped.filter((name) => name.endsWith(".css"))) {
    assert.doesNotMatch(await readFile(join(offline, sheet), "utf8"), /url\(['"]?\//, sheet);
  }
});
