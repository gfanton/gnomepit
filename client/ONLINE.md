# Online play

Online matches run through the arena realm, `r/arena`, on a gno chain. The page reads the realm, signs each match's moves with a session key of its own, and replays each round with its own engine. `client/web/arena.mjs` is the one module a lobby needs.

## Run a local chain

1. `make dev` starts gnodev with the engine, the arena and the gnotif registry, on the chain `gnomehall-dev`. The RPC listens on `127.0.0.1:36657` and gnoweb on `127.0.0.1:8890`. It copies the registry from a gnotif checkout, `~/code/gfanton/gnotif` unless `GNOTIF_DIR` names another. It funds two dev accounts, alice and bob, with 10,000 GNOT each.
2. `make indexer` runs tx-indexer v1.3.0 on that chain, answering on `127.0.0.1:8546`. The page learns of the other player's moves from it.
3. `make wasm` builds `engine.wasm` with TinyGo 0.42 or later, which must be on `PATH` (`nix shell nixpkgs#tinygo`), then `make serve` serves the page on `http://127.0.0.1:8080/`. `make e2e` and `make test` build it too.
4. Open `http://127.0.0.1:8080/?dev=alice` in one browser and `?dev=bob` in another, then **Play online**: the lobby, with a dev wallet in place of Adena. Without `dev`, the lobby uses Adena.
5. `online-dev.html?dev=alice` and `?dev=bob` open a bare console instead, which picks decks and plans at random. Add `&contract=1` to have the wallet sign every move instead of a session, and `&indexer=` with no value to poll the node instead of the indexer.
6. `make e2e` plays from node, with `make indexer` running and TinyGo on `PATH`, such as `nix shell nixpkgs#tinygo --command make e2e`:
   - **A match through sessions.** Alice and bob each sign through a session of their own. `Locks` lists each player's lock on the match after their opening, and a second challenge signed with alice's locked session fails with `session locked to match 1`. Alice's sessions last 30 seconds, so hers expires after round 1: her match's `session` reads `expired`, and she renews it to finish.
   - **A second challenge.** Alice posts again and gets a new session, which revokes the session of the ended match. Nobody accepts it.
   - **A match the wallet signs.** Both players sign every move with the wallet, which locks no session.

   It also checks that the indexer reports every call, in order.

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
- **A session per match.** Adena approves one session for each post or accept, and one for each renewal. That transaction revokes the player's dead sessions and creates a session for a free generation, or for a revoked one when none is free. The session may call the arena alone, spend its side's budget, and lasts one day; its spending counts gas fees and storage deposits. The realm locks it to the match of its first call, after which it acts in no other match and posts or accepts nothing more. A session is dead once it has expired, has less left than the costliest move it may still pay, or is locked to a match that ended or that the realm no longer knows.
- **Renewal.** When the player has no live session locked to a match, nor an unlocked one to lock, the next move there needs a renewal: `renew(id)` asks Adena for a session the same way, and the move locks it to the match. Resigning and claiming a forfeit need none: with no live session, the wallet signs that one call, in one approval.
- **Boxes.** A challenger's sealed deck and plans travel to the chain encrypted with the box key, beside their seals. Any browser with the same wallet opens them, so a challenger can continue from another device.
- **The fallback.** When Adena creates no session, or every generation holds a live session, Adena signs and sends each move through `DoContract`. The account state's `fallback` holds the reason, and after `resumeSessions()` the next challenge, acceptance or renewal asks for a session again.

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

