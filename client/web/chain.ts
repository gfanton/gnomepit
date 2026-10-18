// A gno node over JSON-RPC: queries, accounts, simulation and broadcast. Transactions
// arrive signed, as base64 amino binary; this module only carries them.

import * as v from "valibot";

import { fromBase64, toBase64 } from "./encoding.ts";
import { type Address, address } from "./ids.ts";

// ChainError's type says how far a request got: "network" when no usable answer came
// back, "rejected" when the node refused a transaction before running it, "failed"
// when a transaction or query ran and failed. reason is the chain's own words, or what
// made its answer unusable.
export class ChainError extends Error {
  type: "network" | "rejected" | "failed";
  reason: string;

  constructor(type: ChainError["type"], reason: string) {
    super(reason);
    this.name = "ChainError";
    this.type = type;
    this.reason = reason;
  }
}

const AddressSchema = v.pipe(v.string(), v.transform(address));

const AnswerSchema = v.object({
  result: v.optional(v.unknown()),
  error: v.optional(v.object({ message: v.string(), data: v.nullish(v.string()) })),
});

// A chain error in amino JSON: its type URL and, for a StringError, the message.
const ErrorSchema = v.object({ "@type": v.optional(v.string()), value: v.optional(v.unknown()) });

const ResponseBaseSchema = v.object({
  Error: v.nullable(ErrorSchema),
  Data: v.nullable(v.string()),
  Log: v.nullish(v.string(), ""),
});

const AbciSchema = v.object({
  response: v.object({ ResponseBase: ResponseBaseSchema, Value: v.nullish(v.string()) }),
});

const BroadcastSchema = v.object({
  check_tx: v.object({ ResponseBase: ResponseBaseSchema }),
  deliver_tx: v.object({
    ResponseBase: v.object({ ...ResponseBaseSchema.entries, Events: v.nullish(v.array(v.unknown())) }),
    GasUsed: v.string(),
  }),
  hash: v.string(),
  height: v.string(),
});

const StorageKindSchema = v.object({ "@type": v.picklist(["/tm.StorageDepositEvent", "/tm.StorageUnlockEvent"]) });
const StorageEventSchema = v.object({
  ...StorageKindSchema.entries,
  bytes_delta: v.pipe(v.string(), v.regex(/^-?\d+$/)),
});

const EvalSchema = v.object({ results: v.array(v.unknown()) });

const AccountSchema = v.pipe(
  v.object({ BaseAccount: v.object({ account_number: v.string(), sequence: v.string(), coins: v.string() }) }),
  v.transform(({ BaseAccount: a }) => ({
    accountNumber: Number(a.account_number),
    sequence: Number(a.sequence),
    coins: a.coins,
  })),
);

// A session account: the account number and sequence its key signs with, its expiry in
// Unix seconds (0 for none), and its spend limit and spending so far in ugnot.
const SessionSchema = v.pipe(
  v.object({
    BaseSessionAccount: v.object({
      BaseAccount: v.object({ address: AddressSchema, account_number: v.string(), sequence: v.string() }),
      expires_at: v.nullish(v.string()),
      spend_limit: v.nullish(v.string()),
      spend_used: v.nullish(v.string()),
    }),
    allow_paths: v.nullish(v.array(v.string())),
  }),
  v.transform(({ BaseSessionAccount: s, allow_paths: allowPaths }) => ({
    address: s.BaseAccount.address,
    accountNumber: Number(s.BaseAccount.account_number),
    sequence: Number(s.BaseAccount.sequence),
    expiresAt: Number(s.expires_at ?? 0),
    spendLimit: ugnot(s.spend_limit),
    spendUsed: ugnot(s.spend_used),
    allowPaths: allowPaths ?? [],
  })),
);

// The chain writes a price as its amount and denomination, such as "1ugnot".
const GasPriceSchema = v.pipe(
  v.object({ gas: v.string(), price: v.pipe(v.string(), v.regex(/^\d+\D/)) }),
  v.transform(({ gas, price }) => ({
    gas: Number(gas),
    amount: parseInt(price, 10),
    denom: price.replace(/^\d+/, ""),
  })),
);

