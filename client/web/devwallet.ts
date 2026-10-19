// A wallet for local play and scripted tests: it holds a dev key in the page and
// answers the Adena calls the arena makes, in Adena's response shapes. make dev funds
// every dev account on gnodev. The keys are public, so the dev wallet is for local chains
// only.

import { type Broadcast, type Chain, messageOf, payFor } from "./chain.ts";
import { toBase64 } from "./encoding.ts";
import { type Address, address } from "./ids.ts";
import type { Signer } from "./signer.ts";
import type { TxRequest, Wallet } from "./wallet.ts";

// Each key is the sha256 of "gnomehall dev <name>".
export const devAccounts = {
  alice: {
    key: "a53530163a6b35ac3d1423d7c0292a4067eb63310aa80e9d14aaa3919a7f21e6",
    address: address("g1vzpn5tdhat0vy90eyqncs09474257tgz2uw09w"),
  },
  bob: {
    key: "f597ba7dafa0e172e8ef9188d0ff39f0b6a2cb2006112bd9e2717544e99b5b8d",
    address: address("g1h3cka3ya6jw3yr64erpklnhvrgh5l4du6w0faw"),
  },
  carol: {
    key: "997f277999014ae2de71bc4965e086719cfd32cd7c41a4b8a29cd41dedea367e",
    address: address("g1x79lhtyj8sef3yyv3pvy20hzmgfst0274k8jx0"),
  },
  dave: {
    key: "efe5c7e83a9070d6608cfadef46559243ecdde6de9ce987a13ebbf3d81b149b6",
    address: address("g1t834akqrqg83csrq98t443larad7vnr6pp3lsd"),
  },
};

// Adena signs a transaction of session messages alone without simulating it, with the
// fee the page names or, without one, these.
const sessionAdmin = new Set(["/auth.m_create_session", "/auth.m_revoke_session", "/auth.m_revoke_all_sessions"]);
const adenaGasWanted = 2_000_000_000;
const adenaGasFee = 100_000; // ugnot
// A gas or fee of 0 or NaN counts as none named.
const orDefault = (named: number | undefined, fallback: number): number =>
  named === undefined || named === 0 || Number.isNaN(named) ? fallback : named;

type Success<T> = { status: "success"; type: string; message: ""; data: T };
type Failure = { status: "failure"; type: string; message: string; data: null };

// The ADR-036 document SignArbitrary signs: one MsgSignData, with no account and no fee.
type SignedDocument = {
  chain_id: string;
  account_number: string;
  sequence: string;
  fee: { amount: never[]; gas: string };
  msgs: { type: string; value: { signer: Address; data: string } }[];
  memo: string;
};
type SignedArbitrary = {
  signed: SignedDocument;
  signature: { pubKey: { typeUrl: string; value: string }; signature: string };
};

export type DevWallet = {
  AddEstablish(name: string): Promise<Success<undefined>>;
  GetNetwork(): Promise<Success<{ chainId: string }>>;
  SwitchNetwork(id: string): Promise<Success<undefined> | Failure>;
  GetAccount(): Promise<Success<{ address: Address; chainId: string; status: string }>>;
  SignArbitrary(request: { signer: string; data: string }): Promise<Success<SignedArbitrary> | Failure>;
  SignTx(request: TxRequest): Promise<Success<{ encodedTransaction: string }> | Failure>;
  DoContract(request: TxRequest): Promise<Success<Broadcast> | Failure>;
};

// devWallet is the dev account name's wallet on chain, whose chain id is chainId.
export function devWallet({
  name,
  signer,
  chain,
  chainId,
}: {
  name: keyof typeof devAccounts;
  signer: Signer;
  chain: Chain;
  chainId: string;
}): DevWallet {
  const { key, address } = devAccounts[name];
  const success = <T>(data: T, type = "SUCCESS"): Success<T> => ({ status: "success", type, message: "", data });
  const failure = (type: string, message: string): Failure => ({ status: "failure", type, message, data: null });

  async function sign({ messages: msgs, memo = "", gasWanted, gasFee }: TxRequest): Promise<string> {
    const account = await chain.account(address);
    if (account === null) throw new Error(`${address} has no account on the chain`);
    const base = {
      chainId,
      accountNumber: account.accountNumber,
      sequence: account.sequence,
      privKey: key,
      memo,
      msgs,
    };
    if (msgs.every((msg) => sessionAdmin.has(msg.type))) {
      return signer.signTx({
        ...base,
        fee: { gasWanted: orDefault(gasWanted, adenaGasWanted), gasFee: `${orDefault(gasFee, adenaGasFee)}ugnot` },
      });
    }
    return payFor(chain, (fee) => signer.signTx({ ...base, fee }));
  }

  return {
    AddEstablish: async () => success(undefined, "CONNECTION_SUCCESS"),
    GetNetwork: async () => success({ chainId }),
    SwitchNetwork: async (id) => (id === chainId ? success(undefined) : failure("UNADDED_NETWORK", `No network ${id}`)),
    GetAccount: async () => success({ address, chainId, status: "ACTIVE" }),

    // SignArbitrary signs Adena's ADR-036 document for data: a pure function of the
    // chain, the signer and the text, so the same text always gives the same signature.
    async SignArbitrary({ signer: who, data }) {
      if (who !== address) return failure("SIGNER_MISMATCH", "Signer does not match the signing key");
      const signed: SignedDocument = {
        chain_id: chainId,
        account_number: "0",
        sequence: "0",
        fee: { amount: [], gas: "0" },
        msgs: [
          { type: "sign/MsgSignData", value: { signer: address, data: toBase64(new TextEncoder().encode(data)) } },
        ],
        memo: "",
      };
      const bytes = new TextEncoder().encode(sortedJSON(signed));
      const { pubKey } = await signer.keyInfo(key);
      return success({
        signed,
        signature: {
          pubKey: { typeUrl: "/tm.PubKeySecp256k1", value: pubKey },
          signature: await signer.signBytes(key, toBase64(bytes)),
        },
      });
    },

    async SignTx(params) {
      try {
        return success({ encodedTransaction: await sign(params) });
      } catch (err) {
        return failure("SIGNING_FAILED", messageOf(err));
      }
    },

    async DoContract(params) {
      try {
        return success(await chain.broadcast(await sign(params)), "TRANSACTION_SUCCESS");
      } catch (err) {
        return failure("TRANSACTION_FAILED", messageOf(err));
      }
    },
  } satisfies Wallet;
}

type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

// sortedJSON is JSON with every object's keys in order, as Adena signs documents.
function sortedJSON(value: Json): string {
  if (Array.isArray(value)) return `[${value.map(sortedJSON).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([k, item]) => `${JSON.stringify(k)}:${sortedJSON(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}
