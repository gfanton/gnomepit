// Loads the engine's WebAssembly and wraps the JSON functions it registers as
// globalThis.gnomehall. wasm_exec.js, loaded by the page first, defines globalThis.Go.

export async function loadEngine(wasmUrl, cardsUrl) {
  const go = new globalThis.Go();
  const { instance } = await WebAssembly.instantiateStreaming(fetch(wasmUrl), go.importObject);
  go.run(instance);
  await untilDefined(() => globalThis.gnomehall);

  const call = (name) => (request) => {
    const response = JSON.parse(globalThis.gnomehall[name](JSON.stringify(request)));
    if (response.error) throw new Error(response.error);
    return response;
  };
  const cardsText = await (await fetch(cardsUrl)).text();
  const view = JSON.parse(globalThis.gnomehall.load(cardsText));
  if (view.error) throw new Error(view.error);

  return {
    hp: view.hp,
    cards: view.cards,
    clans: view.clans,
    legalDeck: (request) => call("legalDeck")(request).legal,
    legalPlans: (request) => call("legalPlans")(request).plans,
    resolve: call("resolve"),
  };
}

function untilDefined(read) {
  return new Promise((resolve) => {
    const check = () => (read() === undefined ? setTimeout(check, 0) : resolve());
    check();
  });
}
