#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
PREPARE_SCRIPT="${SCRIPT_DIR}/prepare_openpiton_sources.py"
FILELIST_PATH="${SCRIPT_DIR}/generated/openpiton-chip.f"
OPENPITON_DIR="${SCRIPT_DIR}/openpiton"
OUT_DIR="${HIER_VIEWER_EXAMPLE_OUT:-${SCRIPT_DIR}/out}"

if [[ ! -d "${OPENPITON_DIR}/piton" ]]; then
  echo "OpenPiton submodule is missing." >&2
  echo "Run: git submodule update --init --recursive examples/openpiton-example/openpiton" >&2
  exit 1
fi

if [[ -x "${REPO_ROOT}/target/release/hier-viewer" ]]; then
  VIEWER_BIN="${REPO_ROOT}/target/release/hier-viewer"
elif command -v hier-viewer >/dev/null 2>&1; then
  VIEWER_BIN="$(command -v hier-viewer)"
else
  echo "Cannot find hier-viewer. Build it first with: cargo build --release" >&2
  exit 1
fi

python3 "${PREPARE_SCRIPT}"

OPENPITON_COMMIT="$(git -C "${OPENPITON_DIR}" rev-parse HEAD)"
mkdir -p "${OUT_DIR}"

VIEWER_ARGS=(
  --no-wizard
  -f "${FILELIST_PATH}"
  --output "${OUT_DIR}"
)

if [[ "${HIER_VIEWER_EXAMPLE_PREVIEW:-1}" == "1" ]]; then
  VIEWER_ARGS+=(--preview)
fi

if [[ "$#" -gt 0 ]]; then
  VIEWER_ARGS+=("$@")
fi

echo "OpenPiton commit: ${OPENPITON_COMMIT}"
echo "Tiles: 2x2 (4 total)"
echo "Top module: chip"
echo "Output directory: ${OUT_DIR}"

exec "${VIEWER_BIN}" "${VIEWER_ARGS[@]}" -- --top chip --single-unit
