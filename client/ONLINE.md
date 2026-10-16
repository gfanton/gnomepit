# Online play

Online matches run through the arena realm, `r/arena`, on a gno chain. The page reads the realm, signs moves with a session key the player authorizes once, and replays each round with its own engine. `client/web/arena.mjs` is the one module a lobby needs.

## Run a local chain

1. `make dev` starts gnodev with the engine, the arena and the gnotif registry, on the chain `gnomehall-dev`. The RPC listens on `127.0.0.1:36657` and gnoweb on `127.0.0.1:8890`. It copies the registry from a gnotif checkout, `~/code/gfanton/gnotif` unless `GNOTIF_DIR` names another. It funds two dev accounts, alice and bob, with 10,000 GNOT each.
2. `make indexer` runs tx-indexer v1.3.0 on that chain, answering on `127.0.0.1:8546`. The page learns of the other player's moves from it.
3. `make wasm` builds `engine.wasm` with TinyGo 0.42 or later, which must be on `PATH` (`nix shell nixpkgs#tinygo`), then `make serve` serves the page on `http://127.0.0.1:8080/`. `make e2e` and `make test` build it too.
4. Open `http://127.0.0.1:8080/?dev=alice` in one browser and `?dev=bob` in another, then **Play online**: the lobby, with a dev wallet in place of Adena. Without `dev`, the lobby uses Adena.
5. `online-dev.html?dev=alice` and `?dev=bob` open a bare console instead, which picks decks and plans at random. Add `&contract=1` to have the wallet sign every move instead of a session, and `&indexer=` with no value to poll the node instead of the indexer.
6. `make e2e` plays a whole match from node: alice through a session, bob through his wallet on each move. It also checks that the indexer reports every call of the match.

gnodev keeps the chain in memory, so a restart starts from an empty arena. gnodev also watches `deps/`, which `make deps` and `make test` rewrite: it then reloads, replaying the chain's transactions from height 0. Start `make indexer` again after either, since its index holds the old heights.

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
- **The fallback.** When Adena creates no session, or every generation already has one, Adena signs and sends each move through `DoContract`. The account state's `fallback` holds the reason, and after `resumeSessions()` the next challenge, acceptance or renewal asks for a session again.

## Live updates

The node pushes nothing, and tx-indexer refuses websockets from a page on another origin: its GraphQL websocket answers `403 unable to upgrade`, onyx's public indexer included. So the page polls the indexer's GraphQL API over HTTP every 3 s while it is visible. Each poll asks for the latest indexed height; when it moved, a second request asks for the arena's successful calls in the new blocks. A call shows up within about 3 s of its block being indexed. A poll that fails loses nothing: the next one that succeeds reads every block since the last height read.

Without an indexer, or while it does not answer, `subscribe` polls the node instead: it reports a change every 4 s, and the page reads again what it shows.

## Modules

| Module | Job |
|---|---|
| `arena.mjs` | The account state, the board, a player's matches, one match with its action, and every move |
| `arena-provider.mjs` | The arena the lobby (`lobby.mjs`, `online-model.mjs`) plays through, built from the page's query string |
| `wallet.mjs` | Connecting a wallet, the root signature, key derivation, sessions and boxes |
| `chain.mjs` | JSON-RPC to the node: queries, accounts, sessions, simulation, broadcast, and `payFor` |
| `indexer.mjs` | Polling a tx-indexer for the arena's calls |
| `gnovalue.mjs` | Decoding `vm/qeval_json` answers into plain objects |
| `devwallet.mjs` | A wallet with Adena's calls and public dev keys, for local chains only |
| `encoding.mjs` | Hex and base64 |
| `engine.mjs` | The engine's rules, from `engine.wasm` |
| `signer.mjs` | `keyInfo`, `signTx` and `signBytes`: keys, transactions and signed documents |
| `gnotif.js`, `sw.js` | gnotif's browser client and service worker |

## Signer

`signer.mjs` gives `keyInfo`, `signTx` and `signBytes` on the official gno JS clients, `@gnolang/tm2-js-client` 3.3.0 and `@gnolang/gno-js-client` 3.1.0. `make vendor` bundles them from `client/js` into `vendor/gno.mjs`, with the Node `Buffer` and `crypto` they call: 353,382 bytes, 110,412 gzipped. `make golden` signs five requests with the chain's own Go types into `testdata/golden-tx.json`, and the tests check that `signer.mjs` gives the same bytes. `signTx` refuses a request the chain would refuse: no chain id, no message, an account number or sequence that is not a non-negative integer, a `sessionAddr` other than the signing key's own address, or a session with no spend limit.

