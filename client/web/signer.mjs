// Signs gno transactions in the page with the official gno JS clients: realm calls and
// session messages, by an account's own key or by a session key acting for it. It
// leaves the network to the page.

import { MsgCall, MsgCreateSession, MsgRevokeSession, Tx, Wallet, decodeTxMessages } from "./vendor/gno.mjs";
import { fromBase64, fromHex, toBase64 } from "./encoding.mjs";

const codecs = {
  "/vm.m_call": MsgCall,
  "/auth.m_create_session": MsgCreateSession,
  "/auth.m_revoke_session": MsgRevokeSession,
};

// amino writes the zero session address of an account's own signature in bech32, and
// the chain reads it as no session.
const noSession = "g1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqluuxe";

// keyInfo returns the address and the base64 33-byte compressed public key of a hex
// private key.
export async function keyInfo(privKeyHex) {
  const wallet = await walletOf(privKeyHex);
  return { address: await wallet.getAddress(), pubKey: toBase64(await wallet.getSigner().getPublicKey()) };
}

// signTx signs msgs, in Adena's form, under the account number and sequence the chain
// holds for the signing account, and returns the base64 transaction. A non-empty
// sessionAddr signs as that session of the messages' signer.
export async function signTx({ chainId, accountNumber, sequence, privKey, sessionAddr = "", fee, memo = "", msgs }) {
  const wallet = await walletOf(privKey);
  wallet.connect({ getStatus: async () => ({ node_info: { network: chainId } }) });
  const tx = {
    messages: msgs.map(toAny),
    fee: { gas_wanted: BigInt(fee.gasWanted), gas_fee: fee.gasFee },
    signatures: [],
    memo,
  };
  const signed = await wallet.signTransaction(tx, aminoMessages, { accountNumber: String(accountNumber), sequence: String(sequence) });
  signed.signatures[0].session_addr = sessionAddr === "" ? noSession : sessionAddr;
  return toBase64(Tx.encode(signed).finish());
}

// signBytes signs base64 data with a hex private key, as a wallet signs a document, and
// returns the base64 signature.
export async function signBytes(privKeyHex, data) {
  const wallet = await walletOf(privKeyHex);
  return toBase64(await wallet.getSigner().signData(fromBase64(data)));
}

// The chain checks signatures against amino JSON, which leaves out a session's zero
// spend_period; decodeTxMessages writes it as "0".
function aminoMessages(messages) {
  const decoded = decodeTxMessages(messages);
  for (const msg of decoded) if (msg.spend_period === "0") delete msg.spend_period;
  return decoded;
}

function toAny({ type, value }) {
  const codec = codecs[type];
  if (codec === undefined) throw new Error(`unsupported message ${type}`);
  return { type_url: type, value: codec.encode(codec.fromJSON(value)).finish() };
}

async function walletOf(privKeyHex) {
  if (!/^[0-9a-fA-F]{64}$/.test(privKeyHex)) throw new Error("private key must be 32 bytes of hex");
  return Wallet.fromPrivateKey(fromHex(privKeyHex));
}
