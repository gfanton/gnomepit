// The gno clients' Wallet type names @cosmjs/ledger-amino, whose declarations import
// @ledgerhq/hw-transport, a package it installs only for its own development. The page
// never connects a Ledger, so the transport stays an opaque class.
declare module "@ledgerhq/hw-transport" {
  export default class Transport {}
}
