#!/usr/bin/env bash
# One-click installer for hier-viewer.
#
# Run inside a checkout of the repository: builds and installs the current
# directory with `cargo install --path . --locked`.
# Run outside a checkout (e.g. piped from curl): downloads the latest prebuilt
# release binary from GitHub Releases, falling back to a cargo --git build.
#
# Usage:
#   ./install.sh [--prebuilt] [--to DIR] [--tag vX.Y.Z]
#   curl -fsSL https://raw.githubusercontent.com/cyril0124/hier-viewer/master/install.sh | bash

set -euo pipefail

REPO="cyril0124/hier-viewer"
BIN_NAME="hier-viewer"
INSTALL_DIR=""
TAG="latest"
FROM_SOURCE=0
PREFER_PREBUILT=0

die() { echo "install.sh: error: $*" >&2; exit 1; }
info() { echo "==> $*"; }

usage() {
  cat <<'EOF'
One-click installer for hier-viewer.

Inside a repository checkout (default): builds and installs the current
directory with `cargo install --path . --locked`. Outside a checkout (e.g.
piped from curl): downloads the latest prebuilt release binary, falling back
to a cargo --git build when no prebuilt asset exists or the download fails.

Usage:
  ./install.sh [--prebuilt] [--to DIR] [--tag vX.Y.Z] [--source]
  curl -fsSL https://raw.githubusercontent.com/cyril0124/hier-viewer/master/install.sh | bash

Notes:
  --prebuilt  skip the local build; download the prebuilt release binary even
              when a checkout is present
  --to DIR    install directory for the prebuilt binary (default: ~/.local/bin;
              ignored for cargo builds, which use cargo's own bin directory)
  --tag TAG   release tag to install (default: latest release); applies to the
              prebuilt download and to cargo --git builds; ignored for local
              checkout builds (they build whatever is checked out)
  --source    force a cargo build (local checkout when present, --git otherwise)
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --to)
      [ $# -ge 2 ] || die "--to requires a directory argument"
      INSTALL_DIR="$2"; shift 2 ;;
    --to=*) INSTALL_DIR="${1#*=}"; shift ;;
    --tag)
      [ $# -ge 2 ] || die "--tag requires a release tag argument (e.g. --tag v1.2.0)"
      TAG="$2"; shift 2 ;;
    --tag=*) TAG="${1#*=}"; shift ;;
    --source) FROM_SOURCE=1; shift ;;
    --prebuilt) PREFER_PREBUILT=1; shift ;;
    -h|--help)
      usage
      exit 0
      ;;
    *) die "unknown option '$1' (see --help)" ;;
  esac
done

# ---------------------------------------------------------------------------
# Detect a local repository checkout
#
# The checkout is the directory this script lives in; piped-from-curl runs
# have no script file, so they resolve to no checkout and use the remote
# paths. Verify Cargo.toml really is this project so an unrelated directory
# containing an install.sh copy is not mistaken for a checkout.
# ---------------------------------------------------------------------------
LOCAL_REPO_DIR=""
_script_dir="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" 2>/dev/null && pwd)" || true
if [ -n "$_script_dir" ] \
  && grep -qs '^name = "hier-viewer"' "${_script_dir}/Cargo.toml" 2>/dev/null; then
  LOCAL_REPO_DIR="$_script_dir"
fi

# ---------------------------------------------------------------------------
# Source build with cargo
#
# Installs into cargo's own bin directory (usually ~/.cargo/bin), so --to is
# not honored on this path. Requires cmake, ninja, a C++20 compiler, and the
# sqlite3 plus zlib development libraries for the embedded exporter.
# ---------------------------------------------------------------------------
build_from_source() {
  if ! command -v cargo >/dev/null 2>&1; then
    die "cargo not found; install Rust first:
  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
then rerun this installer"
  fi

  if [ -n "$LOCAL_REPO_DIR" ]; then
    info "Installing from local checkout: ${LOCAL_REPO_DIR}"
    if [ "$TAG" != "latest" ]; then
      echo "warning: --tag is ignored when building a local checkout" >&2
    fi
    info "First build also compiles the C++ exporter; expect 10-30 minutes"
    (cd "$LOCAL_REPO_DIR" && cargo install --path . --locked)
  else
    info "No local checkout; building latest sources from GitHub with cargo (expect 10-30 minutes)"
    # Pin the requested release tag; "latest" builds the default branch tip.
    if [ "$TAG" != "latest" ]; then
      cargo install --git "https://github.com/${REPO}.git" --tag "$TAG" --locked
    else
      cargo install --git "https://github.com/${REPO}.git" --locked
    fi
  fi
}

if [ "$FROM_SOURCE" -eq 1 ]; then
  build_from_source
  exit 0
fi

# Default inside a checkout: install the current directory's code.
if [ -n "$LOCAL_REPO_DIR" ] && [ "$PREFER_PREBUILT" -ne 1 ]; then
  build_from_source
  exit 0
fi

