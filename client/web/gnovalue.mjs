// Turns vm/qeval_json answers into plain values. An answer is amino JSON of gno typed
// values: struct fields come by index, and vm/qtype_json gives their names.

import { fromBase64 } from "./encoding.mjs";

const stringKind = "16";
const boolKind = "4";
// int and int64, whose value fills all 8 bytes of N; narrower kinds fill only their
// low bytes, so they throw rather than decode wrong.
const intKinds = new Set(["32", "1024"]);

// createReader returns read(expr), which runs expr on chain, a chain.mjs client, and
// decodes its first result, asking for each struct type's field names only once.
export function createReader(chain) {
  const fields = new Map();
  return async (expr) => {
    const [result] = await chain.evalJSON(expr);
    for (const id of structTypes(result)) {
      if (!fields.has(id)) for (const [type, names] of typeFields(await chain.typeJSON(id))) fields.set(type, names);
    }
    return decode(result, fields);
  };
}

// typeFields maps every struct type a vm/qtype_json answer declares, at any depth, to its
// field names in order.
export function typeFields(answer) {
  const out = new Map();
  walk(answer.type, (node) => {
    if (node["@type"] === "/gno.DeclaredType" && node.Base?.["@type"] === "/gno.StructType") {
      out.set(`${node.PkgPath}.${node.Name}`, node.Base.Fields.map((f) => f.Name));
    }
  });
  return out;
}

// structTypes lists the struct type ids inside a typed value, so their fields can be
// fetched before decoding it.
export function structTypes(typedValue) {
  const out = new Set();
  walk(typedValue, (node) => {
    if (node.T?.["@type"] === "/gno.RefType" && node.V?.["@type"] === "/gno.StructValue") out.add(node.T.ID);
  });
  return out;
}

// decode returns typedValue as a plain value; fields maps struct type ids to field names,
// as typeFields builds it. A field named after its own struct type is embedded, so its
// fields merge into the parent. A value the query left in storage throws.
export function decode(typedValue, fields) {
  const { T: type, V: value } = typedValue;
  if (value?.["@type"] === "/gno.RefValue") throw new Error("object reference in a query result");
  switch (type["@type"]) {
    case "/gno.PrimitiveType":
      return primitive(type.value, typedValue);
    case "/gno.SliceType":
      return value === undefined ? [] : sliceItems(value).map((item) => decode(item, fields));
    case "/gno.RefType":
      if (value?.["@type"] === "/gno.StructValue") return struct(type.ID, value, fields);
  }
  throw new Error(`unsupported value of type ${type["@type"]}`);
}

function struct(id, value, fields) {
  const names = fields.get(id);
  if (names === undefined) throw new Error(`no fields known for ${id}`);
  if (names.length !== value.Fields.length) throw new Error(`${id} has ${value.Fields.length} fields, not ${names.length}`);
  const out = {};
  value.Fields.forEach((field, i) => {
    const decoded = decode(field, fields);
    if (field.T["@type"] === "/gno.RefType" && field.T.ID.endsWith(`.${names[i]}`)) Object.assign(out, decoded);
    else out[names[i]] = decoded;
  });
  return out;
}

function sliceItems(value) {
  const base = value.Base;
  if (base?.["@type"] === "/gno.RefValue") throw new Error("object reference in a query result");
  // A byte slice keeps its elements in Data, not List.
  if (!Array.isArray(base?.List)) throw new Error("unsupported byte slice");
  const offset = Number(value.Offset);
  return base.List.slice(offset, offset + Number(value.Length));
}

function primitive(kind, { N, V }) {
  if (kind === stringKind) return V?.value ?? "";
  if (kind === boolKind) return N !== undefined && fromBase64(N)[0] !== 0;
  if (intKinds.has(kind)) {
    if (N === undefined) return 0;
    return Number(new DataView(fromBase64(N).buffer).getBigInt64(0, true));
  }
  throw new Error(`unsupported primitive type ${kind}`);
}


// walk calls visit on every object inside node, node included.
function walk(node, visit) {
  if (node === null || typeof node !== "object") return;
  if (!Array.isArray(node)) visit(node);
  for (const child of Object.values(node)) walk(child, visit);
}
