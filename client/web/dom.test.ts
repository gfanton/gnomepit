import test from "node:test";
import assert from "node:assert/strict";

import { elementById } from "./dom.ts";

test("elementById gives the element of the expected class and throws on a missing or different one", (t) => {
  // Node has no DOM: the fake classes extend a stand-in for HTMLElement.
  Object.defineProperty(globalThis, "HTMLElement", { value: class {}, configurable: true });
  class Button extends HTMLElement {}
  class Link extends HTMLElement {}
  const go = new Button();
  const elements = new Map<string, HTMLElement>([
    ["go", go],
    ["other", new Link()],
  ]);
  Object.defineProperty(globalThis, "document", {
    value: { getElementById: (id: string) => elements.get(id) ?? null },
    configurable: true,
  });
  t.after(() => {
    Reflect.deleteProperty(globalThis, "document");
    Reflect.deleteProperty(globalThis, "HTMLElement");
  });

  assert.equal(elementById("go", Button), go);
  assert.throws(() => elementById("other", Button), /#other is missing or is not a Button/);
  assert.throws(() => elementById("none", Button), /#none is missing or is not a Button/);
});
