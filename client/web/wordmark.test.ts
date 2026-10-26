import test from "node:test";
import assert from "node:assert/strict";

import { wordmarkHTML } from "./wordmark.ts";

test("the wordmark links home, names the game and marks it as in beta", () => {
  const html = wordmarkHTML("index.html");
  assert.match(html, /^<a class="wordmark" href="index\.html">Gnomepit</);
  assert.match(html, /<span class="wordmark__beta">Beta<\/span>/);
  assert.match(html, /UNDER THE MOUNTAIN<\/span><\/a>$/);
});

test("the wordmark carries the attributes a page gives its link", () => {
  assert.match(
    wordmarkHTML("./", 'data-action="onlineExit"'),
    /^<a class="wordmark" href="\.\/" data-action="onlineExit">/,
  );
});