# ---------------------------------------------------------------------------
# Detect platform and pick the release asset
# ---------------------------------------------------------------------------
OS="$(uname -s)"
ARCH="$(uname -m)"
case "${OS}-${ARCH}" in
  Linux-x86_64)  ASSET_SUFFIX="x86_64-unknown-linux-gnu.tar.gz" ;;
  Darwin-x86_64) ASSET_SUFFIX="x86_64-apple-darwin.tar.gz" ;;
  Darwin-arm64)  ASSET_SUFFIX="aarch64-apple-darwin.tar.gz" ;;
  *)
    info "No prebuilt release for ${OS}-${ARCH}; falling back to source build"
    build_from_source
    exit 0
    ;;
esac

# ---------------------------------------------------------------------------
# Fetchers
# ---------------------------------------------------------------------------
if command -v curl >/dev/null 2>&1; then
  fetch() { curl -fsSL "$1"; }
  fetch_to() { curl -fsSL "$1" -o "$2"; }
  # Resolve a URL after redirects by printing the final location.
  final_url() { curl -fsSIL -o /dev/null -w '%{url_effective}' "$1" 2>/dev/null || true; }
elif command -v wget >/dev/null 2>&1; then
  fetch() { wget -qO- "$1"; }
  fetch_to() { wget -qO "$2" "$1"; }
  # Swallow network errors so tag resolution returns an empty string and
  # the caller can fall back to the API and source-build paths.
  final_url() { { wget -q --server-response --spider "$1" 2>&1 \
    | sed -n 's/.*[Ll]ocation:[[:space:]]*\([^[:space:]]*\).*/\1/p' | tail -n 1; } || true; }
else
  die "neither curl nor wget is installed"
fi

# Resolve the latest release tag by following the releases/latest redirect.
# This avoids the rate-limited GitHub API; returns an empty string on failure.
resolve_latest_tag() {
  final_url "https://github.com/${REPO}/releases/latest" \
    | sed -n 's#.*/releases/tag/\([^/]*\)$#\1#p' | head -n 1
}

# ---------------------------------------------------------------------------
# Resolve the release tag
# ---------------------------------------------------------------------------
if [ "$TAG" = "latest" ]; then
  info "Resolving latest release from GitHub"
  TAG="$(resolve_latest_tag)"
  if [ -z "$TAG" ]; then
    # Redirect resolution failed; try the API as a fallback (it may itself be
    # rate-limited). The API returns JSON; extract "tag_name" without jq,
    # matching the exact key so other string fields cannot match.
    TAG="$(fetch "https://api.github.com/repos/${REPO}/releases/latest" \
      | sed -n 's/.*"tag_name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n 1 || true)"
  fi
  if [ -z "$TAG" ]; then
    info "Failed to resolve the latest release tag; falling back to source build"
    build_from_source
    exit 0
  fi
fi
ASSET="${BIN_NAME}-${TAG}-${ASSET_SUFFIX}"
info "Installing ${BIN_NAME} ${TAG} (${ASSET})"

# ---------------------------------------------------------------------------
# Pick the install directory (default: ~/.local/bin, created if missing)
# ---------------------------------------------------------------------------
if [ -z "$INSTALL_DIR" ]; then
  INSTALL_DIR="${HOME}/.local/bin"
fi

mkdir -p "$INSTALL_DIR" || die "cannot create install directory '${INSTALL_DIR}'"
[ -w "$INSTALL_DIR" ] || die "'${INSTALL_DIR}' is not writable (try: sudo ./install.sh --to /usr/local/bin)"

# ---------------------------------------------------------------------------
# Download and extract
# ---------------------------------------------------------------------------
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

info "Downloading ${ASSET}"
if ! fetch_to "https://github.com/${REPO}/releases/download/${TAG}/${ASSET}" "$TMP_DIR/$ASSET"; then
  # Download failure is usually a network or missing-asset problem; cargo
  # fetches from the same host, but still give it a chance before giving up.
  info "Download failed for ${ASSET}; falling back to source build"
  build_from_source
  exit 0
fi

tar -xzf "$TMP_DIR/$ASSET" -C "$TMP_DIR" || die "failed to extract ${ASSET}"
BIN_PATH="$(find "$TMP_DIR" -type f -name "$BIN_NAME" | head -n 1)"
[ -n "$BIN_PATH" ] || die "'${BIN_NAME}' binary not found inside ${ASSET}"

# ---------------------------------------------------------------------------
# Install and verify
# ---------------------------------------------------------------------------
install -m 0755 "$BIN_PATH" "${INSTALL_DIR}/${BIN_NAME}"
info "Installed ${INSTALL_DIR}/${BIN_NAME}"

case ":${PATH}:" in
  # Colons as delimiters prevent partial directory-name matches.
  *":${INSTALL_DIR}:"*) ;;
  *)
    echo "warning: '${INSTALL_DIR}' is not in your PATH" >&2
    echo "         add it with:  echo 'export PATH=\"${INSTALL_DIR}:\$PATH\"' >> ~/.bashrc && source ~/.bashrc" >&2
    ;;
esac

"${INSTALL_DIR}/${BIN_NAME}" --help >/dev/null || die "installed binary failed to run (--help)"
info "Done. Try:  ${BIN_NAME} --output out --preview"
