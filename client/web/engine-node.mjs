// Test support: runs engine.wasm in node, as the page runs it, so tests use the real
// rules. `make wasm` builds engine.wasm and copies wasm_exec.js.

import { readFile } from "node:fs/promises";

import { startEngine } from "./engine.ts";

let started;

export function nodeEngine() {
  started ??= start();
  return started;
}

async function start() {
  await import("./wasm_exec.js");
  const go = new globalThis.Go();
  const wasm = await readFile(new URL("./engine.wasm", import.meta.url));
  const { instance } = await WebAssembly.instantiate(wasm, go.importObject);
  return startEngine(go, instance, await readFile(new URL("./cards.json", import.meta.url), "utf8"));
}
