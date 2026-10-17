// The illustration manifest, art/assets.json, looked up the way the page needs it. Both
// lookups return a display file name relative to art/, or undefined when none exists.

export function artIndex(manifest) {
  const display = (kind, key) =>
    new Map(manifest.assets.filter((a) => a.kind === kind).map((a) => [a[key], a.display]));
  const cards = display("card", "name");
  const portraits = display("portrait", "clan");
  return { card: (name) => cards.get(name), portrait: (clan) => portraits.get(clan) };
}
