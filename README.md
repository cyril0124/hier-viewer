# hier-viewer

[中文说明](README.zh-CN.md)

RTL hierarchy visualization, structural analysis, and coverage inspection.

`hier-viewer` generates an interactive static site for inspecting elaborated instance hierarchies, comparing module statistics, and navigating RTL source. It supports treemaps, 2D pie charts, 3D charts, and an independent [RTL schematic](docs/schematic.md) with real port connections and expandable signal groups.

The embedded `slang-hier-exporter` extracts hierarchy, signal statistics, source locations, and instance-scoped semantic connections into SQLite. The Rust application generates the site from this export or an existing database supplied with `--db`. The generated site requires only an HTTP file server for browsing and browser-file coverage imports. The exporter ignores C/C++ source entries in RTL filelists because they are simulator/DPI build inputs rather than SystemVerilog sources. For designs containing intentionally oversized simulation memories, pass `--ignore-object-too-large` after `--` to continue hierarchy extraction while preserving other slang diagnostics. Verify the resulting diagnostics before treating the graph as complete. Optional server-side VDB conversion uses the built-in local service.

[Install](#install) · [Quick start](#quick-start) · [Schematic](docs/schematic.md) · [Coverage](#coverage) · [Common commands](#common-commands) · [Development](#development)

## Install

### Release binary

1. Download the archive for your platform from [GitHub Releases](https://github.com/cyril0124/hier-viewer/releases/latest).
2. Extract `hier-viewer` or `hier-viewer.exe` into a directory listed in `PATH`.
3. Verify the installation:

   ```bash
   hier-viewer --help
   ```

Release binaries include the exporter. Rust, CMake, and a C++ compiler are not required at runtime.

### Install with Cargo

Install the [source-build dependencies](#requirements), then run:

```bash
cargo install --git https://github.com/cyril0124/hier-viewer --locked
```

For a local checkout:

```bash
cargo install --path . --locked
```

To build without installing, run `cargo build --release --locked` and use `./target/release/hier-viewer` in place of `hier-viewer` below.

### Update the executable

```bash
hier-viewer update
```

The command downloads the latest stable release from GitHub and replaces the current executable. Progress reports cover download, extraction, and installation. To select a release tag:

```bash
hier-viewer update --to v1.0.0
```

## Quick start

1. Launch the interactive configuration wizard:

   ```bash
   hier-viewer --output out --preview
   ```

2. Configure RTL paths, filelists, and compiler options. The wizard supports `Literal`, `Wildcard`, and `Regex` path matching, with options such as `-I`, `-D`, `+incdir+`, and `--top`.
3. After generation completes, open the URL printed in the terminal. On local desktop sessions, the application also attempts to launch the default browser. Press `Ctrl-C` to stop the preview server.

The wizard opens only in an interactive terminal when no RTL inputs, filelists, or `--db` are supplied. In scripts or CI, pass those inputs explicitly.

## Features

### Classic treemap

![Classic treemap overview](docs/screenshots/treemap-classic-overview.png)

The treemap displays the instance hierarchy as nested regions and supports drill-down from the top level to individual instances. The hierarchy tree and filter results provide additional navigation.

### Weighted treemap

![Weighted accurate treemap](docs/screenshots/treemap-weighted-accurate.png)

Weighted signal-bit counts provide a relative measure of module size. This metric does not represent synthesized cell area or physical layout. Selecting `Weighted Signal Bits` enables the area-proportional `Accurate` layout by default.

### 2D pie chart

![2D pie chart](docs/screenshots/chart-2d-pie.png)

The pie chart displays module proportions for the selected metric, hierarchy root, and display depth.

### 3D chart

![3D weighted chart](docs/screenshots/chart-3d-weighted-bits.png)

The 3D chart represents module statistics as bars and supports interactive rotation. The example uses weighted signal-bit counts.

### Instance filtering

![Instance wildcard filter](docs/screenshots/filter-instance-wildcard.png)

Instance filters highlight matching nodes while retaining the surrounding hierarchy for context. The example selects instances matching `sram_*`.

### Settings and themes

![Advanced controls and theme switching](docs/screenshots/advanced-theme-controls.png)

Settings include layout and decomposition modes, source line counts (`LOC`) or weighted signal-bit metrics, signal-analysis patterns, and weighting coefficients. Themes include Tokyo Night. The browser retains UI settings and hierarchy collapse state across reloads.

### Zen mode

![Zen mode treemap](docs/screenshots/zen-mode-treemap.png)

Zen mode hides most interface controls to expand the visualization area.

### Source reader

![Source reader with bookmarks](docs/screenshots/source-reader-bookmarks.png)

The source reader navigates to instance declarations and module definitions. It supports in-file search, labeled bookmarks, raw-source access, and fullscreen display. The browser retains bookmarks across reloads.

## Coverage

Import coverage into a hierarchy viewer generated from the simulation's RTL and configuration. Line, Condition, Branch, and Toggle metrics are supported; Assert appears when the report contains assertion coverage.

### Preload coverage from the command line

Pass the report directory when generating the site:

```bash
hier-viewer -f rtl/files.f --no-wizard \
  --output out \
  --coverage-report /path/to/urgReport \
  --preview -- --top Top
```

The page opens with coverage already loaded; no **Import coverage** action is needed. The viewer automatically selects a unique report subtree whose descendant instance names and structure match the design. If several roots match, add `--coverage-root tb_top.u_dut` to choose the intended report instance. If none match, check the report/design inputs against the listed paths. Matching and diagnostics run when the page loads. Supply the coverage options before `--`. They also work with `--db` input. Omit `--preview` to generate the static bundle for CI or a separate HTTP server.

To pass a VDB directly, use `--coverage-vdb` instead of `--coverage-report`:

```bash
hier-viewer -f rtl/files.f --no-wizard \
  --output out \
  --coverage-vdb /path/to/simv.vdb \
  --preview -- --top Top
```

VDB conversion requires Linux, `urg` on `PATH`, and the applicable Synopsys license. Keep the same output directory: unchanged VDBs reuse the report in `out/.hier-viewer-cache/coverage/` without starting URG. Input file metadata, the URG executable, and conversion options determine reuse. Add `--rebuild-coverage` to force conversion; `--coverage-timeout <minutes>` defaults to 60, with `0` for unlimited. See [VDB cache rules](docs/coverage.md#cli-vdb-cache).

Both input modes copy report XML/HTML into `out`; coverage remains available after moving the bundle and on every page reload. Root mapping and report validation run when the page loads. Preloaded bundles also work with `--preview-host 0.0.0.0` for remote static access. See [preloaded deployment details](docs/coverage.md#preloaded-static-deployment).

### Import through the browser

1. Generate and open the hierarchy viewer using [Quick start](#quick-start). For an existing `out` bundle, run `hier-viewer serve out` and open the printed HTTP URL.
2. Click **Import coverage**, choose **URG report files**, and use **Choose folder** to select `urgReport`.
3. Set **Coverage root** to the full report instance path, such as `tb_top.u_dut`, and choose the corresponding **Target hierarchy**. Click **Check mapping**, inspect unmatched instances, then **Apply**.
4. Select a **Coverage** metric to color the hierarchy. Click legend ranges to filter instances, combine ranges, or use **Show all** to reset. Open **Module Source** for an instance to inspect Line coverage or the Condition, Branch, Toggle, and optional Assert detail tabs.

Select **Coverage** in the view switcher to see instance percentages, module source, and detail tables in a [three-pane workspace](docs/coverage.md#coverage-workspace). Click an instance or metric cell to inspect it. Drag the dividers to resize panes; on narrow screens, switch between Instances, Source, and Details.

The X beside the toolbar's Coverage selector turns coloring off. Select a metric to restore it.

Selecting only `session.xml` supplies hierarchy summaries; source and table details require the report's HTML files. Browser-selected files are read locally without uploading them.

The viewer recognizes relocated source files when their filenames and all numbered report excerpts match the bundled source. Text mismatches disable line markers. The treemap and 2D pie keep structural areas, while 3D defaults to fixed 0-100% coverage heights sorted from highest to lowest.

### Convert a VDB in the viewer

On the Linux machine that holds the VDB, serve the existing bundle on loopback:

```bash
hier-viewer serve out --host 127.0.0.1 --port 8000
```

Open the printed URL. In **Import coverage**, choose **VDB server directory**, enter the VDB's path on that machine, and click **Load report**. Then check and apply the hierarchy mapping as above. The server needs `urg` on `PATH` and the applicable Synopsys license. The dialog provides a timeout and cancellation controls.

**URG report server directory** loads an already generated report by server path. These server-side imports require a loopback binding; `--host 0.0.0.0` serves static content with browser-file imports only. For remote VDB conversion, use [SSH forwarding to the local service](docs/coverage.md#import-a-vdb-or-server-report).

### Copy selected coverage for AI analysis

1. In **Module Source**, choose a coverage tab and check individual rows, or click **Select uncovered** to add uncovered entries across all pages of that metric. Partially covered Line rows are included.
2. Switch tabs or pages to collect more entries. **Clear selection** removes the selection; changing the instance, source view, or report also clears it.
3. Click **Export selected** to preview the Markdown, then **Copy Markdown** and paste it into your AI conversation, or use **Download .md**.

The export includes instance paths, report metrics, original table headers and selected rows, and available source context. If automatic copying is unavailable, the preview text is selected for manual copying. The viewer does not send data to an AI service.

See the [coverage guide](docs/coverage.md) for preloaded reports, mapping rules, source validation, assertion semantics, and format limitations.

## Examples

- [`examples/ibex-example`](examples/ibex-example) provides entry scripts for `ibex_top` and `ibex_simple_system`, with a pinned `lowRISC/ibex` submodule and static filelists.
- [`examples/openpiton-example`](examples/openpiton-example) generates a filelist for a fixed 2x2 OpenPiton chip configuration using an open-source toolchain.

## Input modes

### RTL files and filelists

RTL input mode accepts files, directories, wildcard patterns, and filelists. The application reuses a valid SQLite export cache or invokes `slang-hier-exporter --sqlite` to rebuild it, then generates the static site.

Positional RTL arguments use `Wildcard` matching and accept exact paths and directories. Input resolution determines whether a workspace-wide RTL index is required:

| Input | Workspace-wide index |
| --- | --- |
| Filelists only, literal paths, directories, or absolute globs | Not required |
| Relative globs or interactive wizard | Required |

`Regex` path matching is available through the wizard.

Statistics use each instance's elaborated parameters and active generate branches. Instance bodies that slang identifies as equivalent share cached statistics. Different parameterizations can produce different signal widths and counts.

### Existing SQLite database

```bash
hier-viewer --db path/to/hiers.db --output out --preview
```

`--db` is mutually exclusive with RTL inputs and filelists. It reads the database without reparsing RTL or validating the export cache. `--output` remains required as the destination for the generated site.

Source files referenced by the database must be readable during generation so the application can include copies in the site. After RTL changes, regenerate the database through RTL input mode to obtain updated statistics.

## Common commands

### Pass RTL files

```bash
hier-viewer rtl/top.sv rtl/core.sv --output out --preview
```

### Use wildcard patterns

Quote patterns so the viewer resolves them instead of the shell:

```bash
hier-viewer 'rtl/**/*.sv' 'tb/**/*.v' --output out --preview
```

### Pass compiler flags

Arguments after `--` are forwarded to the embedded exporter for processing by slang. Application options such as `--output`, `--db`, and `--debug` must precede `--`.

```bash
hier-viewer \
  'rtl/**/*.sv' \
  --output out \
  -- \
  --top Top \
  -I rtl/include \
  -D SYNTHESIS=1 \
  +incdir+third_party/include
```

### Use filelists

Repeat `-f` to add filelists:

```bash
hier-viewer -f rtl/files.f -f tb/files.f --output out -- --top SimTop
```

Filelists can also be combined with positional RTL inputs:

```bash
hier-viewer \
  -f rtl/files.f \
  'rtl/generated/**/*.sv' \
  --output out \
  -- \
  +incdir+rtl/include
```

### Rebuild the export cache

```bash
hier-viewer -r 'rtl/**/*.sv' --output out -- --top Top
```

Normal source and dependency changes trigger rebuilding automatically. See the [cache invalidation limits](docs/export-and-bundle-contracts.md#cached-source-dependencies) for cases that require `-r`.

## CLI reference

```text
hier-viewer [OPTIONS] [rtl ...]
hier-viewer serve <output-dir> [--host IP] [--port N]
```

Run `hier-viewer --help` for the full option list.

| Option | Meaning |
| --- | --- |
| `[rtl ...]` | RTL paths or wildcard patterns resolved by the viewer |
| `--db <file>` | Read a prebuilt SQLite database |
| `-f, --filelist <file>` | Add a filelist; repeatable |
| `-o, --output <dir>` | Output directory; required |
| `-r, --rebuild-sqlite` | Ignore the export cache and rebuild it |
| `--preview` | Start the preview server after generation |
| `--preview-host <h>` | Bind address; default `127.0.0.1` |
| `--preview-port <n>` | Starting port; default `8000`, increments if occupied |
| `--coverage-report <dir>` | Copy a URG report into the generated site for automatic loading |
| `--coverage-vdb <dir>` | Convert a VDB with URG and reuse cached reports when unchanged; mutually exclusive with `--coverage-report` |
| `--rebuild-coverage` | Force VDB conversion; requires `--coverage-vdb` |
| `--coverage-timeout <minutes>` | VDB conversion timeout, default 60 minutes; `0` is unlimited |
| `--coverage-root <path>` | Optional report instance path; defaults to a unique hierarchy match. Requires a coverage input |
| `--no-wizard` | Disable the wizard; require explicit inputs |
| `-t, --title <text>` | Override the page title |
| `--debug` | Enable viewer debug overlays, such as UI labels |
| `-- <args...>` | Forward remaining arguments to the embedded exporter |

## Requirements

Source builds need:

- Rust toolchain
- CMake and Ninja
- a C++20 compiler
- SQLite3 and zlib development libraries

On Ubuntu, install the native dependencies used by CI:

```bash
sudo apt-get install cmake ninja-build g++ pkg-config libsqlite3-dev zlib1g-dev
```

### Embedded exporter

The first Cargo build also compiles the C++ exporter and embeds it in the Rust executable. By default, CMake `FetchContent` downloads and builds [slang](https://github.com/MikePopoloski/slang).

To use a local `slang` checkout, set this before building:

```bash
export HIER_VIEWER_EXPORTER_SLANG_SOURCE_DIR=/path/to/slang
```

`HIER_VIEWER_EXPORTER_FULLY_STATIC=1` is enabled by default. On Linux it produces a fully static exporter. On Windows it also selects the static MSVC runtime. On macOS, `slang` is linked statically, but the exporter still uses the system dynamic linker because Apple does not support fully static executables.

To disable the static-linking preference:

```bash
export HIER_VIEWER_EXPORTER_FULLY_STATIC=0
```

## SQLite cache

RTL input mode stores its SQLite export cache in `<output>/.hier-viewer-cache/`. Repeated runs can reuse this cache when they target the same output directory.

Cache validation covers RTL paths, file sizes and modification times, filelists, compiler options, and the exporter fingerprint. It also checks recorded source dependencies, including headers. Command-line logs report cache reuse and rebuild decisions.

Use `-r` / `--rebuild-sqlite` to force an export. See [cached source dependencies](docs/export-and-bundle-contracts.md#cached-source-dependencies) for invalidation rules and limits. `--db` bypasses cache validation.

## Output directory

```text
out/
├── index.html
├── viewer-meta.json
├── viewer-core.bin
├── viewer-analysis.bin        # only when analysis data exists
├── viewer-chart.js
├── viewer-coverage.js        # loaded when opening coverage import
├── viewer-three.module.js
├── three.core.js
├── .hier-viewer-sources/      # source copies for the reader
└── .hier-viewer-cache/        # only when exporting RTL to SQLite
```

Publish the complete output directory, including `.hier-viewer-sources/`. The browser loads source text and signal-analysis data on demand. Source URLs encode spaces and reserved characters; see [source bundle paths](docs/export-and-bundle-contracts.md#source-bundle-paths) for details.

## Preview

`--preview` serves the generated bundle on `127.0.0.1`, starting at port `8000`. To choose a different starting port:

```bash
hier-viewer --db path/to/hiers.db --output out --preview --preview-port 9000
```

On a remote host, use SSH or editor port forwarding with the default bind address. To allow direct remote access, bind to all interfaces with `--preview-host 0.0.0.0`.

To serve an existing bundle without regenerating it:

```bash
hier-viewer serve out --port 8000
```

The built-in server also supplies local coverage import. An ordinary server such as `python3 -m http.server --directory out 8000` supports static viewing and browser-file report import, but cannot run URG. Coverage APIs are disabled on non-loopback bindings.

VSCode Live Server can also serve the output directory, including through VSCode Remote.

Access the site over HTTP. Opening `index.html` through `file://` can prevent the browser from loading binary assets, source text, or `Open Raw` links. If source loading fails over HTTP, verify that the server exposes the complete output directory.

## Development

Run from the repository root:

```bash
cargo run -- --output out --preview
```

This opens the wizard on an interactive terminal. Pass source inputs or `--db` for noninteractive runs.

### Frontend development

TypeScript source lives in `rust-hier-viewer/src/html/frontend/`. Frontend builds require Node.js 22.12+ on the 22.x line, 24.x, or 26+, and npm.

```bash
npm ci
npm run typecheck
npm run build
cargo run -- --db path/to/hiers.db --output out --preview
```

Include the regenerated files under `rust-hier-viewer/src/html/generated/` with frontend changes. Cargo embeds them without invoking Node; release binaries and Cargo installation do not require Node. See [frontend assets](docs/export-and-bundle-contracts.md#frontend-assets) for build and packaging rules.

### Validation

The [Linux CI workflow](.github/workflows/ci.yml) uses Node.js 22 and Python 3 in addition to the source-build dependencies. Run these checks from the repository root in a Linux shell:

```bash
npm ci
npm run typecheck
npm run check:generated
npm test
npx playwright install --with-deps chromium
npm run test:browser
cargo fmt --check
cargo check --locked
cargo clippy --locked --all-targets --all-features -- -D warnings
cargo test --locked --no-run
timeout 60s cargo test --locked
cargo build --locked
npm run test:ui
python3 tests/cache-dependencies.py target/debug/hier-viewer
```

Compile the Rust tests before applying the 60-second execution timeout. See [definition statistics](docs/export-and-bundle-contracts.md#definition-statistics) for the real-exporter parameterization test and the data invariants it checks.

## Related documents

- [Area sizing strategy](docs/area-sizing-strategy.md)
- [Export and bundle contracts](docs/export-and-bundle-contracts.md)

## Credits

The embedded exporter uses the [slang](https://github.com/MikePopoloski/slang) C++ API for SystemVerilog parsing, semantic analysis, and elaboration. The project acknowledges the work of the slang author and contributors.

Development used GPT-5.4 assistance throughout, with feature specifications and technical direction provided by the author.