`engine.wasm` holds the engine alone, built with TinyGo and loaded with TinyGo's own `wasm_exec.js`: 960,874 bytes, 356,853 gzipped.

## The arena API

```js
const arena = createArena({ chain, wallet, engine, signer, realm, chainId, origin, storage, notifier, indexer, signEachMove, sessionLifetime });
```

`chain` comes from `createChain({ rpc })`, `wallet` is `window.adena` or a `devWallet`, `engine` from `loadEngine`, `signer` is `signer.mjs` (`import * as signer`), `storage` is `localStorage`, `notifier` a gnotif `Gnotif`, and `indexer` comes from `createIndexer({ url })` with the indexer's GraphQL URL, such as `http://127.0.0.1:8546/graphql/query`. Without `indexer`, `subscribe` polls the node. `signEachMove` skips sessions. `sessionLifetime` is how long each new session lasts, in seconds, one day unless given.

| Call | Returns or does |
|---|---|
| `connect()` | `{state, address, mode, fallback}`. `state` is `noWallet`, `wrongNetwork`, `missing` (this device has not authorized) or `active`. `noWallet` and `wrongNetwork` return `{state, reason}` and no address. |
| `authorize()` | Asks for the root signature once per device; returns the new state |
| `account()` | The account state `connect()` gives, without asking the wallet. `mode` is `contract` once a challenge, acceptance or renewal got no session. |
| `resumeSessions()` | Leaves the per-move fallback, so the next challenge, acceptance or renewal asks for a session again; returns the new state |
| `openChallenges(page)` | Open challenges, newest first, 50 a page, each with `action` (`accept`, `wait` for one's own, `done`) |
| `myMatches(page)` | This player's matches, newest first, each with `action` and `deadline` |
| `match(id)` | The match view, plus `rounds` (each resolved round replayed: plans, events, state, result), `state`, `pending` (the challenger's next clash, when it is their move), `planning` (`{state, side, deck}` to plan from when the action is `move`), `action`, and `session`: `expired` when the player must call `renew(id)` before acting, `active` otherwise |
| `challenge({clan, deck, plan, opponent})` | Posts a challenge and returns its id. Deck and plan are card ids. |
| `accept(id, {clan, deck, plan})` | Accepts a challenge |
| `renew(id)` | Asks the wallet for a new session for the player's side of match `id`, revoking the dead ones; sends no move |
| `move(id, plan)` | Sends this player's turn: the challenger's reveal and next seal in one call, or the acceptor's plan |
| `finish(id)` | Sends the challenger's last reveal, after round 3 or a knockout |
| `resign(id)`, `claimForfeit(id)` | Resigns or withdraws; claims a passed deadline. With no live session for the match, the wallet signs the call. |
| `subscribe(onChange)` | Calls `onChange({match, func, caller, height})` for each arena call, `match` being `null` for a new challenge, and `onChange({})` when anything may have changed: each time the indexer starts answering, and on every poll of the node. Returns a stop function. |
| `watch(id, onChange)` | Calls `onChange(view)` whenever match `id` changes, reading it again on each change `subscribe` reports for it; returns a stop function |
| `notify()` | Opts the browser in to the arena's Turn and Ended notifications; call it from a click |

`challenge`, `accept` and `move` check the deck and plan with the engine first: a deck or plan it refuses throws `illegalPlan` before anything is sealed or sent. Moves go out one at a time, so two calls in a row never sign with the same sequence.

`challenge` and `accept` sign with an unlocked session that has the side's budget left. Without one, they first ask the wallet, in one approval, to revoke the dead sessions and create one: expired or used-up sessions, and those locked to a match that ended or is gone. Their call locks the session to the match. Every later call in the match signs with that session, or with the one `renew` creates. Without one, `move` and `finish` throw `sessionExpired`, while `resign` and `claimForfeit` have the wallet sign: a claimer's session always ends before the deadline it claims.

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

## Storage per move

`scripts/measure-storage.mjs` has alice and bob play the realm test's worked match twice on a fresh `make dev`, built from gno `c97fd36`, with gas at 1 ugnot per 1,000 and storage at 100 ugnot per byte. Alice signs through a session and bob through his wallet.

- **Storage** is the bytes the move adds to the arena's storage, negative when it frees more than it adds.
- **Gas used** is the gas the transaction used.
- **Fee** is what the page pays for it: the gas used, plus a fifth and 100,000, at the chain's price.
- **Deposit** is the ugnot the move locks for the storage it adds. A move that frees storage locks nothing and gets 100 ugnot back per byte.

The first match is the chain's first, so it carries the one-time costs:

| Move | Storage | Gas used | Fee | Deposit |
|---|---|---|---|---|
| Challenge | 2,444 B | 15,084,615 | 18,202 ugnot | 244,400 ugnot |
| Accept | 2,105 B | 24,217,356 | 29,161 ugnot | 210,500 ugnot |
| Reveal, round 1 | -71 B | 44,454,282 | 53,446 ugnot | 0 ugnot |
| Play, round 2 | 0 B | 17,858,842 | 21,531 ugnot | 0 ugnot |
| Reveal, round 2 | 0 B | 31,842,747 | 38,312 ugnot | 0 ugnot |
| Play, round 3 | 0 B | 17,953,019 | 21,644 ugnot | 0 ugnot |
| Reveal, round 3 | -100 B | 30,762,544 | 37,016 ugnot | 0 ugnot |
| Total | 4,378 B | 182,173,405 | 219,312 ugnot | 454,900 ugnot |

The second match is between players who already have a record, inside the chunk the first match opened:

| Move | Storage | Gas used | Fee | Deposit |
|---|---|---|---|---|
| Challenge | 317 B | 16,164,371 | 19,498 ugnot | 31,700 ugnot |
| Accept | 36 B | 24,778,010 | 29,834 ugnot | 3,600 ugnot |
| Reveal, round 1 | -71 B | 44,690,275 | 53,729 ugnot | 0 ugnot |
| Play, round 2 | 0 B | 17,968,166 | 21,662 ugnot | 0 ugnot |
| Reveal, round 2 | 0 B | 32,036,404 | 38,544 ugnot | 0 ugnot |
| Play, round 3 | 0 B | 18,030,783 | 21,737 ugnot | 0 ugnot |
| Reveal, round 3 | -98 B | 30,960,091 | 37,253 ugnot | 0 ugnot |
| Total | 184 B | 184,628,100 | 222,257 ugnot | 35,300 ugnot |

A finished match between known players keeps 184 bytes locked, 48 of them for alice's session lock. Her record keeps the lock until that session expires, and her next session-signed call then drops it. The match's moves lock 35,300 ugnot, and its reveals give back 16,900 as they drop the deck seal, shrink the box and finally clear the seal and the box.

The one-time costs, the first match minus the second, are 4,194 bytes and a 419,600 ugnot deposit. The challenge carries 2,127 bytes of them: alice's new player record and the arena's first chunk. The acceptance carries 2,069 bytes: bob's new player record.

## Session budgets

Each match gets its own session, and its spend limit is the budget of the player's side (`sessionBudget` in `wallet.mjs`). A session's spending counts every fee and deposit, and refunds never restore it. A side's budget adds up, from the first match under Storage per move, which carries the one-time costs:

- the fee and the deposit of each of the side's moves;
- its costliest move once more, for one failed attempt;
- 4,800 ugnot for the realm's 48-byte session lock, which a session's first call adds. Bob's measured Accept holds none, since his wallet signs it, while alice's Challenge already holds hers.

| | Challenger | Acceptor |
|---|---|---|
| Opening move | Challenge: 18,202 + 244,400 = 262,602 | Accept: 29,161 + 210,500 = 239,661 |
| Later moves | Reveals: 53,446 + 38,312 + 37,016 | Plays: 21,531 + 21,644 |
| The side's moves | 391,376 | 282,836 |
| The costliest move again | 262,602 | 239,661 |
| The session lock | 4,800 | 4,800 |
| Budget | 658,778 ugnot | 527,297 ugnot |

A session with less left than the costliest move it may still pay counts as used up (`sessionReserve`). An unlocked session may still pay an opening: 262,602 ugnot for the challenger and 239,661 for the acceptor. A session locked to a match pays only its side's later moves: 53,446 ugnot for the challenger's costliest Reveal, and 21,644 for the acceptor's costliest Play.

## Tests

- `make test` runs the realm's tests, the Go tests and the script tests; the script tests run `engine.wasm`.
- With `make dev` and `make indexer` running, `make e2e` plays a match. With `make dev` running, `make capture` records the query answers `gnovalue.mjs`'s tests read, and `make record` records the RPC answers the other tests replay.
