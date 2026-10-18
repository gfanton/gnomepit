// A wallet for local play and scripted tests: it holds a dev key in the page and
// answers the Adena calls the arena makes, in Adena's response shapes. make dev funds
// both accounts on gnodev. The keys are public, so the dev wallet is for local chains
// only.

import { payFor } from "./chain.ts";
import { toBase64 } from "./encoding.ts";

// Each key is the sha256 of "gnomehall dev <name>".
export const devAccounts = {
  alice: {
    key: "a53530163a6b35ac3d1423d7c0292a4067eb63310aa80e9d14aaa3919a7f21e6",
    address: "g1vzpn5tdhat0vy90eyqncs09474257tgz2uw09w",
  },
  bob: {
    key: "f597ba7dafa0e172e8ef9188d0ff39f0b6a2cb2006112bd9e2717544e99b5b8d",
    address: "g1h3cka3ya6jw3yr64erpklnhvrgh5l4du6w0faw",
  },
};

// Adena signs a transaction of session messages alone without simulating it, with the
// fee the page names or, without one, these.
const sessionAdmin = new Set(["/auth.m_create_session", "/auth.m_revoke_session", "/auth.m_revoke_all_sessions"]);
const adenaGasWanted = 2_000_000_000;
const adenaGasFee = 100_000; // ugnot

// devWallet is the dev account name's wallet; signer is signer.mjs, chain a chain.mjs
// client of the chain chainId names.
export function devWallet({ name, signer, chain, chainId }) {
  const { key, address } = devAccounts[name];
  const success = (data, type = "SUCCESS") => ({ status: "success", type, message: "", data });
  const failure = (type, message) => ({ status: "failure", type, message, data: null });

  async function sign({ messages: msgs, memo = "", gasWanted, gasFee }) {
    const account = await chain.account(address);
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
        fee: { gasWanted: gasWanted || adenaGasWanted, gasFee: `${gasFee || adenaGasFee}ugnot` },
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
      const signed = {
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
        return failure("SIGNING_FAILED", err.reason ?? err.message);
      }
    },

    async DoContract(params) {
      try {
        return success(await chain.broadcast(await sign(params)), "TRANSACTION_SUCCESS");
      } catch (err) {
        return failure("TRANSACTION_FAILED", err.reason ?? err.message);
      }
    },
  };
}

// sortedJSON is JSON with every object's keys in order, as Adena signs documents.
function sortedJSON(value) {
  if (Array.isArray(value)) return `[${value.map(sortedJSON).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${sortedJSON(value[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}
