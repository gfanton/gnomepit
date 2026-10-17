// The player's wallet as the arena uses it: connecting Adena, or the dev wallet that
// answers the same calls; the one signature every key derives from; the sessions that
// let the page sign a match's moves; and the boxes that keep a challenger's sealed plans.

import { feeFor, gasWantedFor } from "./chain.mjs";
import { fromBase64, fromHex, toBase64, toHex } from "./encoding.mjs";

// Each side's moves in the first match of client/ONLINE.md "Storage per move", which carries
// the one-time costs, opening first: the gas each used and the ugnot it deposited.
const measuredMoves = {
  challenger: [
    { gasUsed: 15_088_465, deposit: 244_400 }, // Challenge
    { gasUsed: 44_508_182, deposit: 0 }, // Reveal, round 1
    { gasUsed: 31_861_997, deposit: 0 }, // Reveal, round 2
    { gasUsed: 30_747_144, deposit: 0 }, // Reveal, round 3
  ],
  acceptor: [
    { gasUsed: 24_685_128, deposit: 215_300 }, // Accept
    { gasUsed: 18_985_591, deposit: 0 }, // Play, round 2
    { gasUsed: 19_077_664, deposit: 0 }, // Play, round 3
  ],
};
// The gas used by each side's costliest later move, Reveal or Play, in either measured match.
const costliestLaterGas = { challenger: 44_640_225, acceptor: 19_275_120 };
// A later move's reserve keeps a tenth more, since moves cost more as their chunk fills.
const laterMargin = 1.1;

// costAt is a move's cost in ugnot at price, as chain.gasPrice gives it: its deposit and its fee.
const costAt = ({ gasUsed, deposit }, price) => deposit + feeFor(gasWantedFor(gasUsed), price);

// sessionBudget is role's spend limit for one match at price: the cost of each of the side's
// moves, and of its costliest once more, for one failed attempt.
export function sessionBudget(role, price) {
  const costs = measuredMoves[role].map((move) => costAt(move, price));
  return costs.reduce((sum, cost) => sum + cost, 0) + Math.max(...costs);
}

// sessionReserve is, at price, each side's costliest opening (Challenge, Accept) and later move
// (Reveal, Play), in ugnot: a session with less left counts as used up.
export function sessionReserve(price) {
  const later = (role) => Math.ceil(costAt({ gasUsed: costliestLaterGas[role], deposit: 0 }, price) * laterMargin);
  return {
    opening: { challenger: costAt(measuredMoves.challenger[0], price), acceptor: costAt(measuredMoves.acceptor[0], price) },
    later: { challenger: later("challenger"), acceptor: later("acceptor") },
  };
}

export const sessionLifetime = 24 * 60 * 60; // seconds
// Gas per session message; creating a session uses about 1.4M.
export const sessionGas = 3_000_000;
// The chain keeps at most 16 sessions per account, so generations run 0 to 15.
export const generations = 16;

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
// waitForAdena returns window.adena once the extension has injected it, or undefined
// after ms milliseconds without it.
export async function waitForAdena(ms = 5000) {
  for (let waited = 0; waited < ms; waited += 250) {
    if (typeof globalThis.window?.adena?.AddEstablish === "function") return globalThis.window.adena;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return undefined;
}

// network names the chain for Adena to add when it does not know chainId: {chainName, rpcUrl}.
export async function connect(wallet, chainId, network = {}) {
  if (typeof wallet?.AddEstablish !== "function") throw new WalletError("noWallet", "No Adena wallet in this browser");
  answer(await wallet.AddEstablish("Gnomehall"), ["ALREADY_CONNECTED"]);
  const current = answer(await wallet.GetNetwork());
  if (current.chainId !== chainId) {
    let switched = await wallet.SwitchNetwork(chainId);
    if (switched?.type === "UNADDED_NETWORK") {
      const missing = new WalletError("wrongNetwork", `Add the network ${chainId} to Adena`);
      if (typeof wallet.AddNetwork !== "function" || !network.rpcUrl) throw missing;
      const added = await wallet.AddNetwork({ chainId, chainName: network.chainName ?? chainId, rpcUrl: network.rpcUrl });
      if (added?.status !== "success") throw new WalletError("wrongNetwork", added?.message || missing.reason);
      switched = await wallet.SwitchNetwork(chainId);
    }
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
// box key, with HKDF-SHA256. signer is signer.mjs, which turns a private key into its
// address and public key.
export async function deriveKeys(signature, generation, signer) {
  const material = await crypto.subtle.importKey("raw", fromBase64(signature), "HKDF", false, ["deriveBits", "deriveKey"]);
  const hkdf = (info) => ({ name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0), info: new TextEncoder().encode(info) });
  const sessionKey = toHex(new Uint8Array(await crypto.subtle.deriveBits(hkdf(`gnomehall session ${generation}`), material, 256)));
  const { address, pubKey } = await signer.keyInfo(sessionKey);
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

const saltSize = 32;
const cardSetSize = 8;
const maxPlan = 3; // cards

// sealBox encrypts a challenger's sealed plan with the box key and returns base64 of a
// 12-byte IV and the AES-GCM ciphertext. plan and deck are card ids and the salts hex;
// only the round-1 box holds deck and deckSalt.
export async function sealBox(boxKey, { plan, planSalt, deck, deckSalt }) {
  const salts = deck === undefined ? fromHex(planSalt) : [...fromHex(deckSalt), ...fromHex(planSalt), ...cardSet(deck)];
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = new Uint8Array([...salts, plan.length, ...plan]);
  const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, boxKey, data));
  return toBase64(new Uint8Array([...iv, ...sealed]));
}

// openBox returns what sealBox sealed, the deck's ids in id order. It throws WalletError
// "box" for a box these keys did not seal or that holds no plan.
export async function openBox(boxKey, box) {
  let data;
  try {
    const bytes = fromBase64(box);
    data = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: bytes.subarray(0, 12) }, boxKey, bytes.subarray(12)));
  } catch {
    throw new WalletError("box", "This wallet's keys did not seal this plan");
  }
  const round1 = data.length >= 2 * saltSize + cardSetSize + 2;
  const salts = round1 ? 2 * saltSize : saltSize;
  const plan = data.subarray(round1 ? salts + cardSetSize : salts);
  const count = plan[0];
  if (!(count >= 1 && count <= maxPlan && plan.length === 1 + count)) throw new WalletError("box", "This box holds no plan this page can read");
  const sealed = { plan: [...plan.subarray(1)], planSalt: toHex(data.subarray(salts - saltSize, salts)) };
  if (!round1) return sealed;
  return { ...sealed, deck: cardIDsOf(data.subarray(salts, salts + cardSetSize)), deckSalt: toHex(data.subarray(0, saltSize)) };
}

