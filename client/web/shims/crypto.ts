// Node's crypto as the gno clients call it, made from the browser's Web Crypto.
export default {
  randomFillSync: (bytes: Uint8Array<ArrayBuffer>): Uint8Array<ArrayBuffer> => globalThis.crypto.getRandomValues(bytes),
};
