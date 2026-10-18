// Test support: runs engine.wasm in node, as the page runs it, so tests use the real
// rules. `make wasm` builds engine.wasm and copies wasm_exec.js.

import { readFile } from "node:fs/promises";

import { startEngine, type Engine } from "./engine.ts";

let started: Promise<Engine> | undefined;

export function nodeEngine(): Promise<Engine> {
  started ??= start();
  return started;
}

async function start(): Promise<Engine> {
  // wasm_exec.js is a script, not a module: it runs only to define globalThis.Go.
  await import(new URL("./wasm_exec.js", import.meta.url).href);
  const go = new globalThis.Go();
  const wasm = await readFile(new URL("./engine.wasm", import.meta.url));
  const { instance } = await WebAssembly.instantiate(wasm, go.importObject);
  return startEngine(go, instance, await readFile(new URL("./cards.json", import.meta.url), "utf8"));
}