// cardSet packs card ids as the engine's card set: a big-endian 64-bit word, bit i set for
// card id i.
function cardSet(ids) {
  const set = new Uint8Array(cardSetSize);
  for (const id of ids) set[cardSetSize - 1 - (id >> 3)] |= 1 << (id & 7);
  return set;
}

function cardIDsOf(set) {
  const ids = [];
  for (let id = 0; id < 8 * cardSetSize; id++) if (set[cardSetSize - 1 - (id >> 3)] & (1 << (id & 7))) ids.push(id);
  return ids;
}

const hasExpired = (session, now) => session.expiresAt !== 0 && session.expiresAt <= now;
// A lock under another expiry is an earlier session's, on the same key.
const lockOf = (session, locks) => locks.find((l) => l.Session === session.address && l.Expires === session.expiresAt);

// lockedMatches lists the ids of the matches master's live sessions, onChain, are locked to:
// the matches whose phase classifySessions needs.
export function lockedMatches({ onChain, locks, now }) {
  return [...new Set(onChain.filter((s) => !hasExpired(s, now)).map((s) => lockOf(s, locks)?.Match).filter((id) => id !== undefined))];
}

// classifySessions sorts entries {generation, keys, session} into byMatch, by the match id the
// live session is locked to, unlocked, dead or free (no session); matches omits ids the realm forgot.
export function classifySessions({ onChain, keys, locks, matches, now, realm, reserve }) {
  const byAddress = new Map(onChain.map((s) => [s.address, s]));
  const out = { byMatch: new Map(), unlocked: [], dead: [], free: [] };
  for (const [generation, k] of keys) {
    const session = byAddress.get(k.sessionAddress);
    if (session === undefined) {
      out.free.push({ generation, keys: k });
      continue;
    }
    const expired = hasExpired(session, now);
    // The same keys may hold sessions for another arena on this site; those stay.
    if (!expired && !session.allowPaths.includes(`vm/exec:${realm}`)) continue;
    const lock = lockOf(session, locks);
    const match = lock === undefined ? undefined : matches.get(lock.Match);
    const gone = lock !== undefined && (match === undefined || match.phase === "ended");
    // An unlocked session has no side yet and may pay either opening; a locked one pays only
    // its side's later moves.
    const needed = match === undefined ? Math.min(reserve.opening.challenger, reserve.opening.acceptor) : reserve.later[match.role];
    const entry = { generation, keys: k, session };
    if (expired || gone || session.spendLimit - session.spendUsed < needed) out.dead.push(entry);
    else if (lock === undefined) out.unlocked.push(entry);
    else out.byMatch.set(lock.Match, entry);
  }
  return out;
}

// sessionMessage creates a session for the session key, in the form Adena takes: it may
// call realm alone, spend spendLimit ugnot, and lasts lifetime seconds from now.
export function sessionMessage(master, sessionPubKey, now, realm, spendLimit, lifetime) {
  return {
    type: "/auth.m_create_session",
    value: {
      creator: master,
      session_key: sessionKeyOf(sessionPubKey),
      expires_at: String(now + lifetime),
      allow_paths: [`vm/exec:${realm}`],
      spend_limit: `${spendLimit}ugnot`,
      spend_period: "0",
    },
  };
}

// revokeMessage revokes master's session for the session key, in the form Adena takes.
export function revokeMessage(master, sessionPubKey) {
  return { type: "/auth.m_revoke_session", value: { creator: master, session_key: sessionKeyOf(sessionPubKey) } };
}

// sessionKeyOf wraps a base64 public key as PubKeySecp256k1 in protobuf: field 1, 33 bytes.
function sessionKeyOf(sessionPubKey) {
  return { type_url: "/tm.PubKeySecp256k1", value: toBase64(new Uint8Array([0x0a, 33, ...fromBase64(sessionPubKey)])) };
}
