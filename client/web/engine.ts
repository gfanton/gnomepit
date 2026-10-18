// Loads the engine's WebAssembly and wraps the JSON functions it registers as
// globalThis.gnomehall. wasm_exec.js, loaded by the page first, defines globalThis.Go.

import * as v from "valibot";

declare global {
  // wasm_exec.js's runtime for one Go WebAssembly module.
  type Go = { importObject: WebAssembly.Imports; run(instance: WebAssembly.Instance): Promise<void> };
  var Go: new () => Go;
  // Each function takes one JSON request and returns one JSON reply; undefined until the
  // engine module runs.
  var gnomehall: Record<"load" | "legalDeck" | "legalPlans" | "resolve", (json: string) => string> | undefined;
}

// The schemas follow client/bridge/wire.go. Card ids index the ruleset's card list.

const TierSchema = v.picklist(["Quick", "Normal", "Slow"]);
const SideSchema = v.picklist([0, 1]);

const CardSchema = v.object({
  id: v.number(),
  name: v.string(),
  cost: v.number(),
  tier: TierSchema,
  special: v.boolean(),
  rare: v.boolean(),
  interrupt: v.boolean(),
  parry: v.number(),
  text: v.string(),
});

const ClanSchema = v.object({ name: v.string(), cards: v.array(v.number()) });

const GnomeSchema = v.object({
  hp: v.number(),
  vulnerable: v.number(),
  strength: v.number(),
  spent: v.array(v.number()),
});

const GameStateSchema = v.object({ round: v.number(), gnomes: v.tuple([GnomeSchema, GnomeSchema]) });

const VitalsSchema = v.object({
  hp: v.number(),
  block: v.number(),
  counter: v.number(),
  vulnerable: v.number(),
  strength: v.number(),
});

const BattleEventSchema = v.object({
  beat: v.number(),
  phase: v.picklist(["Interrupt", "Block", "Damage"]),
  tier: TierSchema,
  step: v.number(),
  // The engine's EventKind constant name.
  kind: v.string(),
  side: SideSchema,
  card: v.number(),
  n: v.number(),
  blocked: v.number(),
  doubled: v.boolean(),
  after: v.tuple([VitalsSchema, VitalsSchema]),
});

const ResolutionSchema = v.object({
  state: GameStateSchema,
  result: v.picklist(["ongoing", "a", "b", "draw"]),
  events: v.array(BattleEventSchema),
});

const RulesetSchema = v.object({ hp: v.number(), cards: v.array(CardSchema), clans: v.array(ClanSchema) });
const LegalDeckSchema = v.object({ legal: v.boolean() });
const LegalPlansSchema = v.object({ plans: v.array(v.array(v.number())) });
const FailureSchema = v.object({ error: v.string() });

export type Side = v.InferOutput<typeof SideSchema>;
export type Card = v.InferOutput<typeof CardSchema>;
export type Clan = v.InferOutput<typeof ClanSchema>;
export type Gnome = v.InferOutput<typeof GnomeSchema>;
export type GameState = v.InferOutput<typeof GameStateSchema>;
export type Vitals = v.InferOutput<typeof VitalsSchema>;
export type BattleEvent = v.InferOutput<typeof BattleEventSchema>;
export type Resolution = v.InferOutput<typeof ResolutionSchema>;

export type LegalDeckRequest = { clan: string; deck: number[] };
export type LegalPlansRequest = { state: GameState; side: Side; deck: number[] };
export type ResolveRequest = { state: GameState; decks: [number[], number[]]; a: number[]; b: number[] };

export type Engine = {
  hp: number;
  cards: Card[];
  clans: Clan[];
  legalDeck(r: LegalDeckRequest): boolean;
  legalPlans(r: LegalPlansRequest): number[][];
  resolve(r: ResolveRequest): Resolution;
};

export function otherSide(side: Side): Side {
  return side === 0 ? 1 : 0;
}

// startState is the state round 1 starts from, each gnome at hp.
export function startState(hp: number): GameState {
  const gnome = () => ({ hp, vulnerable: 0, strength: 0, spent: [] });
  return { round: 1, gnomes: [gnome(), gnome()] };
}

// cardOf looks a card up by its id; an id outside the card list throws.
export function cardOf(cards: Card[], id: number): Card {
  const card = cards[id];
  if (card === undefined) throw new RangeError(`no card has id ${id}`);
  return card;
}

export async function loadEngine(wasmUrl: string, cardsUrl: string): Promise<Engine> {
  const go = new globalThis.Go();
  const { instance } = await WebAssembly.instantiateStreaming(fetch(wasmUrl), go.importObject);
  return startEngine(go, instance, await (await fetch(cardsUrl)).text());
}

// startEngine runs an instantiated engine module with the card file's text and returns
// the rules.
export async function startEngine(go: Go, instance: WebAssembly.Instance, cardsText: string): Promise<Engine> {
  void go.run(instance);
  const bridge = await untilDefined(() => globalThis.gnomehall);

  const call = <T>(
    name: "legalDeck" | "legalPlans" | "resolve",
    schema: v.GenericSchema<unknown, T>,
    request: unknown,
  ) => reply(name, bridge[name](JSON.stringify(request)), schema);
  const view = reply("load", bridge.load(cardsText), RulesetSchema);

  return {
    hp: view.hp,
    cards: view.cards,
    clans: view.clans,
    legalDeck: (request) => call("legalDeck", LegalDeckSchema, request).legal,
    legalPlans: (request) => call("legalPlans", LegalPlansSchema, request).plans,
    resolve: (request) => call("resolve", ResolutionSchema, request),
  };
}

// reply reads one bridge reply: {"error": message} throws that message, and a reply its
// schema refuses throws naming the call.
function reply<T>(name: string, json: string, schema: v.GenericSchema<unknown, T>): T {
  const response: unknown = JSON.parse(json);
  const failure = v.safeParse(FailureSchema, response);
  if (failure.success) throw new Error(failure.output.error);
  const parsed = v.safeParse(schema, response);
  if (!parsed.success) throw new Error(`engine ${name} gave an unexpected reply: ${v.summarize(parsed.issues)}`);
  return parsed.output;
}

function untilDefined<T>(read: () => T | undefined): Promise<T> {
  return new Promise((resolve) => {
    const check = (): void => {
      const value = read();
      if (value === undefined) setTimeout(check, 0);
      else resolve(value);
    };
    check();
  });
}
