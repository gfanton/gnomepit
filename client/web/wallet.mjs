// The player's wallet as the arena uses it: connecting Adena, or the dev wallet that
// answers the same calls; the one signature every key derives from; the session that
// lets the page sign moves; and the boxes that keep a challenger's sealed plans.

import { fromBase64, fromHex, toBase64, toHex } from "./encoding.mjs";

// The session's spend limit counts gas fees and storage deposits; a challenge alone
// locks about 0.9 GNOT of deposit.
export const sessionSpendLimit = 10_000_000; // ugnot
export const sessionLifetime = 7 * 24 * 60 * 60; // seconds
// Creating a session uses about 1.4M gas.
export const sessionGas = 3_000_000;
// Below this much ugnot left, a session cannot pay for a challenge, the costliest call,
// so it counts as spent.
const sessionReserve = 1_500_000;
// The chain keeps at most 16 sessions per account, so generations run 0 to 15.
const generations = 16;

// WalletError's type is "noWallet", "wrongNetwork", "refused" (the player or the wallet
// declined) or "box" (a box that these keys did not seal).
export class WalletError extends Error {
  constructor(type, reason) {
    super(reason);
    this.name = "WalletError";
    this.type = type;
    this.reason = reason;
  }
}

// connect asks the wallet to connect the page, on chainId, and returns its address.
export async function connect(wallet, chainId) {
  if (typeof wallet?.AddEstablish !== "function") throw new WalletError("noWallet", "No Adena wallet in this browser");
  answer(await wallet.AddEstablish("Gnomehall"), ["ALREADY_CONNECTED"]);
  const network = answer(await wallet.GetNetwork());
  if (network.chainId !== chainId) {
    const switched = await wallet.SwitchNetwork(chainId);
    if (switched?.type === "UNADDED_NETWORK") throw new WalletError("wrongNetwork", `Add the network ${chainId} to Adena`);
    answer(switched, ["REDUNDANT_CHANGE_REQUEST"]);
  }
  return { address: answer(await wallet.GetAccount()).address };
}

// answer returns a wallet response's data. Adena reports a few no-ops as failures;
// alsoFine lists those.
export function answer(response, alsoFine = []) {
  if (response?.status === "success" || alsoFine.includes(response?.type)) return response.data;
  throw new WalletError("refused", response?.message || response?.type || "The wallet did not answer");
}

// rootText is what the player signs once per device; it names the site, which Adena
// also shows.
export function rootText(origin) {
  return `Gnomehall at ${origin}\nSign once on each device to play online. This signs no transaction.`;
}

// rootSignature asks the wallet to sign rootText and returns the signature in base64.
export async function rootSignature(wallet, address, origin) {
  return answer(await wallet.SignArbitrary({ signer: address, data: rootText(origin) })).signature.signature;
}

// deriveKeys derives, from the root signature, the session key of a generation and the
// box key, with HKDF-SHA256. signer is the engine, which turns a private key into its
// address and public key.
export async function deriveKeys(signature, generation, signer) {
  const material = await crypto.subtle.importKey("raw", fromBase64(signature), "HKDF", false, ["deriveBits", "deriveKey"]);
  const hkdf = (info) => ({ name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0), info: new TextEncoder().encode(info) });
  const sessionKey = toHex(new Uint8Array(await crypto.subtle.deriveBits(hkdf(`gnomehall session ${generation}`), material, 256)));
  const { address, pubKey } = signer.keyInfo(sessionKey);
  const boxKey = await crypto.subtle.deriveKey(hkdf("gnomehall box"), material, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
  return { sessionKey, sessionAddress: address, sessionPubKey: pubKey, boxKey };
}

export function newSalt() {
  return toHex(crypto.getRandomValues(new Uint8Array(32)));
}

// sealOf is the hex sha256 of the salt's bytes followed by text, as the realm checks it.
export async function sealOf(salt, text) {
  const data = new Uint8Array([...fromHex(salt), ...new TextEncoder().encode(text)]);
  return toHex(new Uint8Array(await crypto.subtle.digest("SHA-256", data)));
}

// sealBox encrypts object with the box key: base64 of a 12-byte IV and the AES-GCM
// ciphertext of its JSON.
export async function sealBox(boxKey, object) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = new TextEncoder().encode(JSON.stringify(object));
  const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, boxKey, data));
  return toBase64(new Uint8Array([...iv, ...sealed]));
}

export async function openBox(boxKey, box) {
  try {
    const bytes = fromBase64(box);
    const data = await crypto.subtle.decrypt({ name: "AES-GCM", iv: bytes.subarray(0, 12) }, boxKey, bytes.subarray(12));
    return JSON.parse(new TextDecoder().decode(data));
  } catch {
    throw new WalletError("box", "This wallet's keys did not seal this plan");
  }
}

// findSession looks for master's active session on realm among the generations keysFor
// derives. state is "active", "expired" when every session of these keys is expired,
// spent or for another realm, or "missing" when there is none. generation and keys are
// the active session's, or the first generation the chain holds no session for, which
// a new session takes.
export async function findSession(chain, master, keysFor, now, realm) {
  const onChain = new Map((await chain.sessions(master)).map((s) => [s.address, s]));
  let free = null;
  let ours = false;
  for (let generation = 0; generation < generations; generation++) {
    const keys = await keysFor(generation);
    const session = onChain.get(keys.sessionAddress);
    if (session === undefined) {
      free ??= { generation, keys };
      continue;
    }
    ours = true;
    const live = session.expiresAt === 0 || session.expiresAt > now;
    const funded = session.spendLimit - session.spendUsed >= sessionReserve;
    if (live && funded && session.allowPaths.includes(`vm/exec:${realm}`)) {
      return { state: "active", generation, keys, session, expiresAt: session.expiresAt };
    }
  }
  const state = ours ? "expired" : "missing";
  if (free === null) return { state, generation: null, keys: null, session: null, expiresAt: 0 };
  return { state, ...free, session: null, expiresAt: 0 };
}

// sessionMessage creates a session for the session key, in the form Adena takes: it may
// call realm alone, spend sessionSpendLimit, and lasts sessionLifetime from now.
export function sessionMessage(master, sessionPubKey, now, realm) {
  // PubKeySecp256k1 in protobuf: field 1, 33 bytes.
  const wrapped = new Uint8Array([0x0a, 33, ...fromBase64(sessionPubKey)]);
  return {
    type: "/auth.m_create_session",
    value: {
      creator: master,
      session_key: { type_url: "/tm.PubKeySecp256k1", value: toBase64(wrapped) },
      expires_at: String(now + sessionLifetime),
      allow_paths: [`vm/exec:${realm}`],
      spend_limit: `${sessionSpendLimit}ugnot`,
      spend_period: "0",
    },
  };
}
