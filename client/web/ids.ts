// Account addresses and match ids, branded so that neither passes for the other or for a
// plain string.

import * as v from "valibot";

const AddressSchema = v.pipe(v.string(), v.brand("Address"));
const MatchIdSchema = v.pipe(v.string(), v.brand("MatchId"));

export type Address = v.InferOutput<typeof AddressSchema>;
export type MatchId = v.InferOutput<typeof MatchIdSchema>;

// Neither checks a format: an id is whatever the chain or the realm calls it.
export function address(value: string): Address {
  return v.parse(AddressSchema, value);
}

export function matchId(value: string): MatchId {
  return v.parse(MatchIdSchema, value);
}
