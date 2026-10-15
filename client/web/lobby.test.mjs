import test from 'node:test';
import assert from 'node:assert/strict';
import {createLobby} from './lobby.mjs';

const app = () => ({classList:{add(){},remove(){},toggle(){}},dataset:{},innerHTML:'',querySelector:()=>null});
const flush = () => new Promise(resolve => setTimeout(resolve, 0));

// followedArena is an arena whose board the test sets, and whose subscribe hands the test
// the lobby's change handler.
function followedArena() {
  const arena = {board:[],reads:0,onChange:null};
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
  lobby.model.account.state = 'sessionExpired';
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
  lobby.model.account.state = 'sessionExpired';
  await lobby.enter();
  await lobby.action('Open', {id:'4'});
  assert.match(shown(), /<h1>Your move<\/h1>/);
  assert.doesNotMatch(shown(), /finish/i);
  lobby.model.account.state = 'active';
  assert.match(shown(), /data-action="onlineFinish"[^>]*>Watch clash &amp; plan</);
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

test("the session setup names the session's 10 GNOT spend limit", async t => {
  globalThis.document = {activeElement:null};
  t.after(() => { delete globalThis.document; });
  const dialog = {innerHTML:'',showModal(){},addEventListener(){}};
  const lobby = createLobby({app:{...app(),querySelector:()=>dialog},arena:followedArena(),onRender(){}});
  await lobby.action('Account');
  assert.match(dialog.innerHTML, /10 GNOT session limit/);
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
