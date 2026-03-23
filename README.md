# hier-viewer

[中文说明](README.zh-CN.md)

A static hierarchy viewer for large RTL designs.

`hier-viewer` uses Rust to generate the frontend bundle and an embedded `slang-hier-exporter` binary to extract hierarchy, module statistics, source locations, and analysis data from RTL or from a prebuilt sqlite hierarchy database. The final output is a directory that can be served by any static file server.

The generated viewer supports:

- Treemap, 2D Pie, and 3D main views
- hierarchy drill-down, tree panel, and matches panel
- source reader for both instance locations and module definitions
- filter, analysis pattern, LOC, and weighted signal bits
- persisted UI settings, bookmarks, and collapse state

If you are using it for the first time, read `Quick Start` and `Common Commands` first.

Unless noted otherwise, the command examples below assume `rust-hier-viewer` is already available on your `PATH`.
If you are running directly from the source tree, replace `rust-hier-viewer` with `./target/release/rust-hier-viewer`.

## Quick Start

### 1. Build

```bash
cargo build --release
```

The first build can take a while. That is expected. `build.rs` automatically:

1. Configures and builds a static `slang-hier-exporter`
2. Embeds that exporter into the Rust executable
3. Copies a sibling exporter binary into `target/{debug,release}/` for local debugging

By default it uses CMake `FetchContent` to fetch and build `slang`.

### 2. Run

```bash
./target/release/rust-hier-viewer --output out --preview
```

If you are on an interactive terminal and do not provide RTL inputs, filelists, or `--db`, the tool opens the built-in TUI wizard. The wizard lets you:

- add RTL paths
- choose path match mode: `Literal`, `Wildcard`, or `Regex`
- add filelists
- append extra compiler flags such as `-I`, `-D`, `+incdir+`, and `--top`

### 3. Open the generated viewer

This starts a built-in local preview server, prints the final viewer URL, and by default tries to open a browser on local desktop sessions.

If you use VSCode Remote or Live Server, serving the output directory directly is still a valid fallback.

## Requirements

### To build and run `rust-hier-viewer`

- Rust toolchain
- `cmake`
- `ninja`
- a C++20 compiler

### When building the embedded exporter for the first time

By default the build fetches:

