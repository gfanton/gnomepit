# Online play

Online matches run through the arena realm, `r/arena`, on a gno chain. The page reads the realm, signs each match's moves with a session key of its own, and replays each round with its own engine. `client/web/arena.ts` is the one module a lobby needs.

## Run a local chain

Every command below runs in the flake's dev shell: `direnv allow` once, or `nix develop`. It provides Go, TinyGo, Node, pnpm, and gno, gnokey and gnodev built from gno's `chain/onyx` tag.

1. `make dev` starts gnodev with the engine, the arena and the gnotif registry, on the chain `gnomehall-dev`. The RPC listens on `127.0.0.1:36657` and gnoweb on `127.0.0.1:8890`. It copies the registry from the gnotif revision the flake pins, or from the checkout `GNOTIF_DIR` names. It funds two dev accounts, alice and bob, with 10,000 GNOT each.
2. `make indexer` runs tx-indexer v1.3.0 on that chain, answering on `127.0.0.1:8546`. The page learns of the other player's moves from it.
3. `make serve` builds `engine.wasm` with TinyGo and bundles the pages with esbuild into `dist/`, then serves `dist/` on `http://127.0.0.1:8080/`. `GNOMEHALL_NETWORK` picks the network the build targets: `local` by default, or `offline` for a page with no online play. `make e2e` and `make test` build the engine too.
4. Open `http://127.0.0.1:8080/?dev=alice` in one browser and `?dev=bob` in another, then **Play online**: the lobby, with a dev wallet in place of Adena. Without `dev`, the lobby uses Adena.
5. `online-dev.html?dev=alice` and `?dev=bob` open a bare console instead, which picks decks and plans at random. Add `&contract=1` to have the wallet sign every move instead of a session, and `&indexer=` with no value to poll the node instead of the indexer.
6. `make e2e` plays from node, with `make indexer` running:
   - **A match through sessions.** Alice and bob each sign through a session of their own. `Locks` lists each player's lock on the match after their opening, and a second challenge signed with alice's locked session fails with `session locked to match 1`. So does a resignation signed with it in match 2, which alice's wallet posts and nobody accepts. Alice's sessions last 30 seconds, so hers expires after round 1: her match's `session` reads `expired`, and she renews it to finish.
   - **A second challenge.** Alice posts again and gets a new session, which revokes the session of the ended match. Nobody accepts it.
   - **A match the wallet signs.** Both players sign every move with the wallet, which locks no session.

   It also checks that the indexer reports every call, in order.

gnodev keeps the chain in memory, so a restart starts from an empty arena. gnodev also watches `deps/`, which `make deps` and `make test` rewrite: it then reloads, replaying the chain's transactions from height 0. Start `make indexer` again after either, since its index holds the old heights.

## Check Adena

`adena-check.html` tests what only a person can approve in Adena: a stable root signature, a session, a session revoked beside the one created, and a move Adena signs.

1. Run `make dev` and `make serve`, and install Adena 1.22.3 or later.
2. Open `http://127.0.0.1:8080/adena-check.html`. Click **Add the gnodev network to Adena** and approve, then **Connect**.
3. Run `make fund ADDRESS=<your Adena address>`; it sends 1,000 GNOT from gnodev's test account.
4. Run checks 1 to 4. For check 1, run it again in another browser profile with the same wallet: the signature it prints must be the same. Check 4 withdraws a challenge it posts, which leaves that challenge's session dead, so its second post's approval revokes the dead session as it creates the next one.

Rejecting check 2's approval cancels its post. When Adena cannot create the session, check 2 prints Adena's reason, and the arena falls back to check 3's path: Adena approves each move.

## How a match reaches the chain

