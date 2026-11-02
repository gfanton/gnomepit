// The player's wallet as the arena uses it: connecting Adena, or the dev wallet that
// answers the same calls; the one signature every key derives from; the sessions that
// let the page sign a match's moves; and the boxes that keep a challenger's sealed plans.

import * as v from "valibot";

import type { SessionLock } from "./arena.ts";
import { feeFor, gasWantedFor, type GasPrice, type Session } from "./chain.ts";
import { fromBase64, fromHex, toBase64, toHex } from "./encoding.ts";
import { type Address, type MatchId, address } from "./ids.ts";
import type { Message, Signer } from "./signer.ts";

export type Role = "challenger" | "acceptor";
type Move = { gasUsed: number; deposit: number };

// The gas used by each side's costliest later move, Reveal or Play, in any measured match.
const costliestLaterGas: Record<Role, number> = { challenger: 48_908_299, acceptor: 20_841_644 };
// What the move that ends two players' first rated match deposits in the standings realm for
// their standings, ladder entries, the clan records and the result log entry, on a ladder that
// already holds players: the last Reveal of client/ONLINE.md's fourth match. Any ending between
// two different clans writes the same.
const firstRatedDeposit = 1_032_200;
// The move each side pays to end a match, with the first rated deposit. A knockout lets any of
// the challenger's Reveals end it, so theirs uses the costliest Reveal's gas; the acceptor ends
// a match with a Resign, measured in the third match, or a ClaimForfeit, which writes the same.
const endings: Record<Role, Move> = {
  challenger: { gasUsed: costliestLaterGas.challenger, deposit: firstRatedDeposit },
  acceptor: { gasUsed: 22_345_858, deposit: firstRatedDeposit },
};
// Each side's moves in the first match of client/ONLINE.md "Storage per move", which carries
// the one-time costs, opening first: the gas each used and the ugnot it deposited. The
// acceptor's list ends with the ending they pay when they resign or claim a forfeit.
const measuredMoves: Record<Role, readonly [Move, ...Move[]]> = {
  challenger: [
    { gasUsed: 17_491_231, deposit: 244_500 }, // Challenge
    { gasUsed: 48_498_891, deposit: 0 }, // Reveal, round 1
    { gasUsed: 35_053_861, deposit: 0 }, // Reveal, round 2
    endings.challenger, // Reveal, round 3
  ],
  acceptor: [
    { gasUsed: 28_442_030, deposit: 215_300 }, // Accept
    { gasUsed: 20_629_928, deposit: 100 }, // Play, round 2
    { gasUsed: 20_393_822, deposit: 0 }, // Play, round 3
    endings.acceptor, // Resign or ClaimForfeit
  ],
};
// A later move's reserve keeps a tenth more, since moves cost more as their chunk fills.
const laterMargin = 1.1;

// costAt is a move's cost in ugnot at price, as chain.gasPrice gives it: its deposit and its fee.
const costAt = ({ gasUsed, deposit }: Move, price: GasPrice): number => deposit + feeFor(gasWantedFor(gasUsed), price);

// sessionBudget is role's spend limit for one match at price: the cost of each of the side's
// moves, and of its costliest once more, for one failed attempt.
export function sessionBudget(role: Role, price: GasPrice): number {
  const costs = measuredMoves[role].map((move) => costAt(move, price));
  return costs.reduce((sum, cost) => sum + cost, 0) + Math.max(...costs);
}

export type Reserve = { opening: Record<Role, number>; later: Record<Role, number> };

// sessionReserve is, at price, each side's costliest opening (Challenge, Accept) and later move
// (Reveal, Play, or the move that ends a first rated match), in ugnot: a session with less left
// counts as used up.
export function sessionReserve(price: GasPrice): Reserve {
  const later = (role: Role) =>
    Math.ceil(
      Math.max(costAt({ gasUsed: costliestLaterGas[role], deposit: 0 }, price), costAt(endings[role], price)) *
        laterMargin,
    );
  return {
    opening: {
      challenger: costAt(measuredMoves.challenger[0], price),
      acceptor: costAt(measuredMoves.acceptor[0], price),
    },
    later: { challenger: later("challenger"), acceptor: later("acceptor") },
  };
}

