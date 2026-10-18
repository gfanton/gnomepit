// The gno clients' Wallet type imports @ledgerhq/hw-transport through @cosmjs/ledger-amino,
// which does not install it. The page never connects a Ledger, so an empty class stands in.
declare module "@ledgerhq/hw-transport" {
  export default class Transport {}
}
