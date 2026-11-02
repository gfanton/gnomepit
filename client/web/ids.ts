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

const bech32 = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
const generator = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];

// isAccountAddress holds for a gno.land account address as the realm accepts one: "g1" and 38
// lowercase bech32 characters, 20 bytes and a 6-character checksum, the checksum matching.
export function isAccountAddress(value: string): boolean {
  if (!/^g1[qpzry9x8gf2tvdw0s3jn54khce6mua7l]{38}$/.test(value)) return false;
  // The checksum covers the expanded prefix "g", a 0, then every data character.
  const values = [
    3,
    0,
    7,
    ...value
      .slice(2)
      .split("")
      .map((c) => bech32.indexOf(c)),
  ];
  let check = 1;
  for (const v of values) {
    const top = check >>> 25;
    check = ((check & 0x1ffffff) << 5) ^ v;
    generator.forEach((g, i) => {
      if (((top >>> i) & 1) === 1) check ^= g;
    });
  }
  return check === 1;
}
