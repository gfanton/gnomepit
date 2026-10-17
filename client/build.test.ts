import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "./build.ts";

async function built(network: string): Promise<string> {
  const out = await mkdtemp(join(tmpdir(), "gnomehall-build-"));
  await build({ network, outDir: out });
  return out;
}

void test("an unknown network stops the build before it writes anything", async () => {
  const out = await mkdtemp(join(tmpdir(), "gnomehall-build-"));
  await writeFile(join(out, "keep.txt"), "kept");
  await assert.rejects(build({ network: "nowhere", outDir: out }), /unknown network "nowhere"/);
  assert.equal(await readFile(join(out, "keep.txt"), "utf8"), "kept");
  const run = spawnSync(process.execPath, [fileURLToPath(new URL("./build.ts", import.meta.url))], {
    env: { ...process.env, GNOMEHALL_NETWORK: "nowhere" },
    encoding: "utf8",
  });
  assert.equal(run.status, 1);
  assert.match(run.stderr, /unknown network "nowhere"/);
});

void test("an offline build ships the game and no dev page; a local build adds the dev pages", async () => {
  const offline = await built("offline");
  for (const file of [
    "index.html",
    "app.js",
    "delvers-preview.html",
    "delvers-preview.js",
    "engine.wasm",
    "wasm_exec.js",
    "cards.json",
    "art/assets.json",
    "art/delvers-cards-v2.json",
    "art/duel-table.jpg",
  ]) {
    assert.ok(existsSync(join(offline, file)), file);
  }
  const devPages = ["adena-check.html", "online-dev.html", "lobby-preview.html"];
  for (const page of devPages) assert.ok(!existsSync(join(offline, page)), page);
  const local = await built("local");
  for (const page of devPages) assert.ok(existsSync(join(local, page)), page);
});

void test("a build empties its output first, so nothing from an earlier build is published", async () => {
  const out = await mkdtemp(join(tmpdir(), "gnomehall-build-"));
  await writeFile(join(out, "online-dev.html"), "stale");
  await build({ network: "offline", outDir: out });
  assert.ok(!existsSync(join(out, "online-dev.html")));
});

void test("the shipped pages use relative URLs, so they load under a Pages subpath", async () => {
  const offline = await built("offline");
  for (const page of ["index.html", "delvers-preview.html"]) {
    assert.doesNotMatch(await readFile(join(offline, page), "utf8"), /(src|href)="\//, page);
  }
});
