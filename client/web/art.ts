// The illustration manifest, art/assets.json, looked up the way the page needs it. Both
// lookups return a display file name relative to art/, or undefined when none exists.

import * as v from "valibot";

const ManifestSchema = v.object({
  assets: v.array(v.object({ name: v.string(), clan: v.string(), kind: v.string(), display: v.string() })),
});

export type ArtIndex = { card(name: string): string | undefined; portrait(clan: string): string | undefined };

export function artIndex(manifest: unknown): ArtIndex {
  const { assets } = v.parse(ManifestSchema, manifest);
  const display = (kind: string, key: "name" | "clan") =>
    new Map(assets.filter((a) => a.kind === kind).map((a): [string, string] => [a[key], a.display]));
  const cards = display("card", "name");
  const portraits = display("portrait", "clan");
  return { card: (name) => cards.get(name), portrait: (clan) => portraits.get(clan) };
}
