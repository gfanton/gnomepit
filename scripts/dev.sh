#!/usr/bin/env bash
# Runs the gnodev command given as arguments, then deploys the arena on it from gnodev's
# test1 account once gnodev commits its first block. tx-indexer files genesis
# transactions at height 0, which gnotifd never reads, so an arena loaded at genesis
# would set its gnotif triggers where gnotifd cannot see them.
set -o errexit -o nounset -o pipefail

readonly RPC="${RPC:-127.0.0.1:36657}"
readonly CHAIN="${CHAIN:-gnomepit-dev}"
readonly ARENA_DIR="r/arena"
# gnodev premines test1 on every chain it starts; its mnemonic is public.
readonly MNEMONIC="source bonus chronic canvas draft south burst lottery vacant surface solve popular case indicate oppose farm nothing bullet exhibit title speed wink action roast"
# Seconds gnodev may take to commit its first block.
readonly START_TIMEOUT=120

if (($# == 0)); then
  echo "usage: dev.sh <gnodev command...>" >&2
  exit 2
fi

work="$(mktemp -d)"
"$@" &
readonly GNODEV_PID="$!"
trap 'kill "${GNODEV_PID}" 2>/dev/null || true; rm -rf "${work}"' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# height prints gnodev's latest committed block height, or 0 while its RPC does not answer.
height() {
  curl -sf "http://${RPC}/status" | jq -r '.result.sync_info.latest_block_height // 0' 2>/dev/null || echo 0
}

waited=0
until (($(height) >= 1)); do
  if ! kill -0 "${GNODEV_PID}" 2>/dev/null; then
    echo "Error: gnodev exited before its first block" >&2
    exit 1
  fi
  if ((waited >= START_TIMEOUT)); then
    echo "Error: gnodev committed no block within ${START_TIMEOUT}s" >&2
    exit 1
  fi
  sleep 1
  waited=$((waited + 1))
done

module=""
while IFS= read -r line; do
  if [[ "${line}" =~ ^module\ =\ \"(.+)\"$ ]]; then
    module="${BASH_REMATCH[1]}"
  fi
done <"${ARENA_DIR}/gnomod.toml"
if [[ -z "${module}" ]]; then
  echo "Error: ${ARENA_DIR}/gnomod.toml names no module" >&2
  exit 1
fi

pkg="${work}/arena"
mkdir -p "${pkg}"
cp "${ARENA_DIR}/gnomod.toml" "${pkg}/"
for f in "${ARENA_DIR}"/*.gno; do
  [[ "${f}" == *_test.gno ]] && continue
  cp "${f}" "${pkg}/"
done

printf '%s\n\n\n' "${MNEMONIC}" | gnokey add test1 --recover --insecure-password-stdin --home "${work}/keys" >/dev/null 2>&1
gnokey maketx addpkg -pkgpath "${module}" -pkgdir "${pkg}" -gas-fee 10000000ugnot -gas-wanted 500000000 \
  -max-deposit 100000000ugnot -broadcast -chainid "${CHAIN}" -remote "${RPC}" \
  -insecure-password-stdin -home "${work}/keys" test1 <<<""
echo "dev.sh: ${module} deployed"

wait "${GNODEV_PID}"
