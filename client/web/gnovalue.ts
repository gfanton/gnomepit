// Turns vm/qeval_json answers into plain values. An answer is amino JSON of gno typed
// values: struct fields come by index, and vm/qtype_json gives their names.

import * as v from "valibot";

import type { Chain } from "./chain.ts";
import { fromBase64 } from "./encoding.ts";

const stringKind = "16";
const boolKind = "4";
// int and int64, whose value fills all 8 bytes of N; narrower kinds fill only their
// low bytes, so they throw rather than decode wrong.
const intKinds = new Set(["32", "1024"]);

// A typed value: its type T, and its value V or a primitive's bytes N, each absent for
// a zero value.
const TypedValueSchema = v.object({ T: v.unknown(), V: v.optional(v.unknown()), N: v.optional(v.string()) });
const PrimitiveTypeSchema = v.object({ "@type": v.literal("/gno.PrimitiveType"), value: v.string() });
const SliceTypeSchema = v.object({ "@type": v.literal("/gno.SliceType") });
const RefTypeSchema = v.object({ "@type": v.literal("/gno.RefType"), ID: v.string() });
const RefValueSchema = v.object({ "@type": v.literal("/gno.RefValue") });
const StructValueSchema = v.object({ "@type": v.literal("/gno.StructValue"), Fields: v.array(v.unknown()) });
const StringValueSchema = v.object({ value: v.string() });
const SliceValueSchema = v.object({ Base: v.optional(v.unknown()), Offset: v.string(), Length: v.string() });
// A byte slice keeps its elements in Data, not List.
const ListValueSchema = v.object({ List: v.array(v.unknown()) });
const StructNodeSchema = v.object({ T: RefTypeSchema, V: StructValueSchema });
const EmbeddedSchema = v.object({ T: RefTypeSchema });
const DeclaredStructSchema = v.object({
  "@type": v.literal("/gno.DeclaredType"),
  PkgPath: v.string(),
  Name: v.string(),
  Base: v.object({ "@type": v.literal("/gno.StructType"), Fields: v.array(v.object({ Name: v.string() })) }),
});
const KindSchema = v.object({ "@type": v.string() });

type FieldNames = ReadonlyMap<string, readonly string[]>;

// createReader returns read(expr), which runs expr on chain and decodes its first
// result, asking for each struct type's field names only once.
export function createReader(chain: Pick<Chain, "evalJSON" | "typeJSON">): (expr: string) => Promise<unknown> {
  const fields = new Map<string, string[]>();
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
export function typeFields(answer: unknown): Map<string, string[]> {
  const out = new Map<string, string[]>();
  walk(answer, (node) => {
    if (v.is(DeclaredStructSchema, node)) {
      out.set(
        `${node.PkgPath}.${node.Name}`,
        node.Base.Fields.map((f) => f.Name),
      );
    }
  });
  return out;
}

// structTypes lists the struct type ids inside a typed value, so their fields can be
// fetched before decoding it.
export function structTypes(typedValue: unknown): Set<string> {
  const out = new Set<string>();
  walk(typedValue, (node) => {
    if (v.is(StructNodeSchema, node)) out.add(node.T.ID);
  });
  return out;
}

// decode returns typedValue as a plain value; fields maps struct type ids to field names,
// as typeFields builds it. A field named after its own struct type is embedded, so its
// fields merge into the parent. A value the query left in storage throws.
export function decode(typedValue: unknown, fields: FieldNames): unknown {
  if (!v.is(TypedValueSchema, typedValue)) throw new Error("a query result holds a value without its type");
  const { T: type, V: value } = typedValue;
  if (v.is(RefValueSchema, value)) throw new Error("object reference in a query result");
  if (v.is(PrimitiveTypeSchema, type)) return primitive(type.value, typedValue);
  if (v.is(SliceTypeSchema, type))
    return value === undefined ? [] : sliceItems(value).map((item) => decode(item, fields));
  if (v.is(RefTypeSchema, type) && v.is(StructValueSchema, value)) return struct(type.ID, value, fields);
  throw new Error(`unsupported value of type ${v.is(KindSchema, type) ? type["@type"] : "unknown"}`);
}

function struct(
  id: string,
  value: v.InferOutput<typeof StructValueSchema>,
  fields: FieldNames,
): Record<string, unknown> {
  const names = fields.get(id);
  if (names === undefined) throw new Error(`no fields known for ${id}`);
  if (names.length !== value.Fields.length)
    throw new Error(`${id} has ${value.Fields.length} fields, not ${names.length}`);
  const out: Record<string, unknown> = {};
  names.forEach((name, i) => {
    const field = value.Fields[i];
    const decoded = decode(field, fields);
    if (v.is(EmbeddedSchema, field) && field.T.ID.endsWith(`.${name}`)) Object.assign(out, decoded);
    else out[name] = decoded;
  });
  return out;
}

function sliceItems(value: unknown): unknown[] {
  if (!v.is(SliceValueSchema, value)) throw new Error("unsupported slice value");
  const base = value.Base;
  if (v.is(RefValueSchema, base)) throw new Error("object reference in a query result");
  if (!v.is(ListValueSchema, base)) throw new Error("unsupported byte slice");
  const offset = Number(value.Offset);
  return base.List.slice(offset, offset + Number(value.Length));
}

function primitive(kind: string, { N, V }: v.InferOutput<typeof TypedValueSchema>): string | boolean | number {
  if (kind === stringKind) return v.is(StringValueSchema, V) ? V.value : "";
  if (kind === boolKind) return N !== undefined && fromBase64(N)[0] !== 0;
  if (intKinds.has(kind)) {
    if (N === undefined) return 0;
    return Number(new DataView(fromBase64(N).buffer).getBigInt64(0, true));
  }
  throw new Error(`unsupported primitive type ${kind}`);
}

// walk calls visit on every object inside node, node included.
function walk(node: unknown, visit: (node: object) => void): void {
  if (node === null || typeof node !== "object") return;
  if (!Array.isArray(node)) visit(node);
  for (const child of Object.values(node)) walk(child, visit);
}