`signer.mjs` gives `keyInfo`, `signTx` and `signBytes` on the official gno JS clients, `@gnolang/tm2-js-client` 3.3.0 and `@gnolang/gno-js-client` 3.1.0. `make vendor` bundles them from `client/js` into `vendor/gno.mjs`, with the Node `Buffer` and `crypto` they call: 353,382 bytes, 110,412 gzipped. `make golden` signs five requests with the chain's own Go types into `testdata/golden-tx.json`, and the tests check that `signer.mjs` gives the same bytes. After changing a pin in `client/js/package.json`, update the lockfile with `npm install --prefix client/js`, then run `make vendor`, which installs from the lockfile with `npm ci`, and commit the bundle: the page loads no code from a CDN. Run `make golden` after changing a request in `client/golden` or its gno version, pinned at `c97fd36` in `client/golden/go.mod`. `signTx` refuses a request the chain would refuse: no chain id, no message, an account number or sequence that is not a non-negative integer, a `sessionAddr` other than the signing key's own address, or a session with no spend limit.

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
| `renew(id)` | Asks the wallet for a new session for the player's side of match `id`, revoking the dead ones, unless a live unlocked session has that side's budget left. It sends no move: the next one locks the session. |
| `move(id, plan)` | Sends this player's turn: the challenger's reveal and next seal in one call, or the acceptor's plan |
| `finish(id)` | Sends the challenger's last reveal, after round 3 or a knockout |
| `resign(id)`, `claimForfeit(id)` | Resigns or withdraws; claims a passed deadline. With no live session for the match, the wallet signs the call. |
| `subscribe(onChange)` | Calls `onChange({match, func, caller, height})` for each arena call, `match` being `null` for a new challenge, and `onChange({})` when anything may have changed: each time the indexer starts answering, and on every poll of the node. Returns a stop function. |
| `watch(id, onChange)` | Calls `onChange(view)` whenever match `id` changes, reading it again on each change `subscribe` reports for it; returns a stop function |
| `notify()` | Opts the browser in to the arena's Turn and Ended notifications; call it from a click |

`challenge`, `accept` and `move` check the deck and plan with the engine first: a deck or plan it refuses throws `illegalPlan` before anything is sealed or sent. Moves go out one at a time, so two calls in a row never sign with the same sequence.

`challenge` and `accept` sign with an unlocked session that has the side's budget left. Without one, they first ask the wallet, in one approval, to revoke the dead sessions and create one: expired or used-up sessions, and those locked to a match that ended or is gone. Their call locks the session to the match. Every later call in the match signs with the live session locked to it or, when there is none, with any live unlocked session, such as the one `renew` creates, which that call locks. Without either, `move` and `finish` throw `sessionExpired`, while `resign` and `claimForfeit` have the wallet sign: a claimer's session always ends before the deadline it claims.

An action is `accept`, `move`, `finish`, `claimForfeit`, `wait` or `done`. A failed call throws an `ArenaError` whose `type` is one of `noWallet`, `wrongNetwork`, `refused`, `unauthorized`, `wrongPhase`, `sealMismatch`, `illegalPlan`, `deadlinePassed`, `sessionExpired`, `insufficientFunds`, `outOfStep`, `network` or `failed`, with a readable `reason`. `outOfStep` means the page's card file differs from the deployed engine.

## Storage per move

`scripts/measure-storage.mjs` has alice and bob play the realm test's worked match twice on a fresh `make dev`, built from gno `c97fd36`, with gas at 1 ugnot per 1,000 and storage at 100 ugnot per byte. Each player signs through a session for the match, as the page does.

- **Storage** is the bytes the move adds to the arena's storage, negative when it frees more than it adds.
- **Gas used** is the gas the transaction used.
- **Fee** is what the page pays for it: the gas used, plus a fifth and 100,000, at the chain's price.
- **Deposit** is the ugnot the move locks for the storage it adds. A move that frees storage locks nothing and gets 100 ugnot back per byte.

The first match is the chain's first, so it carries the one-time costs:

| Move | Storage | Gas used | Fee | Deposit |
|---|---|---|---|---|
| Challenge | 2,444 B | 15,057,665 | 18,170 ugnot | 244,400 ugnot |
| Accept | 2,153 B | 24,668,296 | 29,702 ugnot | 215,300 ugnot |
| Reveal, round 1 | -71 B | 44,469,682 | 53,464 ugnot | 0 ugnot |
| Play, round 2 | 0 B | 18,981,383 | 22,878 ugnot | 0 ugnot |
| Reveal, round 2 | 0 B | 31,823,497 | 38,289 ugnot | 0 ugnot |
| Play, round 3 | 0 B | 19,054,520 | 22,966 ugnot | 0 ugnot |
| Reveal, round 3 | -100 B | 30,747,144 | 36,997 ugnot | 0 ugnot |
| Total | 4,426 B | 184,802,187 | 222,466 ugnot | 459,700 ugnot |

