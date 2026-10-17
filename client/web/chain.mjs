// A gno node over JSON-RPC: queries, accounts, simulation and broadcast. Transactions
// arrive signed, as base64 amino binary; this module only carries them.

import { fromBase64, toBase64 } from "./encoding.mjs";

// ChainError's type says how far a request got: "network" when no usable answer came
// back, "rejected" when the node refused a transaction before running it, "failed"
// when a transaction or query ran and failed. reason is the chain's own words.
export class ChainError extends Error {
  constructor(type, reason) {
    super(reason);
    this.name = "ChainError";
    this.type = type;
    this.reason = reason;
  }
}

export function createChain({ rpc, fetch = globalThis.fetch.bind(globalThis) }) {
  async function call(method, params) {
    let answer;
    try {
      const response = await fetch(rpc, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      });
      if (!response.ok) throw new Error(`the node answered ${response.status}`);
      answer = await response.json();
    } catch (err) {
      throw new ChainError("network", err instanceof Error ? err.message : String(err));
    }
    if (answer.error !== undefined) throw new ChainError("rejected", answer.error.data ?? answer.error.message);
    return answer.result;
  }

  // abci runs a query whose data is already base64 and returns its response, or null
  // when the chain answers with the error type `missing`.
  async function abci(path, data, missing) {
    const response = (await call("abci_query", { path, data })).response;
    const base = response.ResponseBase;
    if (base.Error !== null && base.Error["@type"] === missing) return null;
    if (base.Error !== null) throw new ChainError("failed", reasonOf(base.Error, base.Log));
    return response;
  }
  const query = async (path, text = "") => decodeText((await abci(path, toBase64(new TextEncoder().encode(text)))).ResponseBase.Data);

  return {
    // evalJSON returns the typed values of a read-only call such as `pkg.F("1")`.
    evalJSON: async (expr) => JSON.parse(await query("vm/qeval_json", expr)).results,
    typeJSON: async (typeID) => JSON.parse(await query("vm/qtype_json", typeID)),

    // account returns {accountNumber, sequence, coins}, or null for an address the chain
    // has never seen.
    async account(address) {
      const text = await query(`auth/accounts/${address}`);
      if (text === null || text === "null") return null;
      const { BaseAccount: a } = JSON.parse(text);
      return { accountNumber: Number(a.account_number), sequence: Number(a.sequence), coins: a.coins };
    },

    // sessions lists the sessions master has created, as sessionOf describes them.
    async sessions(master) {
      const text = await query(`auth/accounts/${master}/sessions`);
      return text === null || text === "null" ? [] : JSON.parse(text).map(sessionOf);
    },

    // sessionAccount returns one session of master, or null when the chain has none.
    async sessionAccount(master, session) {
      const response = await abci(`auth/accounts/${master}/session/${session}`, "", "/std.SessionNotFoundError");
      return response === null ? null : sessionOf(JSON.parse(decodeText(response.ResponseBase.Data)));
    },

    // gasPrice is what the last block charged: amount of denom per gas units.
    async gasPrice() {
      const { gas, price } = JSON.parse(await query("auth/gasprice"));
      const [, amount, denom] = /^(\d+)(.+)$/.exec(price);
      return { gas: Number(gas), amount: Number(amount), denom };
    },

    // simulate runs a signed transaction without committing it and returns the gas it used.
    async simulate(tx) {
      const result = readResult(fromBase64((await abci(".app/simulate", tx)).Value));
      if (result.error !== null) throw new ChainError("failed", reasonOf(result.error, result.log));
      return result.gasUsed;
    },

    // broadcast sends a signed transaction and waits for its block. A wait that times
    // out is a network error: the transaction passed CheckTx and may still land. storage
    // is the bytes the transaction locked in realm storage, negative when it freed more.
    async broadcast(tx) {
      let result;
      try {
        result = await call("broadcast_tx_commit", { tx });
      } catch (err) {
        if (err.type === "rejected" && err.reason === "request timeout") throw new ChainError("network", err.reason);
        throw err;
      }
      for (const [phase, type] of [[result.check_tx, "rejected"], [result.deliver_tx, "failed"]]) {
        const base = phase.ResponseBase;
        if (base.Error !== null) throw new ChainError(type, reasonOf(base.Error, base.Log));
      }
      const storage = (result.deliver_tx.ResponseBase.Events ?? [])
        .filter((e) => e["@type"] === "/tm.StorageDepositEvent" || e["@type"] === "/tm.StorageUnlockEvent")
        .reduce((bytes, e) => bytes + Number(e.bytes_delta), 0);
      return { hash: result.hash, height: Number(result.height), gasUsed: Number(result.deliver_tx.GasUsed), storage };
    },
  };
}

