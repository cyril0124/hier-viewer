# Export and bundle contracts

## Definition statistics

`definitions.definition_key` identifies an elaborated module body within one export. It is not a stable source-location ID and must not be compared across exports. `instances.definition_key` and `definition_signal_stats.definition_key` reference it.

The exporter reuses statistics only when slang reports the same canonical instance body. Different parameter values or generate branches can produce different keys for the same module and source location. Instance and definition source locations remain independent of this key.

The regression fixture checks 8-bit and 32-bit instances, repeated equivalent instances, generate-dependent counts, and reversed declaration order:

```sh
python3 cpp-hier-exporter/tests/test_parameterized_cache.py /path/to/slang-hier-exporter
```

## Cached source dependencies

A generated SQLite export records real input files, including included headers, in:

```sql
CREATE TABLE source_dependencies (path TEXT PRIMARY KEY);
```

Paths are absolute, deduplicated, and ordered when fingerprinted. In-memory compiler buffers are not filesystem dependencies. Rust adds one row to the cached export after successful generation:

```sql
CREATE TABLE cache_metadata (dependency_signature TEXT NOT NULL);
```

The signature covers each dependency path, file size, and modification timestamp. Before reusing a cache, the launcher compares the current signature with the stored value. The exporter binary fingerprint is also part of the cache filename key.

| Condition | Result |
| --- | --- |
| Unchanged dependencies | Reuse cached export |
| Dependency size or modification time changes | Log cache miss and export again |
| Dependency disappears | Log cache miss and export again |
| Dependency disappears before the new signature is stored | Fail generation |
| SQLite error or filesystem error other than missing file | Return the error |

This is metadata-based invalidation, not a content digest. Changes that preserve both size and modification time are not detected. A new file that shadows an existing include through search-path precedence is not an already-recorded dependency. Use `--rebuild-sqlite` in these cases. Files must remain unchanged while an export is running.

`--db` reads the hierarchy and analysis tables directly. It does not require cache metadata or run cache validation.

```sh
python3 tests/cache-dependencies.py target/debug/hier-viewer
```

## Source bundle paths

Each source file is copied under `.hier-viewer-sources/` using all components of its normalized absolute path. The filesystem root separator is omitted; Windows prefixes are encoded as a `prefix-` component followed by hexadecimal bytes. The output directory does not determine which source components are retained.

Normalized aliases are grouped before parallel copying, so one destination has one writer. URL path components are percent-encoded without changing disk filenames. Source text is loaded by the browser through the generated source URL; bundle generation does not extract or embed source snippets.

## Tree computation

Rust assigns parents lower node IDs than their children. Aggregate statistics initialize local values, then accumulate into parents in reverse node order without recursion or child-list copies.

The browser follows child links in iterative postorder for subtree depth and analysis totals. Signal-name matching runs once per referenced definition per pattern update, then assigns those counts to instances. Definitions absent from the filtered hierarchy are not scanned. Completion or failure of lazy analysis loading invalidates the chart render cache.

```sh
npm test
```

The runtime tests cover a root with 200,000 children, a 30,000-node chain, shared definitions, mode changes, asynchronous analysis completion, filter updates, chart drill-down, and source-request cancellation. Rust tests include a 100,000-node chain, source-path collisions, filelist compiler options, and wizard input preservation.

## Source reader verification

Virtualized rows use a measured, fixed height and no intrinsic-size placeholders. Search navigation scrolls the active match into view without taking focus from the search input. Each source request owns its cancellation signal; closing or switching files invalidates pending rendering and progress updates.

With the local npm dependencies and Playwright Chromium installed, run:

```sh
npm run test:browser
```

This starts a temporary loopback server and loads the production TypeScript reader module with the viewer HTML and CSS. At desktop and narrow viewport sizes, it checks 500,000-line plain-text search focus, Enter/Shift+Enter navigation, and horizontal visibility of column-401 matches in virtualized source. The server and browser close when the script exits.

`npm run test:ui` uses the built CLI to export the parameterized RTL fixture and serves the generated bundle. It checks desktop/mobile controls, Canvas pixels, treemap zoom/pan, filters, source navigation, bookmark persistence, persisted theme, and 2D/3D interactions. Its screenshots and bundle are written to `target/frontend-ui/`.

## Frontend assets

`rust-hier-viewer/src/html/frontend/` contains the authored TypeScript. HTML, CSS, and the vendored Three.js r183 modules remain under `rust-hier-viewer/src/html/`.

Vite builds two minified IIFE scripts into `rust-hier-viewer/src/html/generated/`: `viewer-app.js` and `viewer-chart.js`. These generated files are versioned and must be regenerated with `npm run build` whenever their sources change. Do not edit them by hand. Type checking is separate: `npm run typecheck` runs TypeScript in strict mode.

Rust embeds the generated scripts at compile time. The app script remains inline in `index.html`; the chart script remains `viewer-chart.js`. Three.js is loaded from the existing local module files only when the 3D view needs it. Bundle binary formats, source URLs, and persisted UI state are unchanged by the frontend build.

`npm run check:generated` builds into a temporary directory, compares filenames and bytes with the versioned scripts, and fails on missing, extra, or stale files. CI and release builds run this check without first overwriting the versioned scripts. Cargo builds and release binaries do not invoke npm or require a Node runtime.
