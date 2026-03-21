# rust-hier-viewer

Generate a static hierarchy viewer bundle from RTL sources or from the output of `slang-hier-exporter`.

Input format:

```text
Top <top>
Top.u_sub <mid>
Top.u_sub.u_leaf <leaf>
Top.u_other <leaf>
```

Or richer CSV from `slang-hier-exporter --csv`:

```csv
path,module,file_path,line,column,end_line,end_column
Top,Top,/path/to/top.sv,120,7,,
Top.u_sub,mid,/path/to/top.sv,121,7,121,18
```

Usage:

```bash
# Recommended: start directly, pick RTL paths in the built-in TUI, and let the tool call
# slang-hier-exporter --sqlite for you. The wizard supports literal / wildcard / regex path matching,
# fuzzy suggestions for literal paths, plus extra flags like +incdir+, +define+, and --top.
cargo run -- \
  --output hier-viewer-out

# Read CSV hierarchy from a file and write a bundle directory
cargo run -- \
  --input hier.csv \
  --output hier-viewer-out

# Pipe CSV from slang-hier-exporter if you already have an existing flow
./target/debug/slang-hier-exporter --csv rtl.sv | \
  cargo run -- \
    --output hier-viewer-out

# Legacy plain input is still supported
./target/debug/slang-hier-exporter --plain rtl.sv | \
  cargo run -- \
    --output hier-viewer-out

# Exclude by wildcard or regex; both options can be repeated
./target/debug/slang-hier-exporter --csv rtl.sv | \
  cargo run -- \
    --exclude-wildcard 'Top.debug*' \
    --exclude-wildcard '*_tb' \
    --exclude-regex '^Top\\.u_dft(\\.|$)' \
    --output hier-viewer-out

# When cargo run launches slang-hier-exporter --sqlite internally, the sqlite export is cached
# under <output>/.hier-viewer-cache/ and reused as long as the resolved source files,
# filelists, extra flags, and the exporter binary itself do not change.
cargo run -- \
  --no-wizard \
  --rtl-path 'rtl/**/*.sv' \
  --output hier-viewer-out \
  -- --top Top +incdir+rtl/include

# Force rebuilding the cached sqlite export
cargo run -- \
  --no-wizard \
  --rebuild-sqlite \
  --rtl-path 'rtl/**/*.sv' \
  --output hier-viewer-out
```

The generated bundle contains `index.html`, `viewer-meta.json`, `viewer-core.bin`, `viewer-chart.js`, `viewer-three.module.js`, `three.core.js`, and `.hier-viewer-sources/`. When signal analysis data is available, the bundle also includes `viewer-analysis.bin`.
When the bundle is built from RTL inputs instead of a prebuilt `--input`, the output directory also contains `.hier-viewer-cache/` with reused sqlite exports.
`cargo build` / `cargo run` also builds a static `slang-hier-exporter` binary next to the Rust executable, so no separate Python / `pyslang` runtime is required for internal exports.
Open the bundle directory through a static file server such as VSCode Live Server and load `index.html`.
When the input is CSV, the viewer shows file locations in the detail card and opens source code from the bundled relative files with SystemVerilog-oriented syntax highlighting.
`Weighted Signal Bits` is bit-aware and subtree-aware. It sizes by subtree variable bits plus subtree net bits using user-configurable coefficients; setting `Var=1` and `Net=1` reproduces the old subtree signal-bits behavior.
