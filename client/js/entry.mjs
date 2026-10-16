// What client/web/signer.mjs takes from the gno JS clients; make vendor bundles it into
// client/web/vendor/gno.mjs.
export { Tx, Wallet } from "@gnolang/tm2-js-client";
export { MsgCall, MsgCreateSession, MsgRevokeSession, decodeTxMessages } from "@gnolang/gno-js-client";
