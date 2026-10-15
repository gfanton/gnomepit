# Online play

Online matches run through the arena realm, `r/arena`, on a gno chain. The page reads the realm, signs moves with a session key the player authorizes once, and replays each round with its own engine. `client/web/arena.mjs` is the one module a lobby needs.

## Run a local chain

1. `make dev` starts gnodev with the engine, the arena and the gnotif registry. The RPC listens on `127.0.0.1:36657` and gnoweb on `127.0.0.1:8890`. It copies the registry from a gnotif checkout, `~/code/gfanton/gnotif` unless `GNOTIF_DIR` names another. It funds two dev accounts, alice and bob, with 10,000 GNOT each.
2. `make wasm` builds `engine.wasm`, then `make serve` serves the page on `http://127.0.0.1:8080/`.
3. Open `online-dev.html?dev=alice` in one browser and `online-dev.html?dev=bob` in another. This console picks decks and plans at random; it stands in for the lobby. Add `&contract=1` to have the wallet sign every move instead of a session.
4. `make e2e` plays a whole match from node: alice through a session, bob through his wallet on each move.

gnodev keeps the chain in memory, so a restart starts from an empty arena.

## Check Adena

`adena-check.html` tests what only a person can approve in Adena: a stable root signature, a session, and a move Adena signs.

1. Run `make dev` and `make serve`, and install Adena 1.22.3 or later.
2. Open `http://127.0.0.1:8080/adena-check.html`. Click **Add the gnodev network to Adena** and approve, then **Connect**.
3. Run `make fund ADDRESS=<your Adena address>`; it sends 1,000 GNOT from gnodev's test account.
4. Run checks 1 to 3. For check 1, run it again in another browser profile with the same wallet: the signature it prints must be the same.

A failed check 2 prints Adena's reason. The arena then falls back to check 3's path: Adena approves each move.

## How a match reaches the chain

- **The root signature.** On each device the player signs one fixed text naming the site with `SignArbitrary`. The same wallet gives the same signature everywhere. HKDF-SHA256 derives two keys from it: a session key per generation (`gnomehall session <n>`) and a box key (`gnomehall box`). The page keeps the signature in local storage.
- **The session.** One Adena approval creates a session for the session key. It may call the arena alone, spend 10 GNOT, and lasts 7 days. The spend counts gas fees and storage deposits; a challenge alone locks about 0.9 GNOT of deposit. A session with less than 1.5 GNOT left, or one past its expiry, counts as expired; the next authorization creates a session for the first generation the chain holds no session for.
- **Boxes.** A challenger's sealed deck and plans travel to the chain encrypted with the box key, beside their seals. Any browser with the same wallet opens them, so a challenger can continue from another device.
- **The fallback.** When Adena creates no session, or every generation already has one, Adena signs and sends each move through `DoContract`. The account state's `fallback` holds the reason, and the next `authorize()` asks for a session again.

## Modules

| Module | Job |
|---|---|
| `arena.mjs` | The account state, the board, a player's matches, one match with its action, and every move |
| `wallet.mjs` | Connecting a wallet, the root signature, key derivation, sessions and boxes |
| `chain.mjs` | JSON-RPC to the node: queries, accounts, sessions, simulation, broadcast, and `payFor` |
| `gnovalue.mjs` | Decoding `vm/qeval_json` answers into plain objects |
| `devwallet.mjs` | A wallet with Adena's calls and public dev keys, for local chains only |
| `encoding.mjs` | Hex and base64 |
| `engine.mjs` | The engine's rules and, from `client/signer` in the same WebAssembly, `keyInfo`, `signTx` and `signBytes` |
| `gnotif.js`, `sw.js` | gnotif's browser client and service worker |

## The arena API

```js
const arena = createArena({ chain, wallet, engine, realm, chainId, origin, storage, notifier, signEachMove });
```

`chain` comes from `createChain({ rpc })`, `wallet` is `window.adena` or a `devWallet`, `engine` from `loadEngine`, `storage` is `localStorage`, `notifier` a gnotif `Gnotif`. `signEachMove` skips the session.

| Call | Returns or does |
|---|---|
| `connect()` | `{state, address, mode, expiresAt, fallback}`. `state` is `noWallet`, `wrongNetwork`, `missing` (this device has not authorized), `active` or `expired`. `noWallet` and `wrongNetwork` return `{state, reason}` and no address. |
| `authorize()` | Asks for the root signature once per device, then for a session; returns the new state |
| `openChallenges(page)` | Open challenges, newest first, 20 a page, each with `action` (`accept`, `wait` for one's own, `done`) |
| `myMatches(page)` | This player's matches, newest first, each with `action` and `deadline` |
| `match(id)` | The match view, plus `rounds` (each resolved round replayed: plans, events, state, result), `state`, `pending` (the challenger's next clash, when it is their move), `planning` (`{state, side, deck}` to plan from when the action is `move`) and `action` |
| `challenge({clan, deck, plan, opponent})` | Posts a challenge and returns its id. Deck and plan are card ids. |
| `accept(id, {clan, deck, plan})` | Accepts a challenge |
| `move(id, plan)` | Sends this player's turn: the challenger's reveal and next seal in one call, or the acceptor's plan |
| `finish(id)` | Sends the challenger's last reveal, after round 3 or a knockout |
| `resign(id)`, `claimForfeit(id)` | Resigns or withdraws; claims a passed deadline |
| `watch(id, onChange)` | Polls the match every 4 s while the page is visible; returns a stop function |
| `notify()` | Opts the browser in to the arena's Turn and Ended notifications; call it from a click |

`challenge`, `accept` and `move` check the deck and plan with the engine first: a deck or plan it refuses throws `illegalPlan` before anything is sealed or sent. Moves go out one at a time, so two calls in a row never sign with the same sequence.

An action is `accept`, `move`, `finish`, `claimForfeit`, `wait` or `done`. A failed call throws an `ArenaError` whose `type` is one of `noWallet`, `wrongNetwork`, `refused`, `unauthorized`, `wrongPhase`, `sealMismatch`, `illegalPlan`, `deadlinePassed`, `sessionExpired`, `insufficientFunds`, `outOfStep`, `network` or `failed`, with a readable `reason`. `outOfStep` means the page's card file differs from the deployed engine.

## Costs

On gnodev, built from gno `c97fd36`, with gas at 1 ugnot per 1,000 and storage at 100 ugnot per byte, for a match with 330-byte boxes on an arena holding a dozen matches:

| Move | Gas | Storage | Fee and deposit |
|---|---|---|---|
| Challenge | 13.5M | 9.4 KB | 0.96 GNOT |
| Accept | 22.6M | 1.0 KB | 0.13 GNOT |
| Reveal, round 1 | 37.3M | 1.3 KB | 0.17 GNOT |
| Play | 17.5M | 55 B | 0.03 GNOT |
| Reveal, later rounds | 35.0M | 0.1 to 0.9 KB | 0.05 to 0.13 GNOT |

The fee is the gas the move uses, plus a fifth and 100,000, at the chain's price; the deposit stays locked while the arena keeps the match.

## Tests

- `make test` runs the realm's tests, the Go tests and the script tests; the script tests run `engine.wasm`.
- With `make dev` running: `make e2e` plays a match, `make capture` records the query answers `gnovalue.mjs`'s tests read, and `make record` records the RPC answers the other tests replay.
