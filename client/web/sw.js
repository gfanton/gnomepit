// Copied unchanged from gnotif (github.com/gfanton/gnotif, js/dist/sw.js at 7833504); Apache-2.0.
/*! gnotif service worker. A dapp serves a copy of this file from its own
 * origin and registers it as sw.js?server=<gnotif server URL>, plus an
 * optional &icon=<image URL> that every notification shows. */
/*! Valibot (MIT), bundled in this file.

Copyright (c) Fabian Hiller

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE. */
"use strict";
(() => {
  // src/link.ts
  function safeLink(link, scope) {
    try {
      const url = new URL(link, scope);
      if (url.origin === new URL(scope).origin) {
        return url.href;
      }
    } catch {
    }
    return scope;
  }

  // ../node_modules/.pnpm/valibot@1.5.0_typescript@7.0.2/node_modules/valibot/dist/index.mjs
  var store$4;
  var DEFAULT_CONFIG = {
    lang: void 0,
    message: void 0,
    abortEarly: void 0,
    abortPipeEarly: void 0
  };
  // @__NO_SIDE_EFFECTS__
  function getGlobalConfig(config$1) {
    if (!config$1 && !store$4) return DEFAULT_CONFIG;
    return {
      lang: config$1?.lang ?? store$4?.lang,
      message: config$1?.message,
      abortEarly: config$1?.abortEarly ?? store$4?.abortEarly,
      abortPipeEarly: config$1?.abortPipeEarly ?? store$4?.abortPipeEarly
    };
  }
  var store$3;
  // @__NO_SIDE_EFFECTS__
  function getGlobalMessage(lang) {
    return store$3?.get(lang);
  }
  var store$2;
  // @__NO_SIDE_EFFECTS__
  function getSchemaMessage(lang) {
    return store$2?.get(lang);
  }
  var store$1;
  // @__NO_SIDE_EFFECTS__
  function getSpecificMessage(reference, lang) {
    return store$1?.get(reference)?.get(lang);
  }
  // @__NO_SIDE_EFFECTS__
  function _stringify(input) {
    const type = typeof input;
    if (type === "string") return `"${input}"`;
    if (type === "number" || type === "bigint" || type === "boolean") return `${input}`;
    if (type === "object" || type === "function") return (input && Object.getPrototypeOf(input)?.constructor?.name) ?? "null";
    return type;
  }
  function _addIssue(context, label, dataset, config$1, other) {
    const input = other && "input" in other ? other.input : dataset.value;
    const expected = other?.expected ?? context.expects ?? null;
    const received = other?.received ?? /* @__PURE__ */ _stringify(input);
    const issue = {
      kind: context.kind,
      type: context.type,
      input,
      expected,
      received,
      message: `Invalid ${label}: ${expected ? `Expected ${expected} but r` : "R"}eceived ${received}`,
      requirement: context.requirement,
      path: other?.path,
      issues: other?.issues,
      lang: config$1.lang,
      abortEarly: config$1.abortEarly,
      abortPipeEarly: config$1.abortPipeEarly
    };
    const isSchema = context.kind === "schema";
    const message$1 = other?.message ?? context.message ?? /* @__PURE__ */ getSpecificMessage(context.reference, issue.lang) ?? (isSchema ? /* @__PURE__ */ getSchemaMessage(issue.lang) : null) ?? config$1.message ?? /* @__PURE__ */ getGlobalMessage(issue.lang);
    if (message$1 !== void 0) issue.message = typeof message$1 === "function" ? message$1(issue) : message$1;
    if (isSchema) dataset.typed = false;
    if (dataset.issues) dataset.issues.push(issue);
    else dataset.issues = [issue];
  }
  // @__NO_SIDE_EFFECTS__
  function _isValidObjectKey(object$1, key) {
    return Object.prototype.hasOwnProperty.call(object$1, key) && key !== "__proto__" && key !== "prototype" && key !== "constructor";
  }
  function _standardSchema(schema) {
    schema["~standard"] = {
      version: 1,
      vendor: "valibot",
      validate: (value$1) => schema["~run"]({ value: value$1 }, /* @__PURE__ */ getGlobalConfig())
    };
    return schema;
  }
  // @__NO_SIDE_EFFECTS__
  function nonEmpty(message$1) {
    return {
      kind: "validation",
      type: "non_empty",
      reference: nonEmpty,
      async: false,
      expects: "!0",
      message: message$1,
      "~run"(dataset, config$1) {
        if (dataset.typed && dataset.value.length === 0) _addIssue(this, "length", dataset, config$1, { received: "0" });
        return dataset;
      }
    };
  }
  // @__NO_SIDE_EFFECTS__
  function regex(requirement, message$1) {
    return {
      kind: "validation",
      type: "regex",
      reference: regex,
      async: false,
      expects: `${requirement}`,
      requirement,
      message: message$1,
      "~run"(dataset, config$1) {
        if (dataset.typed && !this.requirement.test(dataset.value)) _addIssue(this, "format", dataset, config$1);
        return dataset;
      }
    };
  }
  // @__NO_SIDE_EFFECTS__
  function getFallback(schema, dataset, config$1) {
    return typeof schema.fallback === "function" ? schema.fallback(dataset, config$1) : schema.fallback;
  }
  // @__NO_SIDE_EFFECTS__
  function getDefault(schema, dataset, config$1) {
    return typeof schema.default === "function" ? schema.default(dataset, config$1) : schema.default;
  }
  // @__NO_SIDE_EFFECTS__
  function looseObject(entries$1, message$1) {
    return _standardSchema({
      kind: "schema",
      type: "loose_object",
      reference: looseObject,
      expects: "Object",
      async: false,
      entries: entries$1,
      message: message$1,
      "~run"(dataset, config$1) {
        const input = dataset.value;
        if (input && typeof input === "object") {
          dataset.typed = true;
          dataset.value = {};
          for (const key in this.entries) {
            const valueSchema = this.entries[key];
            if (key in input || (valueSchema.type === "exact_optional" || valueSchema.type === "optional" || valueSchema.type === "nullish") && valueSchema.default !== void 0) {
              const value$1 = key in input ? input[key] : /* @__PURE__ */ getDefault(valueSchema);
              const valueDataset = valueSchema["~run"]({ value: value$1 }, config$1);
              if (valueDataset.issues) {
                const pathItem = {
                  type: "object",
                  origin: "value",
                  input,
                  key,
                  value: value$1
                };
                for (const issue of valueDataset.issues) {
                  if (issue.path) issue.path.unshift(pathItem);
                  else issue.path = [pathItem];
                  dataset.issues?.push(issue);
                }
                if (!dataset.issues) dataset.issues = valueDataset.issues;
                if (config$1.abortEarly) {
                  dataset.typed = false;
                  break;
                }
              }
              if (!valueDataset.typed) dataset.typed = false;
              dataset.value[key] = valueDataset.value;
            } else if (valueSchema.fallback !== void 0) dataset.value[key] = /* @__PURE__ */ getFallback(valueSchema);
            else if (valueSchema.type !== "exact_optional" && valueSchema.type !== "optional" && valueSchema.type !== "nullish") {
              _addIssue(this, "key", dataset, config$1, {
                input: void 0,
                expected: `"${key}"`,
                path: [{
                  type: "object",
                  origin: "key",
                  input,
                  key,
                  value: input[key]
                }]
              });
              if (config$1.abortEarly) break;
            }
          }
          if (!dataset.issues || !config$1.abortEarly) {
            for (const key in input) if (/* @__PURE__ */ _isValidObjectKey(input, key) && !Object.prototype.hasOwnProperty.call(this.entries, key)) dataset.value[key] = input[key];
          }
        } else _addIssue(this, "type", dataset, config$1);
        return dataset;
      }
    });
  }
  // @__NO_SIDE_EFFECTS__
  function object(entries$1, message$1) {
    return _standardSchema({
      kind: "schema",
      type: "object",
      reference: object,
      expects: "Object",
      async: false,
      entries: entries$1,
      message: message$1,
      "~run"(dataset, config$1) {
        const input = dataset.value;
        if (input && typeof input === "object") {
          dataset.typed = true;
          dataset.value = {};
          for (const key in this.entries) {
            const valueSchema = this.entries[key];
            if (key in input || (valueSchema.type === "exact_optional" || valueSchema.type === "optional" || valueSchema.type === "nullish") && valueSchema.default !== void 0) {
              const value$1 = key in input ? input[key] : /* @__PURE__ */ getDefault(valueSchema);
              const valueDataset = valueSchema["~run"]({ value: value$1 }, config$1);
              if (valueDataset.issues) {
                const pathItem = {
                  type: "object",
                  origin: "value",
                  input,
                  key,
                  value: value$1
                };
                for (const issue of valueDataset.issues) {
                  if (issue.path) issue.path.unshift(pathItem);
                  else issue.path = [pathItem];
                  dataset.issues?.push(issue);
                }
                if (!dataset.issues) dataset.issues = valueDataset.issues;
                if (config$1.abortEarly) {
                  dataset.typed = false;
                  break;
                }
              }
              if (!valueDataset.typed) dataset.typed = false;
              dataset.value[key] = valueDataset.value;
            } else if (valueSchema.fallback !== void 0) dataset.value[key] = /* @__PURE__ */ getFallback(valueSchema);
            else if (valueSchema.type !== "exact_optional" && valueSchema.type !== "optional" && valueSchema.type !== "nullish") {
              _addIssue(this, "key", dataset, config$1, {
                input: void 0,
                expected: `"${key}"`,
                path: [{
                  type: "object",
                  origin: "key",
                  input,
                  key,
                  value: input[key]
                }]
              });
              if (config$1.abortEarly) break;
            }
          }
        } else _addIssue(this, "type", dataset, config$1);
        return dataset;
      }
    });
  }
  // @__NO_SIDE_EFFECTS__
  function string(message$1) {
    return _standardSchema({
      kind: "schema",
      type: "string",
      reference: string,
      expects: "string",
      async: false,
      message: message$1,
      "~run"(dataset, config$1) {
        if (typeof dataset.value === "string") dataset.typed = true;
        else _addIssue(this, "type", dataset, config$1);
        return dataset;
      }
    });
  }
  // @__NO_SIDE_EFFECTS__
  function pipe(...pipe$1) {
    return _standardSchema({
      ...pipe$1[0],
      pipe: pipe$1,
      "~run"(dataset, config$1) {
        for (const item of pipe$1) if (item.kind !== "metadata") {
          if (dataset.issues && (item.kind === "schema" || item.kind === "transformation")) {
            dataset.typed = false;
            break;
          }
          if (!dataset.issues || !config$1.abortEarly && !config$1.abortPipeEarly) dataset = item["~run"](dataset, config$1);
        }
        return dataset;
      }
    });
  }
  // @__NO_SIDE_EFFECTS__
  function safeParse(schema, input, config$1) {
    const dataset = schema["~run"]({ value: input }, /* @__PURE__ */ getGlobalConfig(config$1));
    return {
      typed: dataset.typed,
      success: !dataset.issues,
      output: dataset.value,
      issues: dataset.issues
    };
  }

  // src/push.ts
  var BASE64URL = /^(?:[\w-]{4})*[\w-]{2,4}$/;
  var VapidSchema = object({ publicKey: pipe(string(), regex(BASE64URL)) });
  var PayloadSchema = object({ title: pipe(string(), nonEmpty()), body: string(), link: string() });
  var ClickDataSchema = object({ link: string() });
  var RelayableSchema = looseObject({ id: string() });
  function parsed(schema, data) {
    const result = safeParse(schema, data);
    return result.success ? result.output : void 0;
  }
  function parseJson(text) {
    try {
      return JSON.parse(text);
    } catch {
      return void 0;
    }
  }
  function parseVapidKey(data) {
    return parsed(VapidSchema, data)?.publicKey;
  }
  function parsePayload(text) {
    return parsed(PayloadSchema, parseJson(text)) ?? { title: "New activity", body: "", link: "./" };
  }
  function relayable(text) {
    return parsed(RelayableSchema, parseJson(text));
  }
  function parseClickLink(data) {
    return parsed(ClickDataSchema, data)?.link ?? "./";
  }

  // src/sw/sw.ts
  function inScope(client) {
    return client.url.startsWith(self.registration.scope);
  }
  async function relayToWindows(text) {
    const notification = relayable(text);
    if (notification === void 0) {
      return;
    }
    const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const client of windows) {
      if (inScope(client)) {
        try {
          client.postMessage({ type: "gnotif.notification", notification });
        } catch {
        }
      }
    }
  }
  self.addEventListener("push", (event) => {
    const text = event.data !== null ? event.data.text() : "";
    const p = parsePayload(text);
    const options = {
      body: p.body,
      tag: p.link,
      renotify: true,
      data: { link: p.link }
    };
    const icon = new URL(self.location.href).searchParams.get("icon");
    if (icon !== null) {
      options.icon = icon;
    }
    event.waitUntil(
      Promise.all([self.registration.showNotification(p.title, options), relayToWindows(text).catch(() => {
      })])
    );
  });
  self.addEventListener("notificationclick", (event) => {
    event.notification.close();
    const url = safeLink(parseClickLink(event.notification.data), self.registration.scope);
    event.waitUntil(
      (async () => {
        const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
        for (const client of windows) {
          if (inScope(client)) {
            await client.focus();
            try {
              await client.navigate(url);
            } catch {
            }
            return;
          }
        }
        await self.clients.openWindow(url);
      })()
    );
  });
  self.addEventListener("pushsubscriptionchange", (event) => {
    const server = new URL(self.location.href).searchParams.get("server");
    event.waitUntil(
      (async () => {
        if (server === null) {
          throw new Error("sw.js was registered without a ?server= URL");
        }
        const sub = event.newSubscription ?? await subscribeAgain(server);
        const res = await fetch(server + "/v1/subscription", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ...sub.toJSON(), oldEndpoint: event.oldSubscription?.endpoint })
        });
        if (!res.ok) {
          throw new Error(`gnotif server answered ${res.status}`);
        }
      })()
    );
  });
  async function subscribeAgain(server) {
    const res = await fetch(server + "/v1/vapid");
    if (!res.ok) {
      throw new Error(`gnotif server answered ${res.status}`);
    }
    const publicKey = parseVapidKey(await res.json());
    if (publicKey === void 0) {
      throw new Error("gnotif server answered no VAPID key");
    }
    return self.registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: publicKey });
  }
})();
