#!/usr/bin/env bash
# Writes the engine, the standings realm and the arena, tests included, into the new
# directory given as $2 with their onyx paths: the namespace given as $1, a registered name
# such as nym-gfanton001 or a g1 address, gnotif's registry on onyx, and the page's GitHub
# Pages path at the start of every notification link. The standings realm's first writer,
# the arena, moves to that namespace with the rest.
set -o errexit -o nounset -o pipefail

readonly USAGE="usage: onyx-copy.sh <namespace or g1 address> <dir>"
readonly NAMESPACE="${1:?${USAGE}}"
readonly OUT="${2:?${USAGE}}"
readonly REGISTRY="gno.land/r/nym-gfanton001/gnotif/v1"
readonly PAGE_PATH="/gnomepit/"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
readonly ROOT

if [[ ! "${NAMESPACE}" =~ ^[a-z0-9-]+$ ]]; then
  echo "Error: ${NAMESPACE} is not a namespace or a g1 address" >&2
  exit 1
fi
if [[ -e "${OUT}" ]]; then
  echo "Error: ${OUT} already exists" >&2
  exit 1
fi

for pkg in p/engine r/standings r/standings/filetests r/arena r/arena/filetests; do
  [[ -d "${ROOT}/${pkg}" ]] || continue
  mkdir -p "${OUT}/${pkg}"
  for f in "${ROOT}/${pkg}"/*.gno "${ROOT}/${pkg}"/gnomod.toml; do
    [[ -e "${f}" ]] || continue
    sed -e "s#/gfanton/gnomepit/#/${NAMESPACE}/gnomepit/#g" \
      -e "s#gno.land/r/dev/gnotif/v1#${REGISTRY}#g" \
      -e "s#^const pagePath = \"/\"\$#const pagePath = \"${PAGE_PATH}\"#" "${f}" >"${OUT}/${pkg}/${f##*/}"
  done
done
: >"${OUT}/gnowork.toml"

if grep -rlE '/gfanton/gnomepit/|gno\.land/[pr]/gfanton/|gno\.land/r/dev/' "${OUT}" >&2; then
  echo "Error: the files above still name a local path" >&2
  exit 1
fi
if ! grep -q "^const pagePath = \"${PAGE_PATH}\"$" "${OUT}/r/arena/notify.gno"; then
  echo "Error: r/arena/notify.gno sets no pagePath to rewrite" >&2
  exit 1
fi
echo "onyx-copy.sh: wrote ${OUT}"