export type Account = v.InferOutput<typeof AccountSchema>;
export type Session = v.InferOutput<typeof SessionSchema>;
export type GasPrice = v.InferOutput<typeof GasPriceSchema>;
export type Broadcast = { hash: string; height: number; gasUsed: number; storage: number };
export type Fee = { gasWanted: number; gasFee: string };

type AbciResponse = v.InferOutput<typeof AbciSchema>["response"];
type ChainFailure = v.InferOutput<typeof ErrorSchema>;
type SimulationResult = { error: ChainFailure | null; log: string; gasUsed: number };

export type Chain = {
  // evalJSON returns the typed values of a read-only call such as `pkg.F("1")`.
  evalJSON(expr: string): Promise<unknown[]>;
  typeJSON(id: string): Promise<unknown>;
  // account returns null for an address the chain has never seen.
  account(a: Address): Promise<Account | null>;
  // sessions lists the sessions master has created.
  sessions(master: Address): Promise<Session[]>;
  // sessionAccount returns one session of master, or null when the chain has none.
  sessionAccount(master: Address, session: Address): Promise<Session | null>;
  // gasPrice is what the last block charged: amount of denom per gas units.
  gasPrice(): Promise<GasPrice>;
  // simulate runs a signed transaction without committing it and returns the gas it used.
  simulate(tx: string): Promise<number>;
  // broadcast sends a signed transaction and waits for its block. A wait that times
  // out is a network error: the transaction passed CheckTx and may still land. storage
  // is the bytes the transaction locked in realm storage, negative when it freed more.
  broadcast(tx: string): Promise<Broadcast>;
};

// The part of fetch a client of a JSON API calls.
export type Fetch = (
  url: string,
  init: { method: "POST"; headers: Record<string, string>; body: string },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export function createChain({ rpc, fetch = globalThis.fetch.bind(globalThis) }: { rpc: string; fetch?: Fetch }): Chain {
  async function call(method: string, params: Record<string, string>): Promise<unknown> {
    let answer: unknown;
    try {
      const response = await fetch(rpc, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      });
      if (!response.ok) throw new Error(`the node answered ${response.status}`);
      answer = await response.json();
    } catch (err) {
      throw new ChainError("network", messageOf(err));
    }
    const { result, error } = readAnswer(method, AnswerSchema, answer);
    if (error !== undefined) throw new ChainError("rejected", error.data ?? error.message);
    return result;
  }

  // abci runs a query whose data is already base64 and returns its response, or null
  // when the chain answers with the error type `missing`.
  function abci(path: string, data: string): Promise<AbciResponse>;
  function abci(path: string, data: string, missing: string): Promise<AbciResponse | null>;
  async function abci(path: string, data: string, missing?: string): Promise<AbciResponse | null> {
    const { response } = readAnswer(path, AbciSchema, await call("abci_query", { path, data }));
    const base = response.ResponseBase;
    if (base.Error !== null && missing !== undefined && base.Error["@type"] === missing) return null;
    if (base.Error !== null) throw new ChainError("failed", reasonOf(base.Error, base.Log));
    return response;
  }
  // query runs a query with text as its data and returns the base64 data it answers.
  const query = async (path: string, text = ""): Promise<string | null> =>
    (await abci(path, toBase64(new TextEncoder().encode(text)))).ResponseBase.Data;

  return {
    evalJSON: async (expr) => readJSON("vm/qeval_json", EvalSchema, await query("vm/qeval_json", expr)).results,
    typeJSON: async (id) => readJSON("vm/qtype_json", v.nonNullable(v.unknown()), await query("vm/qtype_json", id)),

    async account(a) {
      const path = `auth/accounts/${a}`;
      return readJSON(path, v.nullable(AccountSchema), await query(path));
    },

    async sessions(master) {
      const path = `auth/accounts/${master}/sessions`;
      return readJSON(path, v.nullable(v.array(SessionSchema)), await query(path)) ?? [];
    },

    async sessionAccount(master, session) {
      const path = `auth/accounts/${master}/session/${session}`;
      const response = await abci(path, "", "/std.SessionNotFoundError");
      return response === null ? null : readJSON(path, SessionSchema, response.ResponseBase.Data);
    },

    gasPrice: async () => readJSON("auth/gasprice", GasPriceSchema, await query("auth/gasprice")),

    async simulate(tx) {
      const { Value: value } = await abci(".app/simulate", tx);
      const encoded = readAnswer(".app/simulate", v.string(), value);
      let result: SimulationResult;
      try {
        result = readResult(fromBase64(encoded));
      } catch (err) {
        throw unexpectedAnswer(".app/simulate", messageOf(err));
      }
      if (result.error !== null) throw new ChainError("failed", reasonOf(result.error, result.log));
      return result.gasUsed;
    },

    async broadcast(tx) {
      let answer: unknown;
      try {
        answer = await call("broadcast_tx_commit", { tx });
      } catch (err) {
        if (err instanceof ChainError && err.type === "rejected" && err.reason === "request timeout")
          throw new ChainError("network", err.reason);
        throw err;
      }
      const result = readAnswer("broadcast_tx_commit", BroadcastSchema, answer);
      for (const [phase, type] of [
        [result.check_tx, "rejected"],
        [result.deliver_tx, "failed"],
      ] as const) {
        const base = phase.ResponseBase;
        if (base.Error !== null) throw new ChainError(type, reasonOf(base.Error, base.Log));
      }
      const storage = (result.deliver_tx.ResponseBase.Events ?? [])
        .filter((e) => v.is(StorageKindSchema, e))
        .map((e) => readAnswer("broadcast_tx_commit", StorageEventSchema, e))
        .reduce((bytes, e) => bytes + Number(e.bytes_delta), 0);
      return { hash: result.hash, height: Number(result.height), gasUsed: Number(result.deliver_tx.GasUsed), storage };
    },
  };
}

