import test from 'node:test';
import assert from 'node:assert/strict';
import {ArenaError} from './arena.mjs';
import {createLobby, setupStep} from './lobby.mjs';

const app = () => ({classList:{add(){},remove(){},toggle(){}},dataset:{},innerHTML:'',querySelector:()=>null});
const flush = () => new Promise(resolve => setTimeout(resolve, 0));

// followedArena is an arena whose board the test sets, and whose subscribe hands the test
// the lobby's change handler.
function followedArena() {
  const arena = {board:[],reads:0,onChange:null,hasWallet:true};
  arena.openChallenges = async () => { arena.reads++; return arena.board; };
  arena.myMatches = async () => [];
  arena.subscribe = fn => { arena.onChange = fn; return () => { arena.onChange = null; }; };
  return arena;
}

function memory() {
  const items = new Map();
  return {getItem: k => items.get(k) ?? null, setItem: (k, v) => items.set(k, String(v))};
}

function stubPage(t) {
  globalThis.history = {replaceState(){}};
  globalThis.location = {pathname:'/',search:'',origin:'http://page.local'};
  t.after(() => { delete globalThis.history; delete globalThis.location; });
}

const ended = {ID:'4',Phase:'ended',Round:3,Challenger:'g1alice',Acceptor:'g1bob',Result:'b',Reason:'hp',
  Plans:[['Stone Guard','Undermine,Double Tap'],['Pick,Pick,Pick','Pick,Pick,Pick'],['Bulwark,Avalanche','Momentum,Pickaxe Flurry,Pick']],
  HP:[[15,15],[14,14],[13,14]],action:'done'};
const lastTurn = {...ended,Phase:'reveal',ToMove:'g1alice',Result:'',Reason:'',Plans:[...ended.Plans.slice(0,2),['','Momentum,Pickaxe Flurry,Pick']],HP:ended.HP.slice(0,2)};

// endingArena serves match 4 as arena.view says, and hands the test the lobby's watch.
function endingArena(view) {
  const arena = followedArena();
  arena.view = view;
  arena.match = async () => arena.view;
  arena.finish = async id => { arena.finished = id; arena.view = ended; };
  arena.watch = (id, fn) => { arena.onView = fn; return () => { arena.onView = null; }; };
  return arena;
}

// lobbyOf is a lobby for the player at address, which records each clash it plays;
// shown draws it and returns the page.
function lobbyOf(arena, address, storage = memory()) {
  const played = [], page = app();
  const lobby = createLobby({app:page,arena,storage,onRender(){},onPlay(raw, who, review) { played.push({phase:raw.Phase,review}); },portrait:()=>'',emblem:()=>''});
  if (address) lobby.model.account = {address,state:'active'};
  const shown = () => { lobby.render(); return page.innerHTML; };
  return {lobby, played, shown};
}

test('the challenger who finishes the match watches its last clash', async t => {
  stubPage(t);
  const arena = endingArena({...lastTurn,action:'finish'});
  const {lobby, played} = lobbyOf(arena, 'g1alice');
  await lobby.enter();
  await lobby.action('Open', {id:'4'});
  assert.equal(arena.finished, '4');
  assert.deepEqual(played, [{phase:'ended',review:true}]);
});

test('finishing from the button plays the last clash too', async t => {
  stubPage(t);
  const arena = endingArena({...lastTurn,action:'finish'});
  const {lobby, played} = lobbyOf(arena, 'g1alice');
  lobby.model.account.state = 'missing';
  await lobby.enter();
  await lobby.action('Open', {id:'4'});
  assert.equal(arena.finished, undefined);
  lobby.model.account.state = 'active';
  await lobby.action('Finish');
  assert.deepEqual(played, [{phase:'ended',review:true}]);
});

test('a player watching the match sees its last clash when it ends', async t => {
  stubPage(t);
  const arena = endingArena({...lastTurn,action:'wait'});
  const {lobby, played} = lobbyOf(arena, 'g1bob');
  await lobby.enter();
  await lobby.action('Open', {id:'4'});
  assert.deepEqual(played, []);
  await arena.onView(ended);
  assert.deepEqual(played, [{phase:'ended',review:true}]);
});