export const sessionLifetime = 24 * 60 * 60; // seconds
// Gas per session message; creating a session uses about 1.4M.
export const sessionGas = 3_000_000;
// The chain keeps at most 16 sessions per account, so generations run 0 to 15.
export const generations = 16;

// WalletError's type is "refused" when the player or the wallet declined, or the wallet's
// answer could not be read, and "box" for a box that these keys did not seal.
export class WalletError extends Error {
  type: "noWallet" | "wrongNetwork" | "refused" | "box";
  reason: string;

  constructor(type: WalletError["type"], reason: string) {
    super(reason);
    this.name = "WalletError";
    this.type = type;
    this.reason = reason;
  }
}

// A transaction for the wallet to sign or send. Without a gas and a fee in ugnot, the
// wallet picks its own.
// commit has Adena answer once the transaction's block is committed, with its deliver_tx,
// rather than once CheckTx passes. Adena reads it since its session release without
// declaring it.
export type TxRequest = { messages: Message[]; memo?: string; gasWanted?: number; gasFee?: number; commit?: boolean };

// The part of Adena's answer to a request with commit that holds what the call returned:
// base64 of the VM's print of its values, or null.
export const CommittedSchema = v.object({
  deliver_tx: v.object({ ResponseBase: v.object({ Data: v.nullable(v.string()) }) }),
});
export type Committed = v.InferOutput<typeof CommittedSchema>;

// The Adena calls the page makes. Each answers {status, type, message, data}, which
// answer reads.
export type Wallet = {
  AddEstablish(name: string): Promise<unknown>;
  GetNetwork(): Promise<unknown>;
  SwitchNetwork(chainId: string): Promise<unknown>;
  AddNetwork?(network: { chainId: string; chainName: string; rpcUrl: string }): Promise<unknown>;
  GetAccount(): Promise<unknown>;
  SignArbitrary(request: { signer: Address; data: string }): Promise<unknown>;
  SignTx(request: TxRequest): Promise<unknown>;
  DoContract(request: TxRequest): Promise<unknown>;
};

const ReplySchema = v.object({
  status: v.nullish(v.string()),
  type: v.nullish(v.string()),
  message: v.nullish(v.string()),
  data: v.optional(v.unknown()),
});
const NetworkSchema = v.object({ chainId: v.string() });
const AccountSchema = v.object({ address: v.pipe(v.string(), v.transform(address)) });
const SignatureSchema = v.object({ signature: v.object({ signature: v.string() }) });

