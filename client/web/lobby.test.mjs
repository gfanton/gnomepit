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
