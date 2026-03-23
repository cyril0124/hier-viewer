#!/usr/bin/env bash

set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd -- "${script_dir}/../.." && pwd)"

if [[ -x "${repo_root}/target/release/hier-viewer" ]]; then
  hier_viewer="${repo_root}/target/release/hier-viewer"
else
  hier_viewer="$(command -v hier-viewer)"
fi

if [[ -z "${hier_viewer:-}" ]]; then
  echo "error: hier-viewer not found; build target/release/hier-viewer or add it to PATH" >&2
  exit 1
fi

out_dir="${HIER_VIEWER_EXAMPLE_OUT:-${repo_root}/examples/ibex-example/out-core}"
preview_args=()
if [[ "${HIER_VIEWER_EXAMPLE_PREVIEW:-1}" != "0" ]]; then
  preview_args+=(--preview)
fi

cd "${repo_root}"
exec "${hier_viewer}" \
  -f examples/ibex-example/ibex-core.f \
  --output "${out_dir}" \
  "${preview_args[@]}" \
  "$@" \
  -- \
  --top ibex_top \
  --single-unit