// waitForAdena returns window.adena once the extension has injected it, or undefined
// after ms milliseconds without it.
export async function waitForAdena(ms = 5000): Promise<Wallet | undefined> {
  for (let waited = 0; waited < ms; waited += 250) {
    const adena = injectedAdena();
    if (adena !== undefined) return adena;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return undefined;
}

function injectedAdena(): Wallet | undefined {
  const window = globalThis.window;
  const adena: unknown = window !== undefined && "adena" in window ? window.adena : undefined;
  return isWallet(adena) ? adena : undefined;
}

// Adena injects its calls all at once, so the first one stands for the rest.
function isWallet(value: unknown): value is Wallet {
  return (
    typeof value === "object" && value !== null && "AddEstablish" in value && typeof value.AddEstablish === "function"
  );
}

// connect asks the wallet to connect the page, on chainId, and returns its address.
// network names the chain for Adena to add when it does not know chainId.
export async function connect(
  wallet:
    Pick<Wallet, "AddEstablish" | "GetNetwork" | "SwitchNetwork" | "AddNetwork" | "GetAccount"> | null | undefined,
  chainId: string,
  network: { chainName?: string; rpcUrl?: string } = {},
): Promise<{ address: Address }> {
  if (typeof wallet?.AddEstablish !== "function") throw new WalletError("noWallet", "No Adena wallet in this browser");
  const established = await wallet.AddEstablish("Gnomepit");
  // Adena checks the node of the network it is on before it connects a site.
  if (replyOf(established)?.type === "NETWORK_TIMEOUT")
    throw new WalletError(
      "refused",
      `Adena cannot reach the network it is on. Switch Adena to ${chainId}, then connect again.`,
    );
  answer(established, v.unknown(), ["ALREADY_CONNECTED"]);
  const current = answer(await wallet.GetNetwork(), NetworkSchema);
  if (current.chainId !== chainId) {
    let switched = await wallet.SwitchNetwork(chainId);
    if (replyOf(switched)?.type === "UNADDED_NETWORK") {
      const missing = new WalletError("wrongNetwork", `Add the network ${chainId} to Adena`);
      if (typeof wallet.AddNetwork !== "function" || network.rpcUrl === undefined || network.rpcUrl === "")
        throw missing;
      const added = replyOf(
        await wallet.AddNetwork({
          chainId,
          chainName: network.chainName ?? chainId,
          rpcUrl: network.rpcUrl,
        }),
      );
      if (added?.status !== "success")
        throw new WalletError("wrongNetwork", nonEmpty(added?.message) ?? missing.reason);
      switched = await wallet.SwitchNetwork(chainId);
    }
    answer(switched, v.unknown(), ["REDUNDANT_CHANGE_REQUEST"]);
  }
  return { address: answer(await wallet.GetAccount(), AccountSchema).address };
}

// currentAccount is the account wallet already shares with this page, read without asking
// to connect; null with no wallet, or when it answers anything but its account.
export async function currentAccount(wallet: Pick<Wallet, "GetAccount"> | undefined): Promise<Address | null> {
  if (wallet === undefined) return null;
  try {
    return answer(await wallet.GetAccount(), AccountSchema).address;
  } catch {
    return null;
  }
}

// answer returns a wallet response's data, as data reads it. Adena reports a few no-ops
// as failures; alsoFine lists those.
export function answer<T>(response: unknown, data: v.GenericSchema<unknown, T>, alsoFine: readonly string[] = []): T {
  const reply = replyOf(response);
  if (reply !== undefined && (reply.status === "success" || alsoFine.includes(reply.type ?? ""))) {
    const parsed = v.safeParse(data, reply.data);
    if (parsed.success) return parsed.output;
    throw new WalletError("refused", `The wallet gave an unexpected answer: ${v.summarize(parsed.issues)}`);
  }
  throw new WalletError("refused", nonEmpty(reply?.message) ?? nonEmpty(reply?.type) ?? "The wallet did not answer");
}

export type WalletReply = v.InferOutput<typeof ReplySchema>;

// replyOf reads a wallet's response, or gives undefined for one that is no reply.
export function replyOf(response: unknown): WalletReply | undefined {
  const parsed = v.safeParse(ReplySchema, response);
  return parsed.success ? parsed.output : undefined;
}

export const nonEmpty = (text: string | null | undefined): string | undefined =>
  text === null || text === "" ? undefined : text;

// rootText is what the player signs once per device; it names the site, which Adena
// also shows.
export function rootText(origin: string): string {
  return `Gnomepit at ${origin}\nSign once on each device to play online. This signs no transaction.`;
}

// rootSignature asks the wallet to sign rootText and returns the signature in base64.
export async function rootSignature(
  wallet: Pick<Wallet, "SignArbitrary">,
  account: Address,
  origin: string,
): Promise<string> {
  return answer(await wallet.SignArbitrary({ signer: account, data: rootText(origin) }), SignatureSchema).signature
    .signature;
}

export type SessionKeys = { sessionKey: string; sessionAddress: Address; sessionPubKey: string; boxKey: CryptoKey };

// deriveKeys derives, from the root signature, the session key of a generation and the
// box key, with HKDF-SHA256. signer turns a private key into its address and public key.
export async function deriveKeys(
  signature: string,
  generation: number,
  signer: Pick<Signer, "keyInfo">,
): Promise<SessionKeys> {
  const material = await crypto.subtle.importKey("raw", fromBase64(signature), "HKDF", false, [
    "deriveBits",
    "deriveKey",
  ]);
  const hkdf = (info: string): HkdfParams => ({
    name: "HKDF",
    hash: "SHA-256",
    salt: new Uint8Array(0),
    info: new TextEncoder().encode(info),
  });
  const sessionKey = toHex(
    new Uint8Array(await crypto.subtle.deriveBits(hkdf(`gnomepit session ${generation}`), material, 256)),
  );
  const { address, pubKey } = await signer.keyInfo(sessionKey);
  const boxKey = await crypto.subtle.deriveKey(
    hkdf("gnomepit box"),
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
  return { sessionKey, sessionAddress: address, sessionPubKey: pubKey, boxKey };
}

export function newSalt(): string {
  return toHex(crypto.getRandomValues(new Uint8Array(32)));
}

// sealOf is the hex sha256 of the salt's bytes followed by text, as the realm checks it.
export async function sealOf(salt: string, text: string): Promise<string> {
  const data = new Uint8Array([...fromHex(salt), ...new TextEncoder().encode(text)]);
  return toHex(new Uint8Array(await crypto.subtle.digest("SHA-256", data)));
}

const saltSize = 32;
const cardSetSize = 8;
const maxPlan = 3; // cards

// What a box seals: a plan and its salt as card ids and hex, and in round 1 the deck and
// its salt too.
export type BoxContents =
  | { plan: number[]; planSalt: string; deck?: undefined; deckSalt?: undefined }
  | { plan: number[]; planSalt: string; deck: number[]; deckSalt: string };

// sealBox encrypts a challenger's sealed plan with the box key and returns base64 of a
// 12-byte IV and the AES-GCM ciphertext.
export async function sealBox(boxKey: CryptoKey, { plan, planSalt, deck, deckSalt }: BoxContents): Promise<string> {
  const salts = deck === undefined ? fromHex(planSalt) : [...fromHex(deckSalt), ...fromHex(planSalt), ...cardSet(deck)];
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = new Uint8Array([...salts, plan.length, ...plan]);
  const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, boxKey, data));
  return toBase64(new Uint8Array([...iv, ...sealed]));
}