test('an ended match plays its last clash only the first time its player opens it', async t => {
  stubPage(t);
  const arena = endingArena(ended);
  const {lobby, played} = lobbyOf(arena, 'g1bob');
  await lobby.enter();
  await lobby.action('Open', {id:'4'});
  await lobby.returnToBoard();
  await lobby.action('Open', {id:'4'});
  assert.deepEqual(played, [{phase:'ended',review:true}]);
});

// A fresh chain numbers its matches from 1 again.
test('another match under a number already seen plays its last clash', async t => {
  stubPage(t);
  const arena = endingArena(ended);
  const {lobby, played} = lobbyOf(arena, 'g1bob');
  await lobby.enter();
  await lobby.action('Open', {id:'4'});
  arena.view = {...ended,Plans:[['Pick,Pick,Pick','Pick,Pick,Pick'],...ended.Plans.slice(1)]};
  await lobby.action('Open', {id:'4'});
  assert.equal(played.length, 2);
});

test('a match that ended without a clash, or that someone else played, opens on its result', async t => {
  stubPage(t);
  for (const [view, address] of [[{...ended,Reason:'resign'},'g1bob'],[{...ended,Reason:'forfeit'},'g1bob'],[ended,'g1carol']]) {
    const {lobby, played} = lobbyOf(endingArena(view), address);
    await lobby.enter();
    await lobby.action('Open', {id:'4'});
    assert.deepEqual(played, [], `${view.Reason} for ${address}`);
  }
});

// Before round 3, a finish instead of a move would tell the challenger the match is over.
test('a challenger whose clash ends the match early sees an ordinary move until it plays', async t => {
  stubPage(t);
  const early = {...lastTurn,Round:2,Plans:[ended.Plans[0],['','Pick,Pick,Pick']],HP:ended.HP.slice(0,1),action:'finish'};
  const {lobby, shown} = lobbyOf(endingArena(early), 'g1alice');
  lobby.model.account.state = 'missing';
  await lobby.enter();
  await lobby.action('Open', {id:'4'});
  assert.match(shown(), /<h1>Your move<\/h1>/);
  assert.doesNotMatch(shown(), /finish/i);
  assert.match(shown(), /data-action="onlineAccount"[^>]*>Connect to play</);
  lobby.model.account.state = 'active';
  assert.match(shown(), /data-action="onlineFinish"[^>]*>Watch clash &amp; plan</);
});

const bobsMove = {ID:'4',Phase:'play',Round:2,Challenger:'g1alice',Acceptor:'g1bob',ToMove:'g1bob',Plans:[ended.Plans[0],['','']],HP:ended.HP.slice(0,1),action:'move'};

// renewingArena is an endingArena for address whose renew records the match and makes its
// session active, or, with mode contract, leaves the wallet to sign each move.
function renewingArena(view, address, mode = 'session') {
  const arena = endingArena(view);
  arena.renewed = [];
  arena.renew = async id => { arena.renewed.push(id); arena.view = {...arena.view,session:'active'}; };
  arena.account = () => ({address,state:'active',mode,fallback:mode==='contract'?'User rejected':null});
  return arena;
}

test('an expired match session offers renewal', async t => {
  stubPage(t);
  const arena = renewingArena({...bobsMove,session:'expired'}, 'g1bob');
  const {lobby, shown} = lobbyOf(arena, 'g1bob');
  await lobby.enter();
  await lobby.action('Open', {id:'4'});
  assert.match(shown(), /data-action="onlineRenew"[^>]*>Renew session to play</);
  await lobby.action('Renew');
  assert.deepEqual(arena.renewed, ['4']);
  assert.match(shown(), /data-action="onlinePlay"[^>]*>Watch clash &amp; plan</);
});

test('a renewal the wallet refused shows the per-move mode', async t => {
  stubPage(t);
  const arena = renewingArena({...bobsMove,session:'expired'}, 'g1bob', 'contract');
  const {lobby} = lobbyOf(arena, 'g1bob');
  await lobby.enter();
  await lobby.action('Open', {id:'4'});
  await lobby.action('Renew');
  assert.equal(lobby.model.account.mode, 'contract');
});