The second match is between players who already have a record, inside the chunk the first match opened:

| Move | Storage | Gas used | Fee | Deposit |
|---|---|---|---|---|
| Challenge | 317 B | 16,173,031 | 19,508 ugnot | 31,700 ugnot |
| Accept | 86 B | 25,368,331 | 30,542 ugnot | 8,600 ugnot |
| Reveal, round 1 | -71 B | 44,686,425 | 53,724 ugnot | 0 ugnot |
| Play, round 2 | 0 B | 19,168,319 | 23,102 ugnot | 0 ugnot |
| Reveal, round 2 | 0 B | 32,094,154 | 38,613 ugnot | 0 ugnot |
| Play, round 3 | 0 B | 19,279,328 | 23,236 ugnot | 0 ugnot |
| Reveal, round 3 | -98 B | 30,948,541 | 37,239 ugnot | 0 ugnot |
| Total | 234 B | 187,718,129 | 225,964 ugnot | 40,300 ugnot |

A finished match between known players keeps 234 bytes locked, the players' two 48-byte session locks included. Each record keeps its lock until that session expires, and the player's next session-signed call then drops it. The match's moves lock 40,300 ugnot, and its reveals give back 16,900 as they drop the deck seal, shrink the box and finally clear the seal and the box.

The one-time costs, the first match minus the second, are 4,192 bytes and a 419,400 ugnot deposit. The challenge carries 2,127 bytes of them: alice's new player record and the arena's first chunk. The acceptance carries 2,067 bytes: bob's new player record. The first match's last reveal frees 2 bytes more than the second's, 100 against 98, which brings the sum to 4,192.

## Session budgets

Each match gets its own session, and its spend limit is the budget of the player's side (`sessionBudget` in `wallet.mjs`). A session's spending counts every fee and deposit, and refunds never restore it. A side's budget adds up, from the first match under Storage per move, which carries the one-time costs:

- the fee and the deposit of each of the side's moves;
- its costliest move once more, for one failed attempt.

The opening's deposit holds the 48-byte session lock its call adds.

| | Challenger | Acceptor |
|---|---|---|
| Opening move | Challenge: 18,170 + 244,400 = 262,570 | Accept: 29,702 + 215,300 = 245,002 |
| Later moves | Reveals: 53,464 + 38,289 + 36,997 | Plays: 22,878 + 22,966 |
| The side's moves | 391,320 | 290,846 |
| The costliest move again | 262,570 | 245,002 |
| Budget | 653,890 ugnot | 535,848 ugnot |

A session with less left than the costliest move it may still pay counts as used up (`sessionReserve`):
- **An unlocked session** may still pay an opening: 262,570 ugnot for the challenger and 245,002 for the acceptor.
- **A session locked to a match** pays only its side's later moves. Their reserve is the costliest such move in either measured match plus a tenth, rounded up to the ugnot, since moves cost more as a chunk fills: 59,097 ugnot for the challenger, from a 53,724 Reveal, and 25,560 for the acceptor, from a 23,236 Play.

## Before onyx

Check two things in onyx's release before deploying the arena there:
- **`runtime.GetSessionInfo` and session accounts.** The realm calls `GetSessionInfo` to lock each session to its match. Without it the lock has to go, and a session is held only to its per-match budget.
- **Restricted ugnot transfers.** On a chain that restricts them, freed storage deposits go to the storage fee collector (`gno.land/pkg/sdk/vm/keeper.go`) instead of the caller. A call that frees storage then gets nothing back: a reveal that drops a seal, a withdrawn challenge, or a challenge that clears expired ones.

## Tests

- `make test` runs the realm's tests, the Go tests and the script tests; the script tests run `engine.wasm`.
- With `make dev` and `make indexer` running, `make e2e` plays its matches. With `make dev` running, `make capture` records the query answers `gnovalue.mjs`'s tests read, and `make record` records the RPC answers the other tests replay.
