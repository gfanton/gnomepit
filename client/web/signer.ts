// Signs gno transactions in the page with the official gno JS clients: realm calls and
// session messages, by an account's own key or by a session key acting for it. It
// leaves the network to the page.

import { type Any, type MessageFns, type Provider, Tx, Wallet } from "@gnolang/tm2-js-client";
import { MsgCall, MsgCreateSession, MsgRevokeSession, decodeTxMessages } from "@gnolang/gno-js-client";
import * as v from "valibot";

import type { Fee } from "./chain.ts";
import { fromBase64, fromHex, toBase64 } from "./encoding.ts";
import { type Address, address } from "./ids.ts";

const codecs = {
  "/vm.m_call": encoderOf(MsgCall),
  "/auth.m_create_session": encoderOf(MsgCreateSession),
  "/auth.m_revoke_session": encoderOf(MsgRevokeSession),
};

// amino writes the zero session address of an account's own signature in bech32, and
// the chain reads it as no session.
const noSession = "g1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqluuxe";

const ZeroSpendPeriodSchema = v.object({ spend_period: v.literal("0") });

// A message in Adena's form: its type URL and its fields as amino JSON.
export type Message = { type: string; value: Record<string, unknown> };

export type SignRequest = {
  chainId: string;
  accountNumber: number;
  sequence: number;
  privKey: string;
  sessionAddr?: string;
  fee: Fee;
  memo?: string;
  msgs: Message[];
};

export type KeyInfo = { address: Address; pubKey: string };

export type Signer = { keyInfo: typeof keyInfo; signTx: typeof signTx; signBytes: typeof signBytes };

// keyInfo returns the address and the base64 33-byte compressed public key of a hex
// private key.
export async function keyInfo(privKeyHex: string): Promise<KeyInfo> {
  const wallet = await walletOf(privKeyHex);
  return { address: address(await wallet.getAddress()), pubKey: toBase64(await wallet.getSigner().getPublicKey()) };
}

// signTx signs msgs, in Adena's form, under the account number and sequence the chain
// holds for the signing account, and returns the base64 transaction. A non-empty
// sessionAddr, privKey's own address, signs as that session of the messages' signer.
export async function signTx({
  chainId,
  accountNumber,
  sequence,
  privKey,
  sessionAddr = "",
  fee,
  memo = "",
  msgs,
}: SignRequest): Promise<string> {
  if (typeof chainId !== "string" || chainId === "") throw new Error("missing chain id");
  if (!Array.isArray(msgs) || msgs.length === 0) throw new Error("no message to sign");
  for (const [name, value] of [
    ["account number", accountNumber],
    ["sequence", sequence],
  ] as const) {
    if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${name} must be a non-negative integer`);
  }
  const wallet = await walletOf(privKey);
  if (sessionAddr !== "" && sessionAddr !== (await wallet.getAddress()))
    throw new Error("session address is not the signing key's address");
  wallet.connect(chainIdProvider(chainId));
  const tx: Tx = {
    messages: msgs.map(toAny),
    fee: { gas_wanted: BigInt(fee.gasWanted), gas_fee: fee.gasFee },
    signatures: [],
    memo,
  };
  const signed = await wallet.signTransaction(tx, aminoMessages, {
    accountNumber: String(accountNumber),
    sequence: String(sequence),
  });
  const [signature] = signed.signatures;
  if (signature === undefined) throw new Error("the wallet returned the transaction unsigned");
  signature.session_addr = sessionAddr === "" ? noSession : sessionAddr;
  return toBase64(Tx.encode(signed).finish());
}

// signBytes signs base64 data with a hex private key, as a wallet signs a document, and
// returns the base64 signature.
export async function signBytes(privKeyHex: string, data: string): Promise<string> {
  const wallet = await walletOf(privKeyHex);
  return toBase64(await wallet.getSigner().signData(fromBase64(data)));
}

// The chain checks signatures against amino JSON, which leaves out a session's zero
// spend_period; decodeTxMessages writes it as "0".
function aminoMessages(messages: Any[]): unknown[] {
  const decoded = decodeTxMessages(messages);
  for (const msg of decoded) if (v.is(ZeroSpendPeriodSchema, msg)) Reflect.deleteProperty(msg, "spend_period");
  return decoded;
}

function toAny({ type, value }: Message): Any {
  if (!isCodecType(type)) throw new Error(`unsupported message ${type}`);
  // Like a zero spend_period, an empty spend_limit is left out of the chain's amino JSON
  // but not decodeTxMessages', so the chain would refuse the signature.
  if (type === "/auth.m_create_session" && (value.spend_limit ?? "") === "")
    throw new Error("a session needs a spend limit");
  return { type_url: type, value: codecs[type](value) };
}

const isCodecType = (type: string): type is keyof typeof codecs => Object.hasOwn(codecs, type);

// encoderOf gives a message's protobuf bytes under codec, from its amino JSON.
function encoderOf<T>(codec: MessageFns<T>): (value: Message["value"]) => Uint8Array {
  return (value) => codec.encode(codec.fromJSON(value)).finish();
}

async function walletOf(privKeyHex: string): Promise<Wallet> {
  if (!/^[0-9a-fA-F]{64}$/.test(privKeyHex)) throw new Error("private key must be 32 bytes of hex");
  return Wallet.fromPrivateKey(fromHex(privKeyHex));
}

// chainIdProvider is the provider signTransaction reads the chain id from, its one use
// when the account number and sequence come with the request; any other call rejects.
function chainIdProvider(chainId: string): Provider {
  const offline = (): Promise<never> => Promise.reject(new Error("the signer has no node"));
  return {
    getStatus: async () => ({
      node_info: {
        network: chainId,
        version_set: [],
        net_address: "",
        software: "",
        version: "",
        channels: "",
        monkier: "",
        other: { tx_index: "", rpc_address: "" },
      },
      sync_info: {
        latest_block_hash: "",
        latest_app_hash: "",
        latest_block_height: "",
        latest_block_time: "",
        catching_up: false,
      },
      validator_info: { address: "", pub_key: { type: "", value: "" }, voting_power: "" },
    }),
    abciQuery: offline,
    getBalance: offline,
    getAccountSequence: offline,
    getAccountNumber: offline,
    getAccount: offline,
    getBlock: offline,
    getBlockResult: offline,
    getBlockNumber: offline,
    getNetwork: offline,
    getConsensusParams: offline,
    getGasPrice: offline,
    estimateGas: offline,
    getTransaction: offline,
    sendTransaction: offline,
    waitForTransaction: offline,
  };
}