- **The root signature.** On each device the player signs one fixed text naming the site with `SignArbitrary`. The same wallet gives the same signature everywhere. HKDF-SHA256 derives two keys from it: a session key per generation (`gnomehall session <n>`) and a box key (`gnomehall box`). The page keeps the signature in local storage.
- **A session per match.** Adena approves one session for each post or accept, and one for each renewal. That transaction revokes the player's dead sessions and creates a session for a free generation, or for a revoked one when none is free. The session may call the arena alone, spend its side's budget, and lasts one day; its spending counts gas fees and storage deposits. The realm locks it to the match of its first call, after which it acts in no other match and posts or accepts nothing more. A session is dead once it has expired, has less left than the costliest move it may still pay, or is locked to a match that ended or that the realm no longer knows.
- **Renewal.** When the player has no live session locked to a match, nor an unlocked one to lock, the next move there needs a renewal: `renew(id)` asks Adena for a session the same way, and the move locks it to the match. Resigning and claiming a forfeit need none: with no live session, the wallet signs that one call, in one approval.
- **Boxes.** A challenger's sealed deck and plans travel to the chain encrypted with the box key, beside their seals. Any browser with the same wallet opens them, so a challenger can continue from another device.
- **A rejected approval.** When the player rejects the session's approval or closes Adena's window, Adena answers `TRANSACTION_REJECTED`. The challenge, acceptance or renewal throws `refused` and sends nothing, and the next one asks for a session again.
- **The fallback.** When Adena answers that it cannot create the session, or every generation holds a live session, Adena signs and sends each call through `DoContract`, except in a match that has a live session locked to it, which keeps signing with that session. The account state's `fallback` holds the reason, and after `resumeSessions()` the next challenge, acceptance or renewal asks for a session again.

## Live updates

The node pushes nothing, and tx-indexer refuses websockets from a page on another origin: its GraphQL websocket answers `403 unable to upgrade`, onyx's public indexer included. So the page polls the indexer's GraphQL API over HTTP every 3 s while it is visible. Each poll asks for the latest indexed height; when it moved, a second request asks for the arena's successful calls in the new blocks. A call shows up within about 3 s of its block being indexed. A poll that fails loses nothing: the next one that succeeds reads every block since the last height read.

Without an indexer, or while it does not answer, `subscribe` polls the node instead: it reports a change every 4 s, and the page reads again what it shows.

## Modules

| Module | Job |
|---|---|
| `arena.ts` | The account state, the board, a player's matches, one match with its action, and every move |
| `arena-provider.ts` | The arena the lobby (`lobby.ts`, `online-model.ts`) plays through, built from the page's query string |
| `wallet.ts` | Connecting a wallet, the root signature, key derivation, sessions and boxes |
| `chain.ts` | JSON-RPC to the node: queries, accounts, sessions, simulation, broadcast, and `payFor` |
| `indexer.ts` | Polling a tx-indexer for the arena's calls |
| `gnovalue.ts` | Decoding `vm/qeval_json` answers into plain objects |
| `devwallet.ts` | A wallet with Adena's calls and public dev keys, for local chains only |
| `encoding.ts` | Hex and base64 |
| `engine.ts` | The engine's rules, from `engine.wasm` |
| `signer.ts` | `keyInfo`, `signTx` and `signBytes`: keys, transactions and signed documents |
| `gnotif.js`, `sw.js` | gnotif's browser client and service worker |

## Signer

`signer.ts` gives `keyInfo`, `signTx` and `signBytes` on the official gno JS clients, `@gnolang/tm2-js-client` 3.3.0 and `@gnolang/gno-js-client` 3.1.0. `make build` bundles them into each page, with shims for the Node `Buffer` and `crypto` they call, so the page loads no code from a CDN. `make golden` signs five requests with the chain's own Go types into `testdata/golden-tx.json`, and the tests check that `signer.ts` gives the same bytes. After changing a pin in `package.json`, update `pnpm-lock.yaml` with `pnpm install`. Run `make golden` after changing a request in `client/golden` or its gno version, pinned at `c97fd36` in `client/golden/go.mod`. `signTx` refuses a request the chain would refuse: no chain id, no message, an account number or sequence that is not a non-negative integer, a `sessionAddr` other than the signing key's own address, or a session with no spend limit.

`engine.wasm` holds the engine alone, built with TinyGo and loaded with TinyGo's own `wasm_exec.js`: 1,097,496 bytes, 402,716 gzipped.

## The arena API

