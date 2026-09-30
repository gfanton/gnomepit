// Test fixture mirroring client/web/cards.json: the card view and the two clans.

const def = (id, name, cost, tier, extra = {}) => ({
  id, name, cost, tier, special: id > 1, rare: false, interrupt: false, parry: 0, text: "", ...extra,
});

export const cards = [
  def(0, "Pick", 1, "Normal"),
  def(1, "Brace", 1, "Normal"),
  def(2, "Pickaxe Flurry", 1, "Quick"),
  def(3, "Kneecap", 1, "Quick", { interrupt: true }),
  def(4, "Sling Stone", 1, "Normal"),
  def(5, "Dodge Roll", 2, "Normal", { parry: 1 }),
  def(6, "Chalk Dust", 1, "Quick"),
  def(7, "Double Tap", 2, "Normal"),
  def(8, "Momentum", 1, "Normal"),
  def(9, "Undermine", 1, "Quick", { rare: true, interrupt: true }),
  def(10, "Hunker Down", 3, "Normal", { parry: 2 }),
  def(11, "Boot and Heel", 2, "Slow"),
  def(12, "Stone Guard", 3, "Normal", { parry: 2 }),
  def(13, "Bulwark", 2, "Normal"),
  def(14, "Hammer Blow", 2, "Slow"),
  def(15, "Cobble Throw", 1, "Slow"),
  def(16, "Spiked Shield", 1, "Normal"),
  def(17, "Anvil Stomp", 2, "Slow"),
  def(18, "Feint", 2, "Normal"),
  def(19, "Avalanche", 1, "Slow", { rare: true }),
  def(20, "Shield Catch", 2, "Normal"),
  def(21, "Loose Timbers", 2, "Normal"),
];

export const pickers = { name: "Pickers", cards: [2, 3, 4, 5, 6, 7, 8, 9, 10, 11] };
export const ironhide = { name: "Ironhide", cards: [12, 13, 14, 15, 16, 17, 18, 19, 20, 21] };

export const id = (name) => cards.find((c) => c.name === name).id;