- [MikePopoloski/slang](https://github.com/MikePopoloski/slang)

If your environment cannot access the network, or if you want to force a local `slang` checkout, set:

```bash
export HIER_VIEWER_EXPORTER_SLANG_SOURCE_DIR=/path/to/slang
```

Static linking is enabled by default where possible. To disable it:

```bash
export HIER_VIEWER_EXPORTER_FULLY_STATIC=0
```

## Input Modes

The viewer has two main input modes.

### 1. Build from RTL

You can pass RTL files, wildcard patterns, and filelists directly to the viewer. It internally runs:

```text
slang-hier-exporter --sqlite
```

to create or reuse a sqlite cache, then emits the HTML bundle.

Notes:

- command-line positional RTL inputs `[rtl ...]` currently use `Wildcard` semantics, while still accepting exact file paths
- if you want `Regex` mode for RTL selection, the built-in TUI wizard is the better path

### 2. Read an existing sqlite DB

If you already have a prebuilt hierarchy sqlite DB:

```bash
rust-hier-viewer --db path/to/hiers.db --output out --preview
```

In this mode the tool does not reparse RTL.

## Common Commands

### Example 1: recommended first run, open the wizard

```bash
rust-hier-viewer --output out --preview
```

This is the easiest way to start, especially when you have many RTL paths, filelists, `+incdir+`, and `-D` flags.

### Example 2: pass RTL files directly

```bash
rust-hier-viewer \
  rtl/top.sv \
  rtl/core.sv \
  --output out \
  --preview
```

### Example 3: use wildcard RTL inputs

Quote the patterns so the viewer resolves them itself instead of your shell expanding them first.

```bash
rust-hier-viewer \
  'rtl/**/*.sv' \
  'tb/**/*.v' \
  --output out \
  --preview
```

### Example 4: RTL plus extra slang flags

Everything after `--` is passed through to `slang-hier-exporter` / the slang driver.

```bash
rust-hier-viewer \
  'rtl/**/*.sv' \
  --output out \
  -- \
  --top Top \
  -I rtl/include \
  -D SYNTHESIS=1 \
  +incdir+third_party/include
```

### Example 5: use filelists

```bash
rust-hier-viewer \
  -f rtl/files.f \
  -f tb/files.f \
  --output out \
  -- \
  --top SimTop
```

### Example 6: mix filelists and positional RTL inputs

```bash
rust-hier-viewer \
  -f rtl/files.f \
  'rtl/generated/**/*.sv' \
  --output out \
  -- \
  +incdir+rtl/include
```

### Example 7: force rebuilding the sqlite cache

Use this when you know the RTL, filelists, or extra flags changed, or when you simply want a full rebuild:

```bash
rust-hier-viewer \
  -r \
  'rtl/**/*.sv' \
  --output out \
  -- \
  --top Top
```

### Example 8: read an existing sqlite DB

```bash
rust-hier-viewer \
  --db path/to/hiers.db \
  --output out
```

### Example 9: disable the wizard and require explicit CLI inputs

```bash
rust-hier-viewer \
  --no-wizard \
  'rtl/**/*.sv' \
  --output out \
  -- \
  --top Top
```

### Example 10: enable debug overlays

```bash
rust-hier-viewer \
  --db path/to/hiers.db \
  --output out \
  --debug
```

`--debug` enables extra viewer overlays such as UI labels.

### Example 11: use the release binary

```bash
./target/release/rust-hier-viewer \
  --db path/to/hiers.db \
  --output out \
  --preview
```

### Example 12: choose a preferred preview port

```bash
rust-hier-viewer \
  --db path/to/hiers.db \
  --output out \
  --preview \
  --preview-port 9000
```

### Example 13: bind preview to all interfaces

```bash
rust-hier-viewer \
  --db path/to/hiers.db \
  --output out \
  --preview \
  --preview-host 0.0.0.0
```

## CLI Reference

```text
rust-hier-viewer [OPTIONS] [rtl ...]
```

Common options:

- `[rtl ...]`
  RTL file paths or wildcard patterns resolved by the viewer
- `--db <file>`
  Read a prebuilt sqlite DB directly
- `-f, --filelist <file>`
  Add a filelist; repeatable
- `-o, --output <dir>`
  Output directory; required
- `-r, --rebuild-sqlite`
  Ignore the sqlite cache under the output directory and rebuild it
- `--preview`
  Start the built-in local preview server after bundle generation
- `--preview-host <h>`
  Bind host for `--preview`; defaults to `127.0.0.1`; use `0.0.0.0` for remote access or port forwarding
- `--preview-port <n>`
  Preferred starting port for `--preview`; defaults to `8000` and auto-increments if occupied
- `--no-wizard`
  Never open the TUI wizard
- `-t, --title <text>`
  Override the page title
- `--debug`
  Enable debug overlays in the viewer
- `-- <args...>`
  Pass the remaining arguments through to slang / the exporter, for example `-I`, `-D`, `+incdir+`, and `--top`

## sqlite Cache Behavior

When the input comes from RTL rather than `--db`, the viewer stores cache files under:

```text
<output>/.hier-viewer-cache/
```

The cache key includes:

- RTL source file content and timestamps
- filelists
- extra slang flags
- the `slang-hier-exporter` fingerprint

So:

- if nothing changed, the sqlite cache is reused
- if inputs changed, the sqlite export is rebuilt automatically
- if you pass `-r` / `--rebuild-sqlite`, rebuild is always forced

The command-line logs also explain why a cache was reused or rebuilt.

## Output Directory Layout

The tool generates a directory, not a single HTML file. A typical output looks like:

```text
out/
├── index.html
├── viewer-meta.json
├── viewer-core.bin
├── viewer-analysis.bin        # only generated when analysis data exists
├── viewer-chart.js
├── viewer-three.module.js
├── three.core.js
├── .hier-viewer-sources/      # relative source copies used by the source reader
└── .hier-viewer-cache/        # only present when building sqlite from RTL
```

That is why the recommended workflow is `output directory + static file server`, not a single standalone HTML file.

## Preview Recommendations

### Recommended: built-in preview mode

```bash
rust-hier-viewer --output out --preview
```

This keeps the server in the foreground until you press `Ctrl-C`.

### Fallback: local or remote static file server

```bash
cd out
python3 -m http.server 8000
```

### Fallback: VSCode Live Server

- good for direct preview of `index.html`
- good for remote development hosts when used through VSCode Remote

### Not recommended: direct `file://` opening

Some browsers restrict:

- binary asset loading
- relative source-file loading
- `Open Raw` and source-reader behavior

## Usage Notes

### 1. Let the viewer resolve wildcard patterns

Write patterns like:

```bash
'rtl/**/*.sv'
```

Do not omit the quotes, otherwise your shell may expand the pattern before the viewer sees it.

### 2. Put only slang pass-through flags after `--`

For example:

```bash
-- --top Top -I rtl/include -D FOO=1 +incdir+rtl/include
```

Viewer-owned flags such as `--output`, `--db`, and `--debug` must stay before `--`.

### 3. Reuse the same output directory if you want fast incremental runs

The sqlite cache lives under the output directory. If you use a fresh output directory every time, you also force a fresh cache directory every time.

## Developer Note

If you are iterating on the codebase itself, you can still run everything through Cargo:

```bash
cargo run -- --output out --preview
```

That workflow is mainly for development inside this repository. The examples above are intentionally written in end-user style.

### 4. Preview mode binds to `127.0.0.1` by default

That is intentional. For remote servers, either:

- keep the default and use SSH or editor port forwarding
- or bind explicitly with `--preview-host 0.0.0.0`

## FAQ

### 1. Why is the first `cargo build` slow?

Because it also builds the C++ `slang-hier-exporter`, and the build may need to fetch `slang` source code first.

### 2. Why do I still need `--output` if I already have `hiers.db`?

Because this tool does not display the sqlite DB directly. It renders that DB into a complete static viewer bundle.

### 3. Why can I not pass both `--db` and RTL inputs?

Because the two modes are intentionally exclusive:

- `--db` means "consume an existing sqlite DB"
- RTL inputs and `--filelist` mean "build sqlite first, then render the viewer"

### 4. Why does source reader or `Open Raw` behave oddly in some setups?

Usually because the page was opened through `file://`, or because the static server is not serving the whole output directory. Serving the bundle over HTTP fixes that.

## Related Documents

- [Area sizing strategy](docs/area-sizing-strategy.md)

## Credits

This project relies on [slang](https://github.com/MikePopoloski/slang) for hierarchy parsing, semantic analysis, and elaboration.

Special thanks to the `slang` author and contributors for providing a high-quality and extensible SystemVerilog frontend and elaboration infrastructure. The built-in `slang-hier-exporter` in this project is implemented directly on top of the `slang` C++ API.