// readAnswer checks what the node answered to `what` against schema; an answer it refuses
// is a network error, since no usable answer came back.
function readAnswer<T>(what: string, schema: v.GenericSchema<unknown, T>, answer: unknown): T {
  const parsed = v.safeParse(schema, answer);
  if (!parsed.success) throw unexpectedAnswer(what, v.summarize(parsed.issues));
  return parsed.output;
}

// readJSON is readAnswer for a query's data, base64 of JSON text; no data reads as JSON null.
function readJSON<T>(what: string, schema: v.GenericSchema<unknown, T>, data: string | null): T {
  let answer: unknown = null;
  try {
    if (data !== null) answer = JSON.parse(new TextDecoder().decode(fromBase64(data)));
  } catch (err) {
    throw unexpectedAnswer(what, messageOf(err));
  }
  return readAnswer(what, schema, answer);
}

function unexpectedAnswer(what: string, detail: string): ChainError {
  return new ChainError("network", `unexpected answer to ${what}: ${detail}`);
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// provisionalGas bounds the simulation itself.
const provisionalGas = 100_000_000;

// payFor signs a transaction for what it costs. sign(fee) resolves to the transaction
// signed with fee {gasWanted, gasFee}. payFor simulates it under a fee of one unit,
// which a simulation never checks against the gas price but a session's allowance must
// cover, then signs it again for gasWantedFor the gas used, at the chain's price.
export async function payFor(
  chain: Pick<Chain, "gasPrice" | "simulate">,
  sign: (fee: Fee) => Promise<string>,
): Promise<string> {
  const price = await chain.gasPrice();
  const used = await chain.simulate(await sign({ gasWanted: provisionalGas, gasFee: `1${price.denom}` }));
  const gasWanted = gasWantedFor(used);
  return sign({ gasWanted, gasFee: `${feeFor(gasWanted, price)}${price.denom}` });
}

// gasWantedFor is the gas a transaction asks for: the gas its simulation used, plus a fifth
// and 100,000.
export function gasWantedFor(used: number): number {
  return Math.ceil(used * 1.2) + 100_000;
}

// feeFor is the fee, in price's denomination, for gasWanted gas at price.
export function feeFor(gasWanted: number, price: GasPrice): number {
  return Math.ceil((gasWanted * price.amount) / price.gas);
}

// ugnot reads the ugnot amount of a coins string such as "939500ugnot"; none is 0.
function ugnot(coins: string | null | undefined): number {
  const found = /(\d+)ugnot\b/.exec(coins ?? "");
  return found === null ? 0 : Number(found[1]);
}

// reasonOf finds the readable reason of a chain error: a realm's panic text, or the
// message of the error's first trace line.
function reasonOf(error: ChainFailure, log: string): string {
  if (typeof error.value === "string") return error.value;
  const trace = /Msg Traces:\n\s*0\s+\S+ - (.*)/.exec(log)?.[1];
  if (trace !== undefined) return trace.replace(/^VM panic: /, "");
  return error["@type"] ?? "unknown error";
}

// readResult reads the fields of an amino-encoded sdk.Result that simulate needs: its
// ResponseBase (field 1) holds Error (1, an Any) and Log (4); GasUsed is field 3.
function readResult(bytes: Uint8Array): SimulationResult {
  const out: SimulationResult = { error: null, log: "", gasUsed: 0 };
  for (const [field, value] of fields(bytes)) {
    if (field === 3) out.gasUsed = Number(varintOf(value) >> 1n); // amino writes int64 zigzag; gas is never negative
    if (field !== 1) continue;
    for (const [inner, innerValue] of fields(bytesOf(value))) {
      if (inner === 1) out.error = anyError(bytesOf(innerValue));
      if (inner === 4) out.log = new TextDecoder().decode(bytesOf(innerValue));
    }
  }
  return out;
}

// anyError reads an error Any: its type URL, and the message of a StringError.
function anyError(bytes: Uint8Array): ChainFailure {
  const error: ChainFailure = {};
  for (const [field, value] of fields(bytes)) {
    if (field === 1) error["@type"] = new TextDecoder().decode(bytesOf(value));
    if (field === 2 && error["@type"] === "/abci.StringError") {
      for (const [inner, text] of fields(bytesOf(value)))
        if (inner === 1) error.value = new TextDecoder().decode(bytesOf(text));
    }
  }
  return error;
}

// fields walks protobuf wire format, yielding [field, value]: a BigInt for a varint, the
// bytes for a length-delimited field.
function* fields(bytes: Uint8Array): Generator<[number, bigint | Uint8Array]> {
  let at = 0;
  const varint = (): bigint => {
    let value = 0n;
    for (let shift = 0n; ; shift += 7n) {
      const b = bytes[at++];
      if (b === undefined) throw new Error("truncated simulation result");
      value |= BigInt(b & 0x7f) << shift;
      if (b < 0x80) return value;
    }
  };
  while (at < bytes.length) {
    const key = Number(varint());
    const field = key >> 3;
    switch (key & 7) {
      case 0:
        yield [field, varint()];
        break;
      case 2: {
        const length = Number(varint());
        yield [field, bytes.subarray(at, at + length)];
        at += length;
        break;
      }
      case 1:
        at += 8;
        break;
      case 5:
        at += 4;
        break;
      default:
        throw new Error(`unsupported wire type in simulation result`);
    }
  }
}

// varintOf and bytesOf take a field's value as the wire type its field number carries.
function varintOf(value: bigint | Uint8Array): bigint {
  if (typeof value === "bigint") return value;
  throw new Error("unexpected wire type in simulation result");
}

function bytesOf(value: bigint | Uint8Array): Uint8Array {
  if (value instanceof Uint8Array) return value;
  throw new Error("unexpected wire type in simulation result");
}