// openBox returns what sealBox sealed, the deck's ids in id order. It throws WalletError
// "box" for a box these keys did not seal or that holds no plan.
export async function openBox(boxKey: CryptoKey, box: string): Promise<BoxContents> {
  let data: Uint8Array;
  try {
    const bytes = fromBase64(box);
    data = new Uint8Array(
      await crypto.subtle.decrypt({ name: "AES-GCM", iv: bytes.subarray(0, 12) }, boxKey, bytes.subarray(12)),
    );
  } catch {
    throw new WalletError("box", "This wallet's keys did not seal this plan");
  }
  const round1 = data.length >= 2 * saltSize + cardSetSize + 2;
  const salts = round1 ? 2 * saltSize : saltSize;
  const plan = data.subarray(round1 ? salts + cardSetSize : salts);
  const count = plan[0];
  if (count === undefined || !(count >= 1 && count <= maxPlan && plan.length === 1 + count))
    throw new WalletError("box", "This box holds no plan this page can read");
  const sealed = { plan: [...plan.subarray(1)], planSalt: toHex(data.subarray(salts - saltSize, salts)) };
  if (!round1) return sealed;
  return {
    ...sealed,
    deck: cardIDsOf(data.subarray(salts, salts + cardSetSize)),
    deckSalt: toHex(data.subarray(0, saltSize)),
  };
}

// cardSet packs card ids as the engine's card set: a big-endian 64-bit word, bit i set for
// card id i.
function cardSet(ids: number[]): Uint8Array {
  const set = new Uint8Array(cardSetSize);
  for (const id of ids) {
    const at = cardSetSize - 1 - (id >> 3);
    set[at] = (set[at] ?? 0) | (1 << (id & 7));
  }
  return set;
}

