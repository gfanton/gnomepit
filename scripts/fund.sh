#!/usr/bin/env bash
# Sends 1,000 GNOT on a running `make dev` from gnodev's test1 account to the address
# given as $1, so a wallet such as Adena can play there.
set -o errexit -o nounset -o pipefail

readonly TO="${1:?usage: fund.sh <address>}"
readonly RPC="${RPC:-127.0.0.1:36657}"
# gnodev premines test1 on every chain it starts; its mnemonic is public.
readonly MNEMONIC="source bonus chronic canvas draft south burst lottery vacant surface solve popular case indicate oppose farm nothing bullet exhibit title speed wink action roast"

home="$(mktemp -d)"
trap 'rm -rf "${home}"' EXIT

printf '%s\n\n\n' "${MNEMONIC}" | gnokey add test1 --recover --insecure-password-stdin --home "${home}" >/dev/null 2>&1
gnokey maketx send -send 1000000000ugnot -to "${TO}" -gas-fee 1000000ugnot -gas-wanted 10000000 \
  -broadcast -chainid dev -remote "${RPC}" -insecure-password-stdin -home "${home}" test1 <<<""