// Finishing on an expired session would fail; the player renews first.
test('a finish whose session has expired waits for renewal', async t => {
  stubPage(t);
  const arena = renewingArena({...lastTurn,action:'finish',session:'expired'}, 'g1alice');
  const {lobby, shown} = lobbyOf(arena, 'g1alice');
  await lobby.enter();
  await lobby.action('Open', {id:'4'});
  assert.equal(arena.finished, undefined);
  assert.equal(lobby.model.error, '');
  assert.match(shown(), /data-action="onlineRenew"[^>]*>Renew session to play</);
  await lobby.action('Renew');
  assert.match(shown(), /data-action="onlineFinish"[^>]*>Finish match</);
});

test('the header says whether this device can play', () => {
  const {lobby, shown} = lobbyOf(followedArena(), 'g1alice');
  assert.match(shown(), /<small>Device ready<\/small>/);
  lobby.model.account.state = 'missing';
  assert.match(shown(), /<small>Approval needed<\/small>/);
});

// The realm deletes a withdrawn challenge, so the match it was is gone.
test('withdrawing returns to the board', async t => {
  stubPage(t);
  const arena = endingArena({ID:'4',Phase:'open',Challenger:'g1alice',Clan:'Pickers',Expires:9e9,action:'wait'});
  arena.match = async () => { if (arena.view === null) throw new Error('unknown match'); return arena.view; };
  arena.resign = async id => { arena.resigned = id; arena.watchedThrough = arena.onView !== null; arena.view = null; };
  const {lobby} = lobbyOf(arena, 'g1alice');
  await lobby.enter();
  await lobby.action('Open', {id:'4'});
  const reads = arena.reads;
  await lobby.action('ResignConfirm');
  assert.equal(arena.resigned, '4');
  assert.equal(arena.watchedThrough, false, 'a watch read after the withdrawal would find no match');
  assert.equal(lobby.model.view, null);
  assert.equal(lobby.model.error, '');
  assert.equal(arena.reads, reads + 1, 'the board is read again');
});

// The realm deletes a withdrawn challenge, and a later challenge clears an expired one.
test('a link to a removed challenge says so and stays on the board', async t => {
  stubPage(t);
  const arena = followedArena();
  arena.match = async () => { throw new ArenaError('wrongPhase', 'unknown match'); };
  arena.watch = () => { arena.watched = true; return () => {}; };
  const {lobby, shown} = lobbyOf(arena, 'g1bob');
  await lobby.enter('4');
  assert.equal(lobby.model.view, null);
  assert.equal(lobby.model.error, '');
  assert.equal(arena.watched, undefined);
  const page = shown();
  assert.match(page, /This challenge was withdrawn or has expired\./);
  assert.match(page, /Open challenges/);
  assert.doesNotMatch(page, /didn’t go through/);
});

test('resigning a running match shows its result', async t => {
  stubPage(t);
  const arena = endingArena(bobsMove);
  arena.resign = async () => { arena.view = {...bobsMove,Phase:'ended',Result:'a',Reason:'resign',action:'done'}; };
  const {lobby, shown} = lobbyOf(arena, 'g1bob');
  await lobby.enter();
  await lobby.action('Open', {id:'4'});
  await lobby.action('ResignConfirm');
  assert.match(shown(), /<h1>You lost<\/h1>/);
});

test("the board hides an ended match's result until its last clash has played", async t => {
  stubPage(t);
  const arena = endingArena(ended);
  const {Plans, HP, ...summary} = ended;
  arena.myMatches = async () => [summary, {...summary,ID:'5',Reason:'resign'}];
  const {lobby, shown} = lobbyOf(arena, 'g1bob');
  await lobby.enter();
  const before = shown();
  assert.match(before, /Match over.*Watch the last clash/s);
  assert.equal(before.match(/You won/g).length, 1, 'only the resigned match shows its result');
  assert.doesNotMatch(before, /Decided by HP/);
  await lobby.action('Open', {id:'4'});
  await lobby.action('Board');
  assert.equal(shown().match(/You won/g).length, 2);
  assert.match(shown(), /Decided by HP/);
});

test('a match opened from its link is watched', async t => {
  stubPage(t);
  const arena = endingArena({...lastTurn,action:'wait'});
  const {lobby} = lobbyOf(arena, 'g1bob');
  await lobby.enter('4');
  assert.equal(typeof arena.onView, 'function');
});

test('connecting on a match opened from its link plays its last clash', async t => {
  stubPage(t);
  const arena = endingArena(ended);
  arena.connect = async () => ({address:'g1bob',state:'active'});
  const {lobby, played} = lobbyOf(arena, '');
  await lobby.enter('4');
  assert.deepEqual(played, []);
  await lobby.action('Authorize');
  assert.deepEqual(played, [{phase:'ended',review:true}]);
});