function cardIDsOf(set: Uint8Array): number[] {
  const ids = [];
  for (let id = 0; id < 8 * cardSetSize; id++)
    if (((set[cardSetSize - 1 - (id >> 3)] ?? 0) & (1 << (id & 7))) !== 0) ids.push(id);
  return ids;
}

// A match a session is locked to: its phase, and this player's side in it.
export type LockedMatch = { phase: string; role: Role };
export type SessionEntry = { generation: number; keys: SessionKeys; session: Session };
export type SortedSessions = {
  byMatch: Map<MatchId, SessionEntry>;
  unlocked: SessionEntry[];
  dead: SessionEntry[];
  free: Omit<SessionEntry, "session">[];
};

const hasExpired = (session: Session, now: number): boolean => session.expiresAt !== 0 && session.expiresAt <= now;
// A lock under another expiry is an earlier session's, on the same key.
const lockOf = (session: Session, locks: SessionLock[]): SessionLock | undefined =>
  locks.find((l) => l.Session === session.address && l.Expires === session.expiresAt);

// lockedMatches lists the ids of the matches master's live sessions, onChain, are locked to:
// the matches whose phase classifySessions needs.
export function lockedMatches({
  onChain,
  locks,
  now,
}: {
  onChain: Session[];
  locks: SessionLock[];
  now: number;
}): MatchId[] {
  return [
    ...new Set(
      onChain
        .filter((s) => !hasExpired(s, now))
        .map((s) => lockOf(s, locks)?.Match)
        .filter((id) => id !== undefined),
    ),
  ];
}

// classifySessions sorts entries {generation, keys, session} into byMatch, by the match id the
// live session is locked to, unlocked, dead or free (no session); matches omits ids the realm forgot.
export function classifySessions({
  onChain,
  keys,
  locks,
  matches,
  now,
  realm,
  reserve,
}: {
  onChain: Session[];
  keys: Map<number, SessionKeys>;
  locks: SessionLock[];
  matches: Map<MatchId, LockedMatch>;
  now: number;
  realm: string;
  reserve: Reserve;
}): SortedSessions {
  const byAddress = new Map(onChain.map((s) => [s.address, s] as const));
  const out: SortedSessions = { byMatch: new Map(), unlocked: [], dead: [], free: [] };
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
    const needed =
      match === undefined ? Math.min(reserve.opening.challenger, reserve.opening.acceptor) : reserve.later[match.role];
    const entry = { generation, keys: k, session };
    if (expired || gone || session.spendLimit - session.spendUsed < needed) out.dead.push(entry);
    else if (lock === undefined) out.unlocked.push(entry);
    else out.byMatch.set(lock.Match, entry);
  }
  return out;
}

type SessionKeyAny = { type_url: "/tm.PubKeySecp256k1"; value: string };

// sessionMessage creates a session for the session key, in the form Adena takes: it may
// call realm alone, spend spendLimit ugnot, and lasts lifetime seconds from now.
export function sessionMessage(
  master: Address,
  sessionPubKey: string,
  now: number,
  realm: string,
  spendLimit: number,
  lifetime: number,
): {
  type: "/auth.m_create_session";
  value: {
    creator: Address;
    session_key: SessionKeyAny;
    expires_at: string;
    allow_paths: string[];
    spend_limit: string;
    spend_period: string;
  };
} {
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
export function revokeMessage(
  master: Address,
  sessionPubKey: string,
): { type: "/auth.m_revoke_session"; value: { creator: Address; session_key: SessionKeyAny } } {
  return { type: "/auth.m_revoke_session", value: { creator: master, session_key: sessionKeyOf(sessionPubKey) } };
}

// sessionKeyOf wraps a base64 public key as PubKeySecp256k1 in protobuf: field 1, 33 bytes.
function sessionKeyOf(sessionPubKey: string): SessionKeyAny {
  return { type_url: "/tm.PubKeySecp256k1", value: toBase64(new Uint8Array([0x0a, 33, ...fromBase64(sessionPubKey)])) };
}
