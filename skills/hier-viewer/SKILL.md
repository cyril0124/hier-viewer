---
name: hier-viewer
description: Use when asked to inspect RTL hierarchy with hier-viewer or generate a one-command viewer launch script with remote HTTP access.
disable-model-invocation: true
---

# Hier-viewer launch scripts

Deliver an executable `.hier-viewer/view-<slug>.sh` in the target project. Running it generates a viewer bundle in `.hier-viewer/<slug>/` and serves that bundle on `0.0.0.0`. The target project is the RTL workspace, not necessarily the directory containing this skill.

## 1. Resolve the design and executable

Inspect the project's build scripts and filelists before choosing inputs. Establish the project root, RTL paths or filelists, top module, include directories, defines, and required generated sources. Preserve file order and the original build's path semantics. Prefer an existing filelist or explicit paths over a workspace-wide glob. Ask one focused question only if the files cannot resolve the intended design/configuration.

Use `hier-viewer` from PATH when available. Otherwise locate an existing project-local binary and use its project-relative path, or an absolute path for an external installation. Run that exact executable with `--help` and verify the flags used below. If no executable is available, stop with an installation prerequisite; do not hide installation, network downloads, or a Cargo build in the launch script. Release binaries are available at <https://github.com/cyril0124/hier-viewer/releases/latest>.

Choose one input mode:

- RTL: explicit sources and/or repeated `--filelist`; pass verified top/include/define options after `--`.
- Database: `--db` with a readable SQLite hierarchy database, without RTL, filelists, or compiler arguments. Source files referenced by the database must still be readable when generating the bundle. This mode does not reparse changed RTL.

Completion: the executable and all inputs are concrete and verified, with no guessed top or unresolved generated-source prerequisite.

## 2. Generate the script

Choose a short design/configuration slug matching `[a-z0-9]+(-[a-z0-9]+)*`. Inspect existing paths before writing; preserve unrelated scripts and bundles. Different configurations need different slugs.

Use the template below, replacing `design`, the executable, input array, and compiler array with the discovered values. All example paths and names must be replaced before delivery. For database mode, use `inputs=(--db 'path/to/hiers.db')` and `compiler_args=()`.

```bash
#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
PROJECT_ROOT=$(cd -- "$SCRIPT_DIR/.." && pwd)
cd -- "$PROJECT_ROOT"

SLUG='design'
VIEWER='hier-viewer'
inputs=(--filelist 'rtl/files.f')
compiler_args=(--top 'Top' -I 'rtl/include' -D 'SYNTHESIS=1')

if ! command -v -- "$VIEWER" >/dev/null 2>&1; then
  printf 'hier-viewer executable unavailable: %s\n' "$VIEWER" >&2
  exit 1
fi

args=(
  --no-wizard
  --output "$SCRIPT_DIR/$SLUG"
  --title "$SLUG"
  --preview
  --preview-host 0.0.0.0
  --preview-port 8000
  "${inputs[@]}"
)
if ((${#compiler_args[@]})); then
  args+=(-- "${compiler_args[@]}")
fi

printf 'Bundle: %s\n' "$SCRIPT_DIR/$SLUG"
printf 'Network exposure: all interfaces; bundled RTL sources are accessible without authentication.\n'
exec "$VIEWER" "${args[@]}"
```

Keep the script directly under `.hier-viewer/`, outside the served bundle directory. Quote paths and use Bash arrays, not `eval` or command strings. Quote wildcard inputs so hier-viewer expands them. Resolve relative paths against the project root; when existing build inputs assume another working directory, explicitly preserve that directory and adjust the input paths accordingly.

Use a fixed output directory for cache reuse. RTL export caches live under `<output>/.hier-viewer-cache/`; do not delete them or force `--rebuild-sqlite` on every launch. If input preparation is required, keep generated filelists and supporting files in `.hier-viewer/`, outside served bundles. Preserve original RTL and filelists; do not silently patch a design or drop files to suppress exporter errors.

Use the user's requested starting port, otherwise the template default. The built-in server increments occupied ports and prints the actual URL. Keep the process in the foreground with `exec`; `Ctrl-C` stops it. No second HTTP server, daemon, or PID manager is needed.

Completion: `chmod +x .hier-viewer/view-<slug>.sh` and `bash -n .hier-viewer/view-<slug>.sh` succeed; the file has concrete inputs and no placeholders.

## 3. Verify and deliver

Run the generated script from outside the project root. Under an agent harness, use its managed process tool and a readiness notification matching `on 0.0.0.0:`; do not leave an unmanaged background process. Verify:

1. Export succeeds and the bundle contains nonempty `index.html`, `viewer-meta.json`, and `viewer-core.bin`.
2. The startup log reports binding to `0.0.0.0`. Use its actual port for HTTP checks, not the requested port. Fetch the index, metadata, core data, JS modules, and a bundled source over HTTP; compare responses with the generated files.
3. Stop the test server and rerun the unchanged script. In RTL mode, confirm the log reports cache reuse. Confirm both launches write to the same bundle directory even from different working directories.

A local interactive terminal attempts to open the browser. SSH and noninteractive sessions print a URL instead; lack of a desktop does not prevent serving. For remote access, replace `127.0.0.1` in the printed URL with the server's reachable IP or hostname. `0.0.0.0` is a bind address, not the browser destination. Firewall rules can still prevent access, and this server provides neither authentication nor TLS. State that bundled source code is exposed to hosts that can reach the port.

Stop verification processes and remove only temporary verification files. Keep the delivered script and its intended bundle/cache. If the user also requested a running deployment, leave the managed service running and report its actual URL and stop mechanism. Otherwise deliver the script path and the one command `./.hier-viewer/view-<slug>.sh`. Report HTTP verification separately from browser auto-opening and external reachability; mark anything not tested as unverified.
