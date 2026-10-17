// The match flow: a pure reducer over the page's screens. It knows which screen shows,
// who is acting and what has been chosen; rendering and the engine live elsewhere.

export const initial = Object.freeze({
  screen: "title",
  mode: null, // "hotseat", "bot" or "tutorial"
  hp: null,
  acting: 0, // the player choosing a deck or a plan
  clans: [null, null],
  decks: [null, null],
  state: null, // the engine state between rounds
  plans: [null, null], // the current round's sealed plans
  rounds: [], // {plans, events, state} per resolved round
  result: "ongoing",
  after: null, // the screen a hand-off leads to: {screen, acting}
});

// botTurn is true when the bot has to choose a deck or a plan, or the guided match's script
// has to play Ironhide's plan.
export function botTurn(flow) {
  if (flow.mode === "tutorial") return flow.acting === 1 && flow.screen === "plan";
  return flow.mode === "bot" && flow.acting === 1 && (flow.screen === "deck" || flow.screen === "plan");
}

export function reduce(flow, action) {
  switch (`${flow.screen}/${action.type}`) {
    case "title/start":
      return { ...initial, screen: "deck", mode: action.mode, hp: action.hp, state: freshState(action.hp) };
    case "title/startTutorial":
      return {
        ...initial,
        screen: "plan",
        mode: "tutorial",
        hp: action.hp,
        clans: action.clans,
        decks: action.decks,
        state: freshState(action.hp),
      };
    case "deck/deckReady": {
      const next = {
        ...flow,
        clans: withAt(flow.clans, flow.acting, action.clan),
        decks: withAt(flow.decks, flow.acting, action.deck),
      };
      return flow.acting === 0 ? toward(next, "deck", 1) : toward(next, "plan", 0);
    }
    case "handoff/handoffDone":
      return { ...flow, screen: flow.after.screen, acting: flow.after.acting, after: null };
    case "plan/planSealed": {
      const next = { ...flow, plans: withAt(flow.plans, flow.acting, action.plan) };
      return flow.acting === 0 ? toward(next, "plan", 1) : { ...next, screen: "playback" };
    }
    case "playback/resolved":
      return {
        ...flow,
        rounds: [...flow.rounds, { plans: flow.plans, events: action.events, state: action.state }],
        state: action.state,
        result: action.result,
        plans: [null, null],
      };
    case "playback/playbackDone":
      return flow.result === "ongoing" ? toward(flow, "plan", 0) : { ...flow, screen: "result" };
    case "result/rematch":
      return toward(
        { ...flow, state: freshState(flow.hp), rounds: [], plans: [null, null], result: "ongoing" },
        "plan",
        0,
      );
    case "result/newMatch":
      return initial;
    default:
      return flow;
  }
}

function freshState(hp) {
  const gnome = () => ({ hp, vulnerable: 0, strength: 0, spent: [] });
  return { round: 1, gnomes: [gnome(), gnome()] };
}

// toward moves to a screen for a player, through the hand-off curtain in hot-seat since the
// next player must not see what the current one sees.
function toward(flow, screen, acting) {
  if (flow.mode === "hotseat") return { ...flow, screen: "handoff", after: { screen, acting } };
  return { ...flow, screen, acting, after: null };
}

function withAt(list, index, value) {
  const out = [...list];
  out[index] = value;
  return out;
}
