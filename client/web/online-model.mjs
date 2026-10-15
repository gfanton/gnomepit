// The lobby uses the arena view, never wallet/chain internals. Accept realm field
// casing as well as decoded camelCase values. Times in the arena are Unix seconds.
export const field = (v, key) => v?.[key] ?? v?.[{id:'ID',hp:'HP'}[key] ?? key[0].toUpperCase() + key.slice(1)];
export function viewOf(raw, address = '', now = Date.now() / 1000) {
  const keys = ['id','phase','round','challenger','acceptor','opponent','challengerClan','acceptorClan','clan','toMove','deadline','result','reason','posted','expires','challengerDeck','acceptorDeck','plans','hp','deadlinePassed','ownDeck'];
  const v = Object.fromEntries(keys.map(k => [k, field(raw,k)]));
  v.id = String(v.id ?? '');
  v.players = [v.challenger ?? '',v.acceptor ?? ''];
  v.clans = [v.challengerClan ?? v.clan ?? '',v.acceptorClan ?? ''];
  v.side = address && v.players.includes(address) ? v.players.indexOf(address) : -1;
  v.deadlinePassed = Boolean(v.deadlinePassed || (v.deadline && now >= v.deadline));
  const offered = field(raw,'action') ?? field(raw,'canDo');
  v.action = ['accept','move','finish','claimForfeit','wait','done'].includes(offered) ? offered
    : v.phase === 'open' && v.side !== 0 && (!v.opponent || v.opponent === address) && (!v.expires || now < v.expires) ? 'accept'
    : ['ended','withdrawn','expired'].includes(v.phase) ? 'done'
    : v.deadlinePassed && v.side >= 0 && v.toMove !== address ? 'claimForfeit'
    : 'wait'; // Only the arena can say a turn needs move vs automatic finish.
  if (['play','reveal'].includes(v.phase) && v.deadlinePassed) v.action = v.side >= 0 && v.toMove !== address ? 'claimForfeit' : 'wait';
  if (v.phase === 'open' && v.expires && now >= v.expires) { v.phase = 'expired'; v.action = 'done'; }
  if (v.phase === 'open' && v.opponent && v.opponent !== address) v.action = 'wait';
  return v;
}
export function shortAddress(address) { return address ? address.length > 15 ? `${address.slice(0,6)}…${address.slice(-4)}` : address : 'Awaiting a rival'; }
export function timeLeft(unix, now = Date.now()/1000) {
  if (!unix) return 'No deadline';
  const seconds = unix-now;
  if (seconds <= 0) return 'Deadline passed';
  const minutes = Math.ceil(seconds/60);
  if (minutes >= 1440) return `${Math.ceil(minutes/1440)} days left`;
  return `${Math.floor(minutes/60)}h ${minutes%60}m left`;
}
export function cardIds(value, cards) {
  if (!value || (Array.isArray(value) && !value.length)) return [];
  const items = typeof value === 'string' ? value.split(',').map(s=>s.trim()) : value;
  if (!Array.isArray(items)) throw new Error('The arena returned an unreadable card list.');
  return items.map(item => {
    const c = typeof item === 'number' ? cards.find(c=>c.id===item) : cards.find(c=>c.name===item);
    if (!c) throw new Error('This page’s card file does not match the chain’s engine. Reload before playing.');
    return c.id;
  });
}
export function replayView(view, engine, address, ownDeck = []) {
  const v = viewOf(view,address);
  if(engine.clans && v.clans.some(name=>name && !engine.clans.some(c=>c.name===name))) throw new Error('This page’s card file does not match the chain’s engine. Reload before playing.');
  const decks = [cardIds(v.challengerDeck,engine.cards),cardIds(v.acceptorDeck,engine.cards)];
  const recovered = v.ownDeck ?? view.planning?.deck; // the arena opens the challenger's deck from their box
  if (v.side >= 0 && !decks[v.side].length) decks[v.side] = cardIds(recovered,engine.cards).length ? cardIds(recovered,engine.cards) : ownDeck;
  let state = {round:1,gnomes:[0,1].map(()=>({hp:engine.hp,vulnerable:0,strength:0,spent:[]}))};
  const rounds=[];
  let result='ongoing';
  for(const [i,pair] of (v.plans ?? []).entries()) {
    if (!Array.isArray(pair) || pair.length!==2) throw new Error('The arena returned an unreadable round.');
    const plans=pair.map(p=>cardIds(p,engine.cards));
    if (plans.some(p=>!p.length)) break; // Current sealed or incomplete round.
    if (decks.some(d=>!d.length)) throw new Error('Public decks are needed to replay this match. Refresh the match.');
    const start=state;
    const resolved=engine.resolve({state,decks,a:plans[0],b:plans[1]});
    const chainHP=v.hp?.[i];
    if (!Array.isArray(chainHP) || chainHP.length!==2 || resolved.state.gnomes.some((g,s)=>g.hp!==chainHP[s])) throw new Error('This page’s card file does not match the chain’s engine. Reload before playing.');
    state=resolved.state;result=resolved.result;rounds.push({plans,events:resolved.events,state,start});
  }
  const pending=view.pending; // the challenger's clash, which the arena resolves from their opened box
  if (pending) {rounds.push({plans:pending.plans,events:pending.events,state:pending.state,start:state});state=pending.state;result=pending.result;}
  return {view:v,decks,state,rounds,result};
}
