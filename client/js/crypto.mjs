// Node's crypto as the gno clients call it, made from the browser's Web Crypto.
export default { randomFillSync: (bytes) => globalThis.crypto.getRandomValues(bytes) };
