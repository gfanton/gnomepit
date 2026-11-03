#!/usr/bin/env bash
# Plays one arena match against itself on a running `make dev`, as gnodev's test1
# account, and saves the decoded vm/qeval_json and vm/qtype_json answers after each
# move into the directory given as $1. The page modules' tests read these files. A
# match against itself is not rated, so the standings it saves are the ones a `make e2e`
# run left on the same chain: run that first on a fresh `make dev`.
set -o errexit -o nounset -o pipefail

readonly OUT="${1:?usage: capture.sh <out dir>}"
readonly RPC="${RPC:-127.0.0.1:36657}"
readonly CHAIN="${CHAIN:-gnomepit-dev}"
readonly ARENA="gno.land/r/gfanton/gnomepit/arena/v0"
readonly STANDINGS="gno.land/r/gfanton/gnomepit/standings/v0"
# gnodev premines test1 on every chain it starts; its mnemonic is public.
readonly MNEMONIC="source bonus chronic canvas draft south burst lottery vacant surface solve popular case indicate oppose farm nothing bullet exhibit title speed wink action roast"
readonly PLAYER="g1jg8mtutu9khhfwc4nxmuhcpftf0pajdhfvsqf5"
# The dev wallet's alice (client/web/devwallet.ts), who plays the e2e matches.
readonly ALICE="g1vzpn5tdhat0vy90eyqncs09474257tgz2uw09w"
readonly DECK_A="Pickaxe Flurry,Kneecap,Sling Stone,Dodge Roll,Chalk Dust,Double Tap,Momentum,Undermine"
readonly DECK_B="Stone Guard,Bulwark,Hammer Blow,Cobble Throw,Spiked Shield,Anvil Stomp,Feint,Avalanche"
readonly SALT_DECK="0101010101010101010101010101010101010101010101010101010101010101"
readonly SALT_1="1111111111111111111111111111111111111111111111111111111111111111"
readonly SALT_2="2222222222222222222222222222222222222222222222222222222222222222"
readonly SALT_3="3333333333333333333333333333333333333333333333333333333333333333"
readonly PICKS="Pick,Pick,Pick"
readonly BRACES="Brace,Brace,Brace"

home="$(mktemp -d)"
trap 'rm -rf "${home}"' EXIT

# seal prints the hex sha256 of salt $1's bytes followed by text $2.
seal() {
  local sum
  sum="$({ printf '%s' "$1" | xxd -r -p; printf '%s' "$2"; } | shasum -a 256)"
  printf '%s' "${sum%% *}"
}

# query saves the decoded answer of abci path $1 for data $2 as $OUT/$3.json.
query() {
  local data
  data="$(printf '%s' "$2" | base64 | tr -d '\n')"
  curl -sf -X POST "http://${RPC}/" -H 'Content-Type: application/json' \
    -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"abci_query\",\"params\":{\"path\":\"$1\",\"data\":\"${data}\"}}" |
    jq -r '.result.response.ResponseBase.Data' | base64 -d | jq . >"${OUT}/$3.json"
}

# call runs arena function $1 with the remaining arguments and prints gnokey's output.
call() {
  local fn="$1" arg
  shift
  local args=()
  for arg in "$@"; do
    args+=(-args "${arg}")
  done
  gnokey maketx call -pkgpath "${ARENA}" -func "${fn}" "${args[@]}" \
    -gas-fee 1000000ugnot -gas-wanted 300000000 -broadcast -chainid "${CHAIN}" \
    -remote "${RPC}" -insecure-password-stdin -home "${home}" -quiet test1 <<<""
}

snapshot() {
  query vm/qeval_json "${ARENA}.Match(\"${id}\")" "match-$1"
}

mkdir -p "${OUT}"
printf '%s\n\n\n' "${MNEMONIC}" | gnokey add test1 --recover --insecure-password-stdin --home "${home}" >/dev/null 2>&1

out="$(call Challenge Pickers "$(seal "${SALT_DECK}" "${DECK_A}")" "$(seal "${SALT_1}" "${PICKS}")" box1 "")"
[[ "${out}" =~ \(\"([0-9]+)\"\ string\) ]] || { echo "Error: no match id in: ${out}" >&2; exit 1; }
id="${BASH_REMATCH[1]}"
query vm/qeval_json "${ARENA}.Open(0, 50)" open
snapshot open

call Accept "${id}" Ironhide "${DECK_B}" "${BRACES}" >/dev/null
snapshot reveal
call Reveal "${id}" "${DECK_A}" "${SALT_DECK}" "${PICKS}" "${SALT_1}" "$(seal "${SALT_2}" "${PICKS}")" box2 >/dev/null
snapshot play
call Play "${id}" "${BRACES}" >/dev/null
call Reveal "${id}" "" "" "${PICKS}" "${SALT_2}" "$(seal "${SALT_3}" "${PICKS}")" box3 >/dev/null
call Play "${id}" "${BRACES}" >/dev/null
call Reveal "${id}" "" "" "${PICKS}" "${SALT_3}" "" "" >/dev/null
snapshot ended
query vm/qeval_json "${ARENA}.Matches(\"${PLAYER}\", 0, 50)" matches
query vm/qeval_json "${STANDINGS}.Leaderboard(0, 50)" leaderboard
query vm/qeval_json "${STANDINGS}.StandingOf(\"${ALICE}\")" standing-rated
query vm/qeval_json "${STANDINGS}.StandingOf(\"${PLAYER}\")" standing-unrated
query vm/qeval_json "${STANDINGS}.RatedPlayers()" rated-players
query vm/qeval_json "${STANDINGS}.ClanStandings()" clan-standings

for type in OpenChallenge MatchSummary MatchView; do
  query vm/qtype_json "${ARENA}.${type}" "qtype-${type}"
done
for type in Standing ClanStanding; do
  query vm/qtype_json "${STANDINGS}.${type}" "qtype-${type}"
done