test('the board reads its lists again on each change the arena reports', async () => {
  const arena = followedArena();
  const lobby = createLobby({app:app(),arena,onRender(){}});
  await lobby.enter();
  assert.deepEqual(lobby.model.challenges, []);

  arena.board = [{ID:'7',Challenger:'g1alice',Clan:'Ironhide',Expires:9e9}];
  arena.onChange({match:null,func:'Challenge'});
  await flush();
  assert.equal(lobby.model.challenges[0].id, '7');
  assert.equal(lobby.model.busy, false);
});

// Each redraw replays the cards' entrance animation, and most calls on a busy arena
// touch nothing this board lists.
test('a change that leaves the lists as they were does not redraw the board', async () => {
  const arena = followedArena();
  let renders = 0;
  const lobby = createLobby({app:app(),arena,onRender(){renders++;}});
  await lobby.enter();
  const drawn = renders;
  arena.onChange({match:'9',func:'Play'});
  await flush();
  assert.equal(renders, drawn);
});

test('a change while a match is open leaves the board alone', async () => {
  const arena = followedArena();
  const lobby = createLobby({app:app(),arena,onRender(){}});
  await lobby.enter();
  lobby.model.view = {id:'3'};
  const reads = arena.reads;
  arena.onChange({});
  await flush();
  assert.equal(arena.reads, reads);
});

test('after a move is sent, the match it was sent in is watched', async () => {
  const arena = followedArena();
  const view = {ID:'5',Phase:'play',Round:2,Challenger:'g1bob',Acceptor:'g1alice',ToMove:'g1alice',action:'move'};
  arena.match = async () => view;
  arena.move = async () => {};
  arena.watch = id => { arena.watched = id; return () => {}; };
  const lobby = createLobby({app:app(),arena,onRender(){}});
  await lobby.enter();
  lobby.model.account = {address:'g1alice',state:'active'};
  await lobby.sendDraft({intent:'move',view:{id:'5'}},'Ironhide',[0],[0,0,0]);
  assert.equal(arena.watched, '5');
});

// dialogLobby is a lobby whose page answers every query with one dialog, which the test
// reads; the dialog doubles as the opponent field.
function dialogLobby(t, arena, options = {}) {
  globalThis.document = {activeElement:null};
  t.after(() => { delete globalThis.document; });
  const dialog = {innerHTML:'',value:'',showModal(){},close(){},addEventListener(){}};
  const lobby = createLobby({app:{...app(),querySelector:()=>dialog},arena,onRender(){},...options});
  return {lobby, dialog};
}

const perMatch = 'Each match you post or accept asks your wallet once, for a one-day session that only plays that match.';

test('the setup dialog says each match asks the wallet for its own session', async t => {
  const {lobby, dialog} = dialogLobby(t, followedArena());
  await lobby.action('Account');
  assert.match(dialog.innerHTML, /Approve a session for each match/);
  assert.ok(dialog.innerHTML.includes(perMatch));
  assert.doesNotMatch(dialog.innerHTML, /seven|10 GNOT/);
  lobby.model.account = {address:'g1alice',state:'missing'};
  await lobby.action('Account');
  assert.match(dialog.innerHTML, /data-action="onlineAuthorize"[^>]*>Sign on this device</);
});

test("a ready device's account dialog says what each match asks", async t => {
  const {lobby, dialog} = dialogLobby(t, followedArena());
  lobby.model.account = {address:'g1alice',state:'active',mode:'session',fallback:null};
  await lobby.action('Account');
  assert.ok(dialog.innerHTML.includes(`<p>This device can play online. ${perMatch}</p>`));
  assert.doesNotMatch(dialog.innerHTML, /onlineAuthorize/);
});

test('a device whose wallet signs each move can use sessions again', async t => {
  const arena = followedArena();
  arena.connect = async () => ({address:'g1alice',state:'active',mode:'contract',fallback:'User rejected'});
  arena.authorize = async () => { throw new Error('connecting asked for the root signature again'); };
  arena.resumeSessions = () => ({address:'g1alice',state:'active',mode:'session',fallback:null});
  const {lobby, dialog} = dialogLobby(t, arena);
  await lobby.action('Authorize');
  assert.equal(lobby.model.error, '');
  assert.equal(lobby.model.account.mode, 'contract');
  await lobby.action('Account');
  assert.match(dialog.innerHTML, /User rejected/);
  assert.match(dialog.innerHTML, /data-action="onlineResumeSessions"[^>]*>Use sessions again</);
  await lobby.action('ResumeSessions');
  assert.equal(lobby.model.account.mode, 'session');
});

