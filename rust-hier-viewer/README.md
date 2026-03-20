# rust-hier-viewer

Generate a static hierarchy viewer bundle from RTL sources or from the output of `hier-viewer.py`.

Input format:

```text
Top <top>
Top.u_sub <mid>
Top.u_sub.u_leaf <leaf>
Top.u_other <leaf>
```

Or richer CSV from `hier-viewer.py --csv`:

```csv
path,module,file_path,line,column,end_line,end_column
Top,Top,/path/to/top.sv,120,7,,
Top.u_sub,mid,/path/to/top.sv,121,7,121,18
```

Usage:

```bash
# Recommended: start directly, pick RTL paths in the built-in TUI, and let the tool call
# hier-viewer.py --sqlite for you. The wizard supports literal / wildcard / regex path matching,
# fuzzy suggestions for literal paths, plus extra flags like +incdir+, +define+, and --top.
cargo run -- \
  --output hier-viewer-out

# Read CSV hierarchy from a file and write a bundle directory
cargo run -- \
  --input hier.csv \
  --output hier-viewer-out

# Pipe CSV from hier-viewer.py if you already have an existing flow
python3 hier-viewer.py --csv rtl.sv | \
  cargo run -- \
    --output hier-viewer-out

# Legacy plain input is still supported
python3 hier-viewer.py --plain rtl.sv | \
  cargo run -- \
    --output hier-viewer-out

# Exclude by wildcard or regex; both options can be repeated
python3 hier-viewer.py --csv rtl.sv | \
  cargo run -- \
    --exclude-wildcard 'Top.debug*' \
    --exclude-wildcard '*_tb' \
    --exclude-regex '^Top\\.u_dft(\\.|$)' \
    --output hier-viewer-out

# When cargo run launches hier-viewer.py --sqlite internally, the sqlite export is cached
# under <output>/.hier-viewer-cache/ and reused as long as the resolved source files,
# filelists, extra flags, and hier-viewer.py itself do not change.
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

# If pyslang is not installed, either install it yourself:
python3 -m pip install pyslang

# Or let rust-hier-viewer create ./\.hier-viewer-venv and install pyslang there.
# Future internal exports will reuse that venv automatically.
cargo run -- \
  --install-pyslang \
  --no-wizard \
  --rtl-path 'rtl/**/*.sv' \
  --output hier-viewer-out
```

The generated bundle contains `index.html`, `viewer-data.json`, `viewer-chart.js`, `viewer-three.module.js`, `three.core.js`, and `.hier-viewer-sources/`.
When the bundle is built from RTL inputs instead of a prebuilt `--input`, the output directory also contains `.hier-viewer-cache/` with reused sqlite exports.
If you use `--install-pyslang`, the project root also gets a reusable `.hier-viewer-venv/`.
Open the bundle directory through a static file server such as VSCode Live Server and load `index.html`.
When the input is CSV, the viewer shows file locations in the detail card and opens source code from the bundled relative files with SystemVerilog-oriented syntax highlighting.
The `signals` sizing metric is bit-aware and subtree-aware: it aggregates `module_signal_bits` over the current node and all descendants, while the hover card still shows both subtree totals and local totals for cross-checking.