```js
const arena = createArena({ chain, wallet, engine, signer, realm, chainId, origin, storage, notifier, indexer, network, signEachMove, sessionLifetime });
```

`chain` comes from `createChain({ rpc })`, `wallet` is `window.adena` or a `devWallet`, `engine` from `loadEngine`, `signer` is `signer.ts` (`import * as signer`), `storage` is `localStorage`, `notifier` a gnotif `Gnotif`, and `indexer` comes from `createIndexer({ url })` with the indexer's GraphQL URL, such as `http://127.0.0.1:8546/graphql/query`. Without `indexer`, `subscribe` polls the node. `signEachMove` skips sessions. `sessionLifetime` is how long each new session lasts, in seconds, one day unless given. `network`, `{chainName, rpcUrl}`, lets `connect()` add the chain to a wallet that does not know it; `loadArena` passes it for its default chain only, named by its chain ID, and passes none when `?chain=` or `?rpc=` names another, so an RPC address from a link never enters the wallet.

| Call | Returns or does |
|---|---|
| `connect()` | `{state, address, mode, fallback}`. `state` is `noWallet`, `wrongNetwork`, `missing` (this device has not authorized) or `active`. `noWallet` and `wrongNetwork` return `{state, reason}` and no address. When the wallet does not know the chain and `network` is set, it asks Adena's `AddNetwork` first, then switches; `wrongNetwork` means Adena could not or would not add it. |
| `hasWallet` (property) | `true` when a wallet was found in this browser. The board's setup panel starts at installing Adena otherwise. |
| `canNotify` (property) | `true` when the arena has a notifier; without one, `notify()` can only fail, so the board hides Notify me. |
| `authorize()` | Asks for the root signature once per device; returns the new state |
| `account()` | The account state `connect()` gives, without asking the wallet. `mode` is `contract` once the wallet could not create a session for a challenge, acceptance or renewal, or no generation was free. |
| `resumeSessions()` | Leaves the per-move fallback, so the next challenge, acceptance or renewal asks for a session again; returns the new state |
| `openChallenges(page)` | Open challenges, newest first, 50 a page, each with `action` (`accept`, `wait` for one's own, `done`) |
| `myMatches(page)` | This player's matches, newest first, each with `action` and `deadline` |
| `match(id)` | The match view, plus `rounds` (each resolved round replayed: plans, events, state, result), `state`, `pending` (the challenger's next clash, when it is their move), `planning` (`{state, side, deck}` to plan from when the action is `move`), `action`, `session`: `expired` when the player must call `renew(id)` before acting, `active` otherwise, and `sessionExpires`: the expiry, in Unix seconds, of the session that signs the player's next call, when one does |
| `challenge({clan, deck, plan, opponent})` | Posts a challenge and returns its id. Deck and plan are card ids. |
| `accept(id, {clan, deck, plan})` | Accepts a challenge |
| `renew(id)` | Asks the wallet for a new session for the player's side of match `id`, revoking the dead ones, unless a live unlocked session has that side's budget left. It sends no move: the next one locks the session. |
| `move(id, plan)` | Sends this player's turn: the challenger's reveal and next seal in one call, or the acceptor's plan |
| `finish(id)` | Sends the challenger's last reveal, after round 3 or a knockout |
| `resign(id)`, `claimForfeit(id)` | Resigns or withdraws; claims a passed deadline. With no live session for the match, the wallet signs the call. |
| `subscribe(onChange)` | Calls `onChange({match, func, caller, height})` for each arena call, `match` being `null` for a new challenge, and `onChange({})` when anything may have changed: each time the indexer starts answering, and on every poll of the node. Returns a stop function. |
| `watch(id, onChange)` | Calls `onChange(view)` whenever match `id` changes, reading it again on each change `subscribe` reports for it and at `sessionExpires`; returns a stop function |
| `notify()` | Opts the browser in to the arena's Turn and Ended notifications; call it from a click |

`challenge`, `accept` and `move` check the deck and plan with the engine first: a deck or plan it refuses throws `illegalPlan` before anything is sealed or sent. Moves go out one at a time, so two calls in a row never sign with the same sequence.

`challenge` and `accept` sign with an unlocked session that has the side's budget left. Without one, they first ask the wallet, in one approval, to revoke the dead sessions and create one: expired or used-up sessions, and those locked to a match that ended or is gone. A rejected approval throws `refused` and sends nothing. Their call locks the session to the match. Every later call in the match signs with the live session locked to it or, when there is none, with any live unlocked session, such as the one `renew` creates, which that call locks. Without either, `move` and `finish` throw `sessionExpired`, while `resign` and `claimForfeit` have the wallet sign: a claimer's session always ends before the deadline it claims. In the per-move mode, every call without a live session locked to its match has the wallet sign.

An action is `accept`, `move`, `finish`, `claimForfeit`, `wait` or `done`. A failed call throws an `ArenaError` whose `type` is one of `noWallet`, `wrongNetwork`, `refused`, `unauthorized`, `wrongPhase`, `sealMismatch`, `illegalPlan`, `deadlinePassed`, `sessionExpired`, `insufficientFunds`, `outOfStep`, `network` or `failed`, with a readable `reason`. `outOfStep` means the page's card file differs from the deployed engine.

## Storage per move

`scripts/measure-storage.ts` has alice and bob play the realm test's worked match twice on a fresh `make dev`, built from gno `c97fd36`, with gas at 1 ugnot per 1,000 and storage at 100 ugnot per byte. Each player signs through a session for the match, as the page does.

- **Storage** is the bytes the move adds to the arena's storage, negative when it frees more than it adds.
- **Gas used** is the gas the transaction used.
- **Fee** is what the page pays for it: the gas used, plus a fifth and 100,000, at the chain's price.
- **Deposit** is the ugnot the move locks for the storage it adds. A move that frees storage locks nothing and gets 100 ugnot back per byte.

The first match is the chain's first, so it carries the one-time costs:

| Move | Storage | Gas used | Fee | Deposit |
|---|---|---|---|---|
| Challenge | 2,444 B | 15,088,465 | 18,207 ugnot | 244,400 ugnot |
| Accept | 2,153 B | 24,685,128 | 29,723 ugnot | 215,300 ugnot |
| Reveal, round 1 | -71 B | 44,508,182 | 53,510 ugnot | 0 ugnot |
| Play, round 2 | 0 B | 18,985,591 | 22,883 ugnot | 0 ugnot |
| Reveal, round 2 | 0 B | 31,861,997 | 38,335 ugnot | 0 ugnot |
| Play, round 3 | 0 B | 19,077,664 | 22,994 ugnot | 0 ugnot |
| Reveal, round 3 | -100 B | 30,747,144 | 36,997 ugnot | 0 ugnot |
| Total | 4,426 B | 184,954,171 | 222,649 ugnot | 459,700 ugnot |

The second match is between players who already have a record, inside the chunk the first match opened:

| Move | Storage | Gas used | Fee | Deposit |
|---|---|---|---|---|
| Challenge | 317 B | 16,188,431 | 19,527 ugnot | 31,700 ugnot |
| Accept | 86 B | 25,376,747 | 30,553 ugnot | 8,600 ugnot |
| Reveal, round 1 | -71 B | 44,640,225 | 53,669 ugnot | 0 ugnot |
| Play, round 2 | 0 B | 19,178,839 | 23,115 ugnot | 0 ugnot |
| Reveal, round 2 | 0 B | 32,074,904 | 38,590 ugnot | 0 ugnot |
| Play, round 3 | 0 B | 19,275,120 | 23,231 ugnot | 0 ugnot |
| Reveal, round 3 | -98 B | 30,963,941 | 37,257 ugnot | 0 ugnot |
| Total | 234 B | 187,698,207 | 225,942 ugnot | 40,300 ugnot |

From one run to the next, a move's gas used differs by up to about 50,000, while its storage stays the same.

A finished match between known players keeps 234 bytes locked, the players' two 48-byte session locks included. Each record keeps its lock until that session expires, and the player's next session-signed call then drops it. The match's moves lock 40,300 ugnot, and its reveals give back 16,900 as they drop the deck seal, shrink the box and finally clear the seal and the box.

The one-time costs, the first match minus the second, are 4,192 bytes and a 419,400 ugnot deposit. The challenge carries 2,127 bytes of them: alice's new player record and the arena's first chunk. The acceptance carries 2,067 bytes: bob's new player record. The first match's last reveal frees 2 bytes more than the second's, 100 against 98, which brings the sum to 4,192.

## Session budgets

Each match gets its own session, and its spend limit is the budget of the player's side (`sessionBudget` in `wallet.ts`). A session's spending counts every fee and deposit, and refunds never restore it. The chain's gas price rises with load, and each move pays the price of its block, so the page prices a move at the chain's current gas price (`auth/gasprice`). A move costs two parts, measured in the first match under Storage per move, which carries the one-time costs:

- **The deposit**, in ugnot: 100 per byte the move adds, whatever the gas price. The opening's deposit holds the 48-byte session lock its call adds.
- **The fee**, for the gas the page asks for: the gas used, plus a fifth and 100,000 (`gasWantedFor` in `chain.ts`), at the chain's gas price.

`wallet.ts` keeps each measured move's gas used and deposit. When the page creates a session, it reads the gas price and sets the budget of the player's side:

- the cost of each of the side's moves;
- its costliest move once more, for one failed attempt.

At gnodev's 1 ugnot per 1,000 gas, the budgets come to:

| | Challenger | Acceptor |
|---|---|---|
| Opening move | Challenge: 18,207 + 244,400 = 262,607 | Accept: 29,723 + 215,300 = 245,023 |
| Later moves | Reveals: 53,510 + 38,335 + 36,997 | Plays: 22,883 + 22,994 |
| The side's moves | 391,449 | 290,900 |
| The costliest move again | 262,607 | 245,023 |
| Budget | 654,056 ugnot | 535,923 ugnot |

At five times that gas price, the fees cost five times as much and the deposits stay: the budgets come to 1,315,067 and 957,202 ugnot.

A session with less left than the costliest move it may still pay counts as used up (`sessionReserve`). The page prices that move at the chain's gas price each time it reads the session. The chain refuses a move its session cannot pay before running it, and charges nothing, so the session's spending never shows the shortfall. Once a rising price leaves a session short, its match's `session` reads `expired` and the lobby offers a renewal. At the floor price:
- **An unlocked session** may still pay an opening: 262,607 ugnot for the challenger and 245,023 for the acceptor.
- **A session locked to a match** pays only its side's later moves. Their reserve is the costliest such move in either measured match plus a tenth, rounded up to the ugnot, since moves cost more as a chunk fills: 59,036 ugnot for the challenger, from a 53,669 Reveal, and 25,555 for the acceptor, from a 23,231 Play.

## Before onyx

Check three things in onyx's release before deploying the arena there:
- **`runtime.GetSessionInfo` and session accounts.** The realm calls `GetSessionInfo` to lock each session to its match. Without it the lock has to go, and a session is held only to its per-match budget.
- **Restricted ugnot transfers.** On a chain that restricts them, freed storage deposits go to the storage fee collector (`gno.land/pkg/sdk/vm/keeper.go`) instead of the caller. A call that frees storage then gets nothing back: a reveal that drops a seal, a withdrawn challenge, or a challenge that clears expired ones.
- **The gas price and the storage price.** A budget prices gas at the gas price of the session's creation, so a price that keeps rising through a match makes its players renew. The deposits assume gnodev's storage price, the `vm` parameter `storage_price` of 100 ugnot per byte, which the page never reads. Compare onyx's `auth/gasprice` over a few days, and its `storage_price`, with these, and measure again on onyx if the storage price differs.

## Tests

- `make test` runs the realm's tests, the Go tests and the script tests; the script tests run `engine.wasm`.
- With `make dev` and `make indexer` running, `make e2e` plays its matches. With `make dev` running, `make capture` records the query answers `gnovalue.ts`'s tests read, and `make record` records the RPC answers the other tests replay.
