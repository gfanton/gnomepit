// Copied unchanged from gnotif (github.com/gfanton/gnotif, js/dist/gnotif.js at 7833504); Apache-2.0.
/*! Valibot (MIT), bundled in this file.

Copyright (c) Fabian Hiller

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE. */

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
function _isSameValueZero(value1, value2) {
  return value1 === value2 || Number.isNaN(value1) && Number.isNaN(value2);
}
// @__NO_SIDE_EFFECTS__
function _isValidObjectKey(object$1, key) {
  return Object.prototype.hasOwnProperty.call(object$1, key) && key !== "__proto__" && key !== "prototype" && key !== "constructor";
}
// @__NO_SIDE_EFFECTS__
function _joinExpects(values$1, separator) {
  const list = [...new Set(values$1)];
  if (list.length > 1) return `(${list.join(` ${separator} `)})`;
  return list[0] ?? "never";
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
var ABORT_EARLY_CONFIG = { abortEarly: true };
// @__NO_SIDE_EFFECTS__
function getFallback(schema, dataset, config$1) {
  return typeof schema.fallback === "function" ? schema.fallback(dataset, config$1) : schema.fallback;
}
// @__NO_SIDE_EFFECTS__
function fallback(schema, fallback$1) {
  return _standardSchema({
    ...schema,
    fallback: fallback$1,
    "~run"(dataset, config$1) {
      const outputDataset = schema["~run"](dataset, config$1);
      return outputDataset.issues ? {
        typed: true,
        value: /* @__PURE__ */ getFallback(this, outputDataset, config$1)
      } : outputDataset;
    }
  });
}
// @__NO_SIDE_EFFECTS__
function getDefault(schema, dataset, config$1) {
  return typeof schema.default === "function" ? schema.default(dataset, config$1) : schema.default;
}
// @__NO_SIDE_EFFECTS__
function array(item, message$1) {
  return _standardSchema({
    kind: "schema",
    type: "array",
    reference: array,
    expects: "Array",
    async: false,
    item,
    message: message$1,
    "~run"(dataset, config$1) {
      const input = dataset.value;
      if (Array.isArray(input)) {
        dataset.typed = true;
        dataset.value = [];
        for (let key = 0; key < input.length; key++) {
          const value$1 = input[key];
          const itemDataset = this.item["~run"]({ value: value$1 }, config$1);
          if (itemDataset.issues) {
            const pathItem = {
              type: "array",
              origin: "value",
              input,
              key,
              value: value$1
            };
            for (const issue of itemDataset.issues) {
              if (issue.path) issue.path.unshift(pathItem);
              else issue.path = [pathItem];
              dataset.issues?.push(issue);
            }
            if (!dataset.issues) dataset.issues = itemDataset.issues;
            if (config$1.abortEarly) {
              dataset.typed = false;
              break;
            }
          }
          if (!itemDataset.typed) dataset.typed = false;
          dataset.value.push(itemDataset.value);
        }
      } else _addIssue(this, "type", dataset, config$1);
      return dataset;
    }
  });
}
// @__NO_SIDE_EFFECTS__
function boolean(message$1) {
  return _standardSchema({
    kind: "schema",
    type: "boolean",
    reference: boolean,
    expects: "boolean",
    async: false,
    message: message$1,
    "~run"(dataset, config$1) {
      if (typeof dataset.value === "boolean") dataset.typed = true;
      else _addIssue(this, "type", dataset, config$1);
      return dataset;
    }
  });
}
// @__NO_SIDE_EFFECTS__
function literal(literal_, message$1) {
  return _standardSchema({
    kind: "schema",
    type: "literal",
    reference: literal,
    expects: /* @__PURE__ */ _stringify(literal_),
    async: false,
    literal: literal_,
    message: message$1,
    "~run"(dataset, config$1) {
      if (/* @__PURE__ */ _isSameValueZero(dataset.value, this.literal)) dataset.typed = true;
      else _addIssue(this, "type", dataset, config$1);
      return dataset;
    }
  });
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
function number(message$1) {
  return _standardSchema({
    kind: "schema",
    type: "number",
    reference: number,
    expects: "number",
    async: false,
    message: message$1,
    "~run"(dataset, config$1) {
      if (typeof dataset.value === "number" && !isNaN(dataset.value)) dataset.typed = true;
      else _addIssue(this, "type", dataset, config$1);
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
function optional(wrapped, default_) {
  return _standardSchema({
    kind: "schema",
    type: "optional",
    reference: optional,
    expects: `(${wrapped.expects} | undefined)`,
    async: false,
    wrapped,
    default: default_,
    "~run"(dataset, config$1) {
      if (dataset.value === void 0) {
        if (this.default !== void 0) dataset.value = /* @__PURE__ */ getDefault(this, dataset, config$1);
        if (dataset.value === void 0) {
          dataset.typed = true;
          return dataset;
        }
      }
      return this.wrapped["~run"](dataset, config$1);
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
function variant(key, options, message$1) {
  return _standardSchema({
    kind: "schema",
    type: "variant",
    reference: variant,
    expects: "Object",
    async: false,
    key,
    options,
    message: message$1,
    "~run"(dataset, config$1) {
      const input = dataset.value;
      if (input && typeof input === "object") {
        let outputDataset;
        let maxDiscriminatorPriority = 0;
        let invalidDiscriminatorKey = this.key;
        let expectedDiscriminators = [];
        const parseOptions = (variant$1, allKeys) => {
          for (const schema of variant$1.options) {
            if (schema.type === "variant") parseOptions(schema, new Set(allKeys).add(schema.key));
            else {
              let keysAreValid = true;
              let currentPriority = 0;
              for (const currentKey of allKeys) {
                const discriminatorSchema = schema.entries[currentKey];
                if (currentKey in input ? discriminatorSchema["~run"]({
                  typed: false,
                  value: input[currentKey]
                }, ABORT_EARLY_CONFIG).issues : discriminatorSchema.type !== "exact_optional" && discriminatorSchema.type !== "optional" && discriminatorSchema.type !== "nullish") {
                  keysAreValid = false;
                  if (invalidDiscriminatorKey !== currentKey && (maxDiscriminatorPriority < currentPriority || maxDiscriminatorPriority === currentPriority && currentKey in input && !(invalidDiscriminatorKey in input))) {
                    maxDiscriminatorPriority = currentPriority;
                    invalidDiscriminatorKey = currentKey;
                    expectedDiscriminators = [];
                  }
                  if (invalidDiscriminatorKey === currentKey) expectedDiscriminators.push(schema.entries[currentKey].expects);
                  break;
                }
                currentPriority++;
              }
              if (keysAreValid) {
                const optionDataset = schema["~run"]({ value: input }, config$1);
                if (!outputDataset || !outputDataset.typed && optionDataset.typed) outputDataset = optionDataset;
              }
            }
            if (outputDataset && !outputDataset.issues) break;
          }
        };
        parseOptions(this, /* @__PURE__ */ new Set([this.key]));
        if (outputDataset) return outputDataset;
        _addIssue(this, "type", dataset, config$1, {
          input: input[invalidDiscriminatorKey],
          expected: /* @__PURE__ */ _joinExpects(expectedDiscriminators, "|"),
          path: [{
            type: "object",
            origin: "value",
            input,
            key: invalidDiscriminatorKey,
            value: input[invalidDiscriminatorKey]
          }]
        });
      } else _addIssue(this, "type", dataset, config$1);
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

// src/protocol.ts
var TriggerSchema = object({
  id: string(),
  target: string(),
  event: string(),
  filter: string(),
  param: string(),
  title: string(),
  body: string(),
  link: string(),
  declarer: string(),
  verified: boolean()
});
var TriggersSchema = array(TriggerSchema);
var ErrorBodySchema = object({ error: optional(string()) });
var notificationEntries = {
  id: string(),
  trigger: string(),
  value: string(),
  title: string(),
  body: string(),
  link: string(),
  height: number(),
  tx: string(),
  time: string(),
  attrs: array(object({ key: string(), value: string() }))
};
var NotificationSchema = object(notificationEntries);
var FrameSchema = variant("type", [
  object({ type: literal("pong") }),
  object({ type: literal("optins") }),
  object({ type: literal("error"), error: fallback(optional(string()), void 0) }),
  object({ type: literal("notification"), ...notificationEntries })
]);
var RelaySchema = object({ type: literal("gnotif.notification"), notification: NotificationSchema });
function parseTriggers(data) {
  return parsed(TriggersSchema, data);
}
function parseErrorMessage(data) {
  return parsed(ErrorBodySchema, data)?.error;
}
function parseFrame(text) {
  return parsed(FrameSchema, parseJson(text));
}
function parseRelay(data) {
  return parsed(RelaySchema, data)?.notification;
}

// src/gnotif.ts
var PING = '{"type":"ping"}';
var PING_INTERVAL = 3e4;
var PONG_TIMEOUT = 1e4;
var BACKOFF_MIN = 1e3;
var BACKOFF_MAX = 3e4;
var DELIVERED_MAX = 256;
function browserNotification(fields, scope, source) {
  return { ...fields, source, link: safeLink(fields.link, scope) };
}
var GnotifError = class extends Error {
  status;
  code;
  /** @param status HTTP status of the error answer a "server" error comes from */
  constructor(code, message, status) {
    super(message);
    this.status = status;
    this.name = "GnotifError";
    this.code = code;
  }
};
function base64UrlToBytes(s) {
  const b64 = s.replaceAll("-", "+").replaceAll("_", "/").padEnd(Math.ceil(s.length / 4) * 4, "=");
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}
function sameKey(a, b) {
  if (a === null || a === void 0) {
    return false;
  }
  const bytes = new Uint8Array(a);
  return bytes.length === b.length && bytes.every((v, i) => v === b[i]);
}
var servers = /* @__PURE__ */ new Map([["onyx", "https://gnotif.xyz/onyx"]]);
var Gnotif = class {
  #network;
  #server;
  #serviceWorker;
  #icon;
  /** the set every channel uses, null until setOptins */
  #optins = null;
  #handlers = {
    notification: /* @__PURE__ */ new Set(),
    reconnecting: /* @__PURE__ */ new Set(),
    reconnect: /* @__PURE__ */ new Set(),
    error: /* @__PURE__ */ new Set()
  };
  /** the last DELIVERED_MAX delivered ids, oldest first */
  #delivered = /* @__PURE__ */ new Set();
  // ---- Live connection state
  #ws = null;
  #wanted = false;
  // connect() was called and disconnect() was not
  #reconnecting = false;
  // dropped after its set was accepted, and retrying
  #attempt = 0;
  // retries since the last accepted set
  #connecting = null;
  #gen = 0;
  // counts setOptins calls
  #sentGen = 0;
  // the generation of the optins frame last sent
  #inFlight = false;
  // an optins frame awaits its reply
  #dirty = false;
  // the kept set changed while a frame was in flight
  #waiters = [];
  #retry;
  #pong;
  #ping;
  constructor({
    network,
    server,
    serviceWorker = "/sw.js",
    icon
  } = {}) {
    if (server === void 0) {
      network ??= "onyx";
      server = servers.get(network);
      if (server === void 0) {
        const known = [...servers.keys()].map((name) => `"${name}"`).join(", ");
        throw new TypeError(`unknown network "${network}": use ${known}, or pass server`);
      }
    }
    this.#network = network;
    this.#server = server.replace(/\/$/, "");
    this.#serviceWorker = serviceWorker;
    this.#icon = icon;
    globalThis.navigator?.serviceWorker?.addEventListener?.("message", (e) => this.#onRelay(e.data));
  }
  /** @returns the network named at construction */
  get network() {
    return this.#network;
  }
  /** @returns base URL of the gnotif server this client calls */
  get server() {
    return this.#server;
  }
  /**
   * @param target realm path whose verified triggers to list
   * @returns the triggers that realm offers
   */
  async triggers(target) {
    if (typeof target !== "string" || target === "") {
      throw new TypeError("target must be a non-empty realm path");
    }
    const triggers = parseTriggers(await this.#request("GET", `/v1/triggers?target=${encodeURIComponent(target)}`));
    if (triggers === void 0) {
      throw new GnotifError("server", "gnotif server sent a malformed trigger list");
    }
    return triggers;
  }
  /**
   * Subscribes this browser and registers it with the server. Must run from
   * a user gesture: browsers refuse or hide a permission prompt otherwise.
   */
  async enable() {
    if (!("serviceWorker" in navigator) || !("PushManager" in globalThis) || !("Notification" in globalThis)) {
      throw new GnotifError("unsupported", "This browser has no Push API.");
    }
    if (await Notification.requestPermission() !== "granted") {
      throw new GnotifError("denied", "Notifications are not allowed for this site.");
    }
    let url = `${this.#serviceWorker}?server=${encodeURIComponent(this.#server)}`;
    if (this.#icon !== void 0) {
      url += `&icon=${encodeURIComponent(new URL(this.#icon, document.baseURI).href)}`;
    }
    await navigator.serviceWorker.register(url);
    const reg = await navigator.serviceWorker.ready;
    const publicKey = parseVapidKey(await this.#request("GET", "/v1/vapid"));
    if (publicKey === void 0) {
      throw new GnotifError("server", "gnotif server sent a malformed VAPID key");
    }
    const key = base64UrlToBytes(publicKey);
    let sub = await reg.pushManager.getSubscription();
    if (sub !== null && !sameKey(sub.options.applicationServerKey, key)) {
      await sub.unsubscribe();
      sub = null;
    }
    sub ??= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: new Uint8Array(key) });
    const json = sub.toJSON();
    await this.#request("PUT", "/v1/subscription", json);
    if (this.#optins !== null) {
      await this.#request("PUT", "/v1/subscription/optins", { endpoint: sub.endpoint, optins: this.#items(true) });
    }
    return json;
  }
  /**
   * Keeps optins as the set every channel uses, and sends it to the live
   * connection when one is open, and to the server for push when this
   * browser is subscribed, less the items with push: false. Resolves once
   * each has accepted its part.
   * @param optins replaces the previous set
   */
  async setOptins(optins) {
    this.#optins = optins;
    const gen = ++this.#gen;
    const pending = [];
    if (this.#wanted && this.#ws?.readyState === WebSocket.OPEN) {
      pending.push(
        new Promise((resolve, reject) => {
          this.#waiters.push({ gen, resolve, reject });
        })
      );
      this.#send();
    }
    pending.push(
      this.#find().then(
        (sub) => sub !== null ? this.#request("PUT", "/v1/subscription/optins", { endpoint: sub.endpoint, optins: this.#items(true) }) : null
      )
    );
    await Promise.all(pending);
  }
  /**
   * Calls handler on every event of that name until the returned function
   * runs.
   * @returns removes the handler
   */
  on(event, handler) {
    if (!Object.hasOwn(this.#handlers, event)) {
      const known = Object.keys(this.#handlers).map((name) => `"${name}"`);
      throw new TypeError(`unknown event "${event}": use ${known.slice(0, -1).join(", ")} or ${known.at(-1)}`);
    }
    const handlers = this.#handlers[event];
    handlers.add(handler);
    return () => {
      handlers.delete(handler);
    };
  }
  /**
   * Opens the live connection with the kept set, and resolves once the
   * server accepts it. The set, address included, goes to the server:
   * call this when the user asks for live updates. After a drop the
   * connection comes back by itself, firing reconnecting and reconnect.
   */
  connect() {
    if (this.#connecting !== null) {
      return this.#connecting.promise;
    }
    if (this.#wanted) {
      return Promise.resolve();
    }
    this.#wanted = true;
    let resolve = () => {
    };
    let reject = () => {
    };
    const promise = new Promise((res, rej) => {
      resolve = res;
      reject = rej;
    });
    this.#connecting = { promise, resolve, reject };
    this.#open();
    return promise;
  }
  /** Closes the live connection and stops reconnecting. */
  disconnect() {
    if (!this.#wanted) {
      return;
    }
    this.#stop(new GnotifError("inactive", "Live connection closed."));
  }
  /**
   * Unsubscribes this browser first, then tells the server; a server that
   * no longer knows the subscription (404) is not an error.
   */
  async disable() {
    const sub = await this.#subscription();
    await sub.unsubscribe();
    try {
      await this.#request("DELETE", "/v1/subscription", { endpoint: sub.endpoint });
    } catch (err) {
      if (!(err instanceof GnotifError && err.status === 404)) {
        throw err;
      }
    }
  }
  /**
   * Reports whether this browser holds a push subscription and still has
   * notification permission.
   */
  async enabled() {
    if (!("Notification" in globalThis) || Notification.permission !== "granted") {
      return false;
    }
    return await this.#find() !== null;
  }
  /**
   * Ends the live channel: no socket, no timers, no retries, and every
   * waiting promise rejected with err.
   */
  #stop(err) {
    const ws = this.#ws;
    this.#ws = null;
    this.#wanted = false;
    this.#reconnecting = false;
    this.#attempt = 0;
    this.#inFlight = false;
    this.#dirty = false;
    clearTimeout(this.#retry);
    clearTimeout(this.#pong);
    clearInterval(this.#ping);
    ws?.close(1e3);
    this.#connecting?.reject(err);
    this.#connecting = null;
    for (const w of this.#waiters.splice(0)) {
      w.reject(err);
    }
  }
  /**
   * Ends the live channel with err, and fires error unless a connect() was
   * waiting, which err rejects instead.
   */
  #fail(err) {
    const connecting = this.#connecting !== null;
    this.#stop(err);
    if (!connecting) {
      this.#emit("error", err);
    }
  }
  #open() {
    let ws;
    try {
      ws = new WebSocket(this.#server.replace(/^http/, "ws") + "/v1/stream");
    } catch (err) {
      if (this.#connecting !== null) {
        this.#stop(new GnotifError("network", err instanceof Error ? err.message : String(err)));
      } else {
        this.#onClose();
      }
      return;
    }
    this.#ws = ws;
    ws.addEventListener("open", () => {
      if (ws !== this.#ws) {
        return;
      }
      this.#send();
      this.#ping = setInterval(() => {
        ws.send(PING);
        clearTimeout(this.#pong);
        this.#pong = setTimeout(() => {
          ws.close();
          if (ws === this.#ws) {
            this.#onClose();
          }
        }, PONG_TIMEOUT);
      }, PING_INTERVAL);
    });
    ws.addEventListener("message", (e) => {
      if (ws === this.#ws && typeof e.data === "string") {
        this.#onFrame(e.data);
      }
    });
    ws.addEventListener("close", (e) => {
      if (ws === this.#ws) {
        this.#onClose(e.code);
      }
    });
  }
  // #send sends the kept set when the socket is open and no frame awaits
  // its reply; otherwise the open, or that reply, sends it.
  #send() {
    const ws = this.#ws;
    if (ws === null || ws.readyState !== WebSocket.OPEN) {
      return;
    }
    if (this.#inFlight) {
      this.#dirty = true;
      return;
    }
    this.#inFlight = true;
    this.#dirty = false;
    this.#sentGen = this.#gen;
    ws.send(JSON.stringify({ type: "optins", optins: this.#items(false) }));
  }
  // #items returns the kept set as the server takes it, without the push key;
  // pushOnly leaves out the items with push: false.
  #items(pushOnly) {
    return (this.#optins ?? []).filter((o) => !pushOnly || o.push !== false).map(({ trigger, value }) => ({ trigger, value }));
  }
  #onFrame(text) {
    const frame = parseFrame(text);
    switch (frame?.type) {
      case "pong":
        clearTimeout(this.#pong);
        return;
      case "optins":
        this.#onReply(null);
        return;
      case "error":
        this.#onReply(frame.error ?? "gnotif server refused the opt-ins");
        return;
      case "notification": {
        const { type, ...fields } = frame;
        this.#deliver(browserNotification(fields, this.#scope(), "live"));
        return;
      }
      case void 0:
        return;
    }
  }
  // register() without a scope option scopes the worker to its URL's directory.
  #scope() {
    return new URL("./", new URL(this.#serviceWorker, location.href)).href;
  }
  /** @param data a message the service worker posted to this page */
  #onRelay(data) {
    const fields = parseRelay(data);
    if (fields === void 0) {
      return;
    }
    const n = browserNotification(fields, this.#scope(), "push");
    if (this.#optins?.some((o) => o.trigger === n.trigger && o.value === n.value) === true) {
      this.#deliver(n);
    }
  }
  // #deliver emits n unless its id was among the last DELIVERED_MAX delivered.
  #deliver(n) {
    if (this.#delivered.has(n.id)) {
      return;
    }
    this.#delivered.add(n.id);
    if (this.#delivered.size > DELIVERED_MAX) {
      for (const oldest of this.#delivered) {
        this.#delivered.delete(oldest);
        break;
      }
    }
    this.#emit("notification", n);
  }
  /** @param err the server's refusal, null when it accepted */
  #onReply(err) {
    this.#inFlight = false;
    const settled = this.#waiters.filter((w) => w.gen <= this.#sentGen);
    this.#waiters = this.#waiters.filter((w) => w.gen > this.#sentGen);
    if (err === null) {
      this.#attempt = 0;
      const connecting = this.#connecting;
      this.#connecting = null;
      connecting?.resolve();
      if (this.#reconnecting) {
        this.#reconnecting = false;
        this.#emit("reconnect", void 0);
      }
      for (const w of settled) {
        w.resolve();
      }
    } else {
      const e = new GnotifError("server", err);
      if (this.#connecting !== null || this.#reconnecting) {
        this.#fail(e);
        return;
      }
      for (const w of settled) {
        w.reject(e);
      }
      if (settled.length === 0) {
        this.#emit("error", e);
      }
    }
    if (this.#dirty) {
      this.#send();
    }
  }
  /** @param code the close code, when the socket reported one */
  #onClose(code) {
    this.#ws = null;
    this.#inFlight = false;
    clearInterval(this.#ping);
    clearTimeout(this.#pong);
    if (code === 1009 || code === 1003) {
      this.#fail(new GnotifError("server", `The server closed the live connection with code ${code}.`));
      return;
    }
    if (this.#connecting !== null) {
      this.#stop(new GnotifError("network", "The live connection closed before the server answered."));
      return;
    }
    if (!this.#reconnecting) {
      this.#reconnecting = true;
      this.#emit("reconnecting", void 0);
    }
    const delay = Math.min(BACKOFF_MAX, BACKOFF_MIN * 2 ** this.#attempt) * (0.5 + Math.random() / 2);
    this.#attempt++;
    this.#retry = setTimeout(() => this.#open(), delay);
  }
  #emit(event, arg) {
    for (const handler of Array.from(this.#handlers[event])) {
      try {
        handler(arg);
      } catch (err) {
        console.error(err);
      }
    }
  }
  // getRegistration resolves undefined when nothing is registered, where
  // serviceWorker.ready would never settle.
  async #find() {
    if (!("PushManager" in globalThis)) {
      return null;
    }
    const reg = await navigator.serviceWorker?.getRegistration();
    return await reg?.pushManager.getSubscription() ?? null;
  }
  async #subscription() {
    const sub = await this.#find();
    if (sub === null) {
      throw new GnotifError("inactive", "Notifications are not enabled in this browser.");
    }
    return sub;
  }
  /**
   * @param body sent as JSON
   * @returns the decoded JSON answer, null on 204
   */
  async #request(method, path, body) {
    const init = { method };
    if (body !== void 0) {
      init.headers = { "Content-Type": "application/json" };
      init.body = JSON.stringify(body);
    }
    const res = await fetch(this.#server + path, init);
    if (!res.ok) {
      let message = `gnotif server answered ${res.status}`;
      try {
        message = parseErrorMessage(await res.json()) ?? message;
      } catch {
      }
      throw new GnotifError("server", message, res.status);
    }
    if (res.status === 204) {
      return null;
    }
    try {
      return await res.json();
    } catch {
      throw new GnotifError("server", `gnotif server answered ${res.status} with a body that is not JSON`);
    }
  }
};
export {
  Gnotif,
  GnotifError,
  base64UrlToBytes,
  sameKey
};