test('posting needs no session beforehand', async t => {
  const composed = [];
  const arena = followedArena();
  arena.connect = async () => ({address:'g1alice',state:'active',mode:'session',fallback:null});
  arena.authorize = async () => { throw new Error('posting asked the wallet for an approval'); };
  const {lobby, dialog} = dialogLobby(t, arena, {onCompose: context => composed.push(context)});
  await lobby.action('Authorize');
  await lobby.action('Post');
  assert.match(dialog.innerHTML, /Leave a challenge/);
  await lobby.action('Compose');
  assert.equal(lobby.model.error, '');
  assert.deepEqual(composed.map(c => c.intent), ['challenge']);
});

test('leaving online play stops following the arena', async t => {
  globalThis.history = {replaceState(){}};
  globalThis.location = {pathname:'/',search:''};
  t.after(() => { delete globalThis.history; delete globalThis.location; });
  const arena = followedArena();
  const lobby = createLobby({app:app(),arena,onRender(){},onExit(){}});
  await lobby.enter();
  assert.equal(typeof arena.onChange, 'function');
  await lobby.action('Exit');
  assert.equal(arena.onChange, null);
});

test('the setup step follows what the device still lacks', () => {
  assert.equal(setupStep({hasWallet:false,address:'',ready:false}), 1);
  assert.equal(setupStep({hasWallet:true,address:'',ready:false}), 2);
  assert.equal(setupStep({hasWallet:true,address:'g1alice',ready:false}), 3);
  assert.equal(setupStep({hasWallet:true,address:'g1alice',ready:true}), null);
});

test('without Adena the board leads with installing it', async () => {
  const page = app();
  const lobby = createLobby({app:page,arena:{...followedArena(),hasWallet:false,canNotify:false},storage:memory(),onRender:() => lobby.render()});
  await lobby.enter();
  assert.match(page.innerHTML, /Get ready to play online/);
  assert.match(page.innerHTML, /href="https:\/\/adena\.app"/);
  assert.doesNotMatch(page.innerHTML, /Online play needs Adena/);
});

test('an arena that does not say it found a wallet starts the setup at installing Adena', async () => {
  const page = app();
  const {hasWallet, ...arena} = followedArena();
  const lobby = createLobby({app:page,arena,storage:memory(),onRender:() => lobby.render()});
  await lobby.enter();
  assert.match(page.innerHTML, /aria-current="step"><strong>1 · Install Adena/);
});

test('Play offline leads home to the offline row, and the wordmark home', async () => {
  const exits = [];
  const lobby = createLobby({app:app(),arena:followedArena(),storage:memory(),onRender(){},onExit:offline => exits.push(offline)});
  globalThis.history = {replaceState(){}};
  globalThis.location = {pathname:'/',search:''};
  try {
    await lobby.action('Offline');
    await lobby.action('Exit');
  } finally { delete globalThis.history; delete globalThis.location; }
  assert.deepEqual(exits, [true, false]);
});

test('a board that fits on one page shows no pager, and Notify me needs a notifier', async () => {
  const page = app();
  const lobby = createLobby({app:page,arena:{...followedArena(),hasWallet:true,canNotify:false},storage:memory(),onRender:() => lobby.render()});
  await lobby.enter();
  assert.doesNotMatch(page.innerHTML, /Previous/);
  assert.doesNotMatch(page.innerHTML, /Notify me/);
});

test('a board the page cannot reach says so in plain words', async () => {
  const page = app();
  const arena = {...followedArena(),hasWallet:true,canNotify:false,openChallenges:async () => { throw new ArenaError('network','Failed to fetch'); }};
  const lobby = createLobby({app:page,arena,storage:memory(),onRender:() => lobby.render()});
  await lobby.enter();
  assert.match(page.innerHTML, /Can't reach the hall right now\. Check your connection and try again\./);
  assert.doesNotMatch(page.innerHTML, /Failed to fetch/);
});
