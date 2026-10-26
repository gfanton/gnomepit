#!/usr/bin/env bash
# Writes the engine and the arena, tests included, into the new directory given as $2 with
# their onyx paths: the namespace of the address given as $1, gnotif's registry on onyx, and
# the page's GitHub Pages path at the start of every notification link.
set -o errexit -o nounset -o pipefail

readonly USAGE="usage: onyx-copy.sh <g1 address> <dir>"
readonly ADDRESS="${1:?${USAGE}}"
readonly OUT="${2:?${USAGE}}"
readonly REGISTRY="gno.land/r/nym-gfanton001/gnotif/v1"
readonly PAGE_PATH="/gnomepit/"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
readonly ROOT

if [[ ! "${ADDRESS}" =~ ^g1[0-9a-z]{38}$ ]]; then
  echo "Error: ${ADDRESS} is not a g1 address" >&2
  exit 1
fi
if [[ -e "${OUT}" ]]; then
  echo "Error: ${OUT} already exists" >&2
  exit 1
fi

for pkg in p/engine r/arena r/arena/filetests; do
  mkdir -p "${OUT}/${pkg}"
  for f in "${ROOT}/${pkg}"/*.gno "${ROOT}/${pkg}"/gnomod.toml; do
    [[ -e "${f}" ]] || continue
    sed -e "s#/gfanton/gnomepit/#/${ADDRESS}/gnomepit/#g" \
      -e "s#gno.land/r/dev/gnotif/v1#${REGISTRY}#g" \
      -e "s#^const pagePath = \"/\"\$#const pagePath = \"${PAGE_PATH}\"#" "${f}" >"${OUT}/${pkg}/${f##*/}"
  done
done
: >"${OUT}/gnowork.toml"

if grep -rlE '/gfanton/gnomepit/|gno\.land/r/dev/' "${OUT}" >&2; then
  echo "Error: the files above still name a local path" >&2
  exit 1
fi
if ! grep -q "^const pagePath = \"${PAGE_PATH}\"$" "${OUT}/r/arena/notify.gno"; then
  echo "Error: r/arena/notify.gno sets no pagePath to rewrite" >&2
  exit 1
fi
echo "onyx-copy.sh: wrote ${OUT}"