// provisionalGas bounds the simulation itself.
const provisionalGas = 100_000_000;

// payFor signs a transaction for what it costs. sign(fee) resolves to the transaction
// signed with fee {gasWanted, gasFee}. payFor simulates it under a fee of one unit,
// which a simulation never checks against the gas price but a session's allowance must
// cover, then signs it again for gasWantedFor the gas used, at the chain's price.
export async function payFor(chain, sign) {
  const price = await chain.gasPrice();
  const used = await chain.simulate(await sign({ gasWanted: provisionalGas, gasFee: `1${price.denom}` }));
  const gasWanted = gasWantedFor(used);
  return sign({ gasWanted, gasFee: `${feeFor(gasWanted, price)}${price.denom}` });
}

// gasWantedFor is the gas a transaction asks for: the gas its simulation used, plus a fifth
// and 100,000.
export function gasWantedFor(used) {
  return Math.ceil(used * 1.2) + 100_000;
}

// feeFor is the fee, in price's denomination, for gasWanted gas at price.
export function feeFor(gasWanted, price) {
  return Math.ceil((gasWanted * price.amount) / price.gas);
}

// sessionOf reads a session account: the account number and sequence its key signs
// with, its expiry in Unix seconds (0 for none), and its spend limit and spending so far
// in ugnot.
function sessionOf({ BaseSessionAccount: s, allow_paths: allowPaths }) {
  return {
    address: s.BaseAccount.address,
    accountNumber: Number(s.BaseAccount.account_number),
    sequence: Number(s.BaseAccount.sequence),
    expiresAt: Number(s.expires_at ?? 0),
    spendLimit: ugnot(s.spend_limit),
    spendUsed: ugnot(s.spend_used),
    allowPaths: allowPaths ?? [],
  };
}

// ugnot reads the ugnot amount of a coins string such as "939500ugnot"; none is 0.
function ugnot(coins) {
  const found = /(\d+)ugnot\b/.exec(coins ?? "");
  return found === null ? 0 : Number(found[1]);
}

// reasonOf finds the readable reason of a chain error: a realm's panic text, or the
// message of the error's first trace line.
function reasonOf(error, log) {
  if (typeof error.value === "string") return error.value;
  const trace = /Msg Traces:\n\s*0\s+\S+ - (.*)/.exec(log ?? "");
  if (trace !== null) return trace[1].replace(/^VM panic: /, "");
  return error["@type"] ?? "unknown error";
}

// readResult reads the fields of an amino-encoded sdk.Result that simulate needs: its
// ResponseBase (field 1) holds Error (1, an Any) and Log (4); GasUsed is field 3.
function readResult(bytes) {
  const out = { error: null, log: "", gasUsed: 0 };
  for (const [field, value] of fields(bytes)) {
    if (field === 3) out.gasUsed = Number(value >> 1n); // amino writes int64 zigzag; gas is never negative
    if (field !== 1) continue;
    for (const [inner, innerValue] of fields(value)) {
      if (inner === 1) out.error = anyError(innerValue);
      if (inner === 4) out.log = new TextDecoder().decode(innerValue);
    }
  }
  return out;
}

// anyError reads an error Any: its type URL, and the message of a StringError.
function anyError(bytes) {
  const error = {};
  for (const [field, value] of fields(bytes)) {
    if (field === 1) error["@type"] = new TextDecoder().decode(value);
    if (field === 2 && error["@type"] === "/abci.StringError") {
      for (const [inner, text] of fields(value)) if (inner === 1) error.value = new TextDecoder().decode(text);
    }
  }
  return error;
}

// fields walks protobuf wire format, yielding [field, value]: a BigInt for a varint, the
// bytes for a length-delimited field.
function* fields(bytes) {
  let at = 0;
  const varint = () => {
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

function decodeText(base64) {
  return base64 === null ? null : new TextDecoder().decode(fromBase64(base64));
}

