import test from 'node:test';
import assert from 'node:assert/strict';
import {viewOf,timeLeft,cardIds,replayView} from './online-model.mjs';
const account='g1player';
test('reserved and expired challenges cannot be accepted by another account',()=>{
 assert.equal(viewOf({ID:'1',Phase:'open',Opponent:'g1friend',Expires:200},account,100).action,'wait');
 assert.equal(viewOf({ID:'1',Phase:'open',Opponent:account,Expires:200},account,100).action,'accept');
 assert.equal(viewOf({ID:'1',Phase:'open',Expires:99},account,100).phase,'expired');
});
test('uses arena move/finish distinction and exposes forfeits only to the other player',()=>{
 const v={Phase:'reveal',Challenger:account,Acceptor:'g1other',ToMove:account,Deadline:200};
 assert.equal(viewOf({...v,action:'finish'},account,100).action,'finish');
 assert.equal(viewOf(v,account,100).action,'wait');
 assert.equal(viewOf(v,account,201).action,'wait');
 assert.equal(viewOf({...v,action:'move'},account,201).action,'wait');
 assert.equal(viewOf(v,'g1other',201).action,'claimForfeit');
});
test('deck and plan names reject unknown cards instead of mapping to a wrong id',()=>{
 assert.deepEqual(cardIds('Pick,Brace',[{id:0,name:'Pick'},{id:1,name:'Brace'}]),[0,1]);
 assert.throws(()=>cardIds('Pick,Unknown',[{id:0,name:'Pick'}]),/card file/);
});
test('replay verifies every round against chain HP and never resolves a sealed plan',()=>{
 let calls=0;
 const engine={hp:20,cards:[{id:0,name:'Pick'}],resolve:({state})=>{calls++;return{state:{round:state.round+1,gnomes:[{hp:18},{hp:17}]},result:'ongoing',events:[]};}};
 const view={Challenger:account,Acceptor:'g1other',ChallengerDeck:'Pick',AcceptorDeck:'Pick',Plans:[['Pick','Pick'],['','Pick']],HP:[[18,17]]};
 assert.equal(replayView(view,engine,account).rounds.length,1);assert.equal(calls,1);
 assert.throws(()=>replayView({...view,HP:[[19,17]]},engine,account),/card file/);
 assert.throws(()=>replayView({...view,HP:[]},engine,account),/card file/);
});
test('deadline labels never round a still-active deadline to expired',()=>{
 assert.equal(timeLeft(100,99),'0h 1m left');assert.equal(timeLeft(100,100),'Deadline passed');
});
