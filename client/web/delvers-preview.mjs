import { escapeHTML } from "./keywords.mjs";
const emblem =
  '<svg viewBox="0 0 32 32" aria-hidden="true"><path d="M12 3h8M12 3 8 15M20 3l5 13M8 15l8-5 9 6-2 10-10 3-8-6ZM16 10l-3 8 6 2-6 9"/></svg>';
function riskText(text) {
  return escapeHTML(text).replace(/\bGain (\d+) Vulnerable\./g, '<span class="card__risk">Gain $1 Vulnerable.</span>');
}
const { cards } = await (await fetch("art/delvers-cards-v2.json")).json();
document.querySelector("#delvers-cards").innerHTML = cards
  .map(
    (c) =>
      `<article class="card card--delvers ${c.rarity === "Rare" ? "card--rare" : ""}" aria-label="${escapeHTML(c.name)}, ${c.rarity}"><span class="card__ornament" aria-hidden="true"></span><div class="card__head"><span class="card__cost" aria-label="${c.cost} beats">${c.cost}</span><span class="card__name">${escapeHTML(c.name)}</span></div><a class="card__art" href="art/${c.display}" aria-label="View ${escapeHTML(c.name)} artwork"><img src="art/${c.display}" alt=""></a><div class="card__text">${riskText(c.text)}</div><div class="card__foot"><span class="card__clan">${emblem}Delvers</span>${c.tier === "Slow" ? '<span class="badge">Slow</span>' : ""}<span class="badge ${c.rarity === "Rare" ? "badge--rare" : ""}">${c.rarity === "Rare" ? "★ " : ""}${c.rarity}</span></div></article>`,
  )
  .join("");
document.querySelectorAll("#delvers-cards img").forEach((img) =>
  img.addEventListener(
    "error",
    () => {
      const p = document.createElement("div");
      p.className = "art-placeholder";
      p.textContent = "Illustration is being prepared";
      img.replaceWith(p);
    },
    { once: true },
  ),
);
