# Coverage import

Coverage is imported into an already generated hierarchy viewer. It does not change the RTL export, hierarchy sizing, or SQLite cache. Coverage stays in the current browser session; reload requires another import unless the deployment includes a bundled report.

## Preloaded static deployment

Generate a bundle with coverage entirely from the command line:

```sh
hier-viewer -f rtl/files.f --no-wizard \
  --output out \
  --coverage-report /path/to/urgReport \
  --preview -- --top Top
```

`--coverage-report` is a generation option, also supported with `--db`. Without `--coverage-root`, the browser searches the entire report for a subtree with exactly the same descendant instance names and structure as the generated design root. Sibling order and the root's own name do not affect matching. A unique match is selected automatically; zero matches or multiple matches produce an error with report paths to inspect. Diagnostics show at most 20 paths and state the total when more exist; the search itself is not truncated. Structural matching does not prove module identity or the simulation's RTL revision, and even a leaf-only design can be ambiguous.

Use `--coverage-root tb_top.u_dut` to select an explicit report instance. An invalid explicit root never falls back to automatic selection. Root existence, complete hierarchy matching, XML metrics, and detail/source validation are checked by the browser on load. Remove `--preview` for non-serving CI generation. To supply a VDB directly, use `--coverage-vdb` as described below.

The generator copies regular `.xml` and `.html` files into a fresh `coverage-*` directory inside the output bundle and adds the manifest attribute automatically. The input report is read-only, symlinks are not copied, and output cannot be inside the input report. Keep the entire output directory when deploying; runtime access to the original report and the local import API is unnecessary. Existing report copies are preserved when regenerating. Omitting the coverage options on a later generation removes automatic loading from the new page, but does not delete earlier copies from the output directory.

For a manually assembled deployment, set `data-coverage-manifest="./coverage/manifest.json"` on the generated page's `body`. The manifest contains `name`, an optional full coverage `root`, and a `files` array of report-relative filenames. Omit `root` to request automatic matching. Serve those files beside the manifest, including `session.xml`, module lists, and module detail pages. The viewer automatically loads the report and maps it to the design root on every page load. Both sides of the selected hierarchy must match completely. No server execution API is needed; omit the attribute to keep ordinary imports on demand.

```json
{"name":"Regression coverage","root":"tb_top.u_dut","files":["session.xml","modlist.html","mod0.html"]}
```

Bundled report paths must be relative and served from the same origin. Treat this manifest and the report as part of the deployment; manually assembled bundles require restoring the attribute after regenerating the HTML. Source validation and instance-specific detail rules still apply.

## CLI VDB cache

```sh
hier-viewer -f rtl/files.f --no-wizard \
  --output out \
  --coverage-vdb /path/to/simv.vdb \
  --preview -- --top Top
```

`--coverage-vdb` and `--coverage-report` are mutually exclusive. Both support an optional `--coverage-root` and the same automatic matching. VDB mode requires Linux and an executable `urg` on `PATH`; a cache miss additionally needs an applicable Synopsys license. Conversion uses the same XML/HTML options as the local import service. The input VDB is never used as an output directory.

Reports are cached under `<output>/.hier-viewer-cache/coverage/`, keyed by the canonical VDB path. Reuse the output directory across invocations. Cache validation covers all input paths, file sizes/modification times, Unix change times and file identities, linked targets, the URG executable path/metadata, conversion arguments, and cached report metadata. Adding, removing, or changing an input or cached report file invalidates reuse. Root selection and timeout changes do not affect report contents and do not invalidate the cache.

This is metadata-based invalidation, not a content digest. Changes invisible to filesystem metadata or to the fingerprinted executable, such as replacing supporting URG libraries while retaining the same launcher, require `--rebuild-coverage`. That flag forces conversion; `--rebuild-sqlite` controls only the RTL export cache. Logs explicitly report VDB cache hits, misses, and forced conversion.

Concurrent callers sharing a cache entry wait for an OS lock and recheck it after the preceding conversion finishes. Successful conversions publish an immutable report generation and atomically replace the current-cache record. Failed, timed-out, or cancelled conversions preserve the previous record. If the VDB or executable changes during conversion, the command fails without publishing that result. Older report generations remain in the cache so existing readers stay valid.

`--coverage-timeout <minutes>` defaults to 60; `0` is unlimited. It measures URG execution, not time waiting for the cache lock. `Ctrl-C` cancels conversion or lock waiting. These options and `--rebuild-coverage` require `--coverage-vdb`. CLI report caches are persistent; UI VDB imports continue to use temporary reports scoped to the local service.

## Import a report

Generate an XML and HTML report with Synopsys URG:

```sh
urg -dir /path/to/simv.vdb -report /path/to/urgReport \
  -format both -show fullhier -show ratios -xml_verbose \
  -metric line+cond+branch+tgl+assert
```

1. Open the viewer over HTTP and select **Import coverage** in the toolbar.
2. Choose **URG report files**, then select the report folder. A `session.xml` file alone supplies hierarchy metrics but not source-line details. If several sessions are present, select the required session.
3. Set **Coverage root** to its full report instance path, such as `tb_top.u_dut`. Choose the corresponding **Target hierarchy** from the current selection/view root or design root.
4. Select **Check mapping**, inspect unmatched instances, then **Apply**.

Browser-selected files are read locally, not uploaded. This path works with an ordinary static HTTP server and does not require Synopsys on the viewer host.

## Import a VDB or server report

Serve an existing bundle with the built-in server:

```sh
hier-viewer serve out --host 127.0.0.1 --port 8000
```

`--preview` after generation provides the same service. Occupied ports advance automatically; use the URL printed by the command.

In **Import coverage**, select **VDB server directory** or **URG report server directory**, enter a path on the server machine, and select **Load report**. VDB import requires Linux, an executable `urg` on the server's `PATH`, and the applicable Synopsys license. The VDB itself is not uploaded from the browser.

VDB timeout defaults to 60 minutes. Set a nonnegative integer; `0` disables the deadline. Time starts when URG launches, including any license waiting. **Cancel** terminates the task. Only one URG task runs at a time. Reports are generated in temporary directories, never inside the source VDB. Removing or replacing coverage releases the report; server shutdown terminates workers and removes generated temporary reports. Imported report directories are never deleted.

Coverage APIs are enabled only on loopback bindings. A remote static binding such as `0.0.0.0` still serves the viewer, but cannot execute URG or open server report paths. Use SSH port forwarding for remote VDB import. API requests require the server session token and a matching loopback Host/Origin; arbitrary cross-origin requests are rejected.

## Read the visualization

**Coverage** selects Line, Condition, Branch, or Toggle coloring. Rectangle area continues to use the existing sizing metric. Colors use fixed percentage ranges, not the minimum and maximum of the visible view. Unknown metrics and zero-denominator metrics are neutral, while a measured zero-percent metric is red. Local-self areas remain neutral because the imported XML scores are subtree scores.

The **X** beside the toolbar's Coverage selector turns coloring off while keeping the report loaded. Select a metric to turn coloring back on. Use **Remove** in the Coverage workspace to unload the report.

Click a coverage legend range to filter instances; click it again to deselect it. Ranges can be combined, including **No data**, and **Show all** clears the range filter. Selection uses the same exact thresholds as coloring: below 50%, 50% to below 80%, 80% to below 95%, and 95% through 100%. Missing and zero-denominator metrics both belong to No data. Range selection intersects with the text search and populates **Filter matches**, whose button opens the result list. Treemap geometry stays fixed and unrelated nodes fade; ancestor nodes remain for navigation. At the selected chart level, 2D/3D include only matching instances, so a matching parent's score does not admit its children. Increase the chart level to inspect deeper matches. Empty charts retain the range buttons for recovery. Switching metrics reapplies selected ranges; turning coverage off, removing it, or importing another report clears the range selection. Range selections are not persisted across reloads.

Instance details show covered/total points and exclusion counts as reported by URG. Subtree scores are not added together or averaged again. Toggle means the objects collected in the VDB; a port-only VDB does not describe all internal signals. Structural analysis coloring and coverage coloring are mutually exclusive. The 2D pie and 3D charts use the same selected coverage metric for colors and show per-instance percentages and counts in their legends and hover details. With coverage active, 3D defaults to **Coverage (%)** mode: bar height is the instance's subtree percentage on a fixed 0-100% axis. Heights are linear, never normalized to the largest visible score. Bars and legend entries are ordered by descending coverage, with missing data last; equal scores retain hierarchy order. Switching metrics recalculates this order. Zero coverage has no raised bar and a `0%` base marker; missing data has a gray `No data` marker. Instance labels appear when readable at the current zoom or on hover, with at most 80 labels shown alongside the fixed percentage axis. Every instance remains selectable through its bar or pedestal and the scrollable legend. Percentages are not summed. Weighted Bits remains selectable for structural height. Pie areas always retain structural sizing, with coverage represented by color. Switching coverage metrics preserves the 3D camera; turning coverage off restores weighted sizing.

Open **Module Source** for a mapped instance to inspect line coverage. The separate coverage column shows covered/total points, not execution counts. It distinguishes covered, uncovered, and partially covered rows. Rows without reported points remain neutral. Selecting a coverage cell shows its counts; the arrow buttons jump between uncovered or partial lines. Clicking the line number still controls bookmarks.

Coverage follows the selected hierarchy instance even when several instances share a cached source file. It is not applied to the parent file shown by **Open Instance**. Normal and compact views retain fixed-height virtualized rows. Very large plain-text views keep the textarea and expose a paginated line-detail list with source jumps.

## Coverage workspace

Select **Coverage** in the view switcher for an instance tree, module source, and coverage details side by side. The tree shows Line, Toggle, Condition, Branch, and Assert when present. Percentages come from each instance's report summary. `No data` means no reported metric; `N/A` means a zero denominator. Hover a metric for its exact counts.

Search by instance name, module name, or path. Matching rows keep their ancestors visible. Expand rows with the triangle buttons or arrow keys; press Enter to open the focused instance. Click a metric cell to open its detail tab. Workspace search is independent of chart filters.

Source stays visible when switching metric tabs. The Line list shows up to 200 points per page and supports **Uncovered only**, individual selection, and **Select uncovered**. Detail line links locate source without switching the metric tab. These links require a successful Line source validation. Instances without bundled module source show summary metrics only.

Drag a divider to resize the panes, or focus it and press Left/Right. The browser remembers pane widths and the active view. At widths of 1000 pixels or less, switch panes with **Instances**, **Source**, and **Details**. Line links open Source. Returning to a chart closes the source reader and clears its export selection.

**Import report** and **Remove** manage coverage within the workspace. Source validation, report availability, and export rules below apply to both the workspace and the source window.

## Optional assertion coverage

When the imported instance metrics include `Assert`, an **Assert** metric and detail tab become available. Without assertion data, those controls remain hidden. VDB conversion requests `-metric assert`, but cannot recreate data that simulation did not collect.

The URG Assert score counts succeeded/matched objects, including cover directives; it is not an assertion pass rate. The detail view keeps Assertions and Cover Properties in separate tables. It shows Attempts, Real Successes, Failures, Incomplete, and Matches where supplied. A failure is marked **Failed**, even if the same assertion also had successes; **No success** or **No match** is not called a failure. Attempt counts follow URG, including its disabled/vacuous-attempt semantics. The filter retains failures, incomplete results, and objects without successes/matches.

## Instance detail tabs

In the module source window, the **Line**, **Condition**, **Branch**, and **Toggle** tabs select the current instance's detail view. Condition and Branch show report expressions, source references and covered/missing combinations. Toggle shows reported signal ranges and both transition directions. **Uncovered only** filters out covered detail rows; summary tables stay visible. Tables paginate after 100 rows. Condition line links return to the source view. These are report details, not new source-code overlays or inferred internal-signal coverage.

Details are parsed into text and table cells, not embedded as original URG HTML. They retain the report's own metric semantics and are never replaced with a multi-instance module aggregate. Changing instances or tabs cancels stale loads. Missing report files and unsupported formats produce an explicit message and a Retry action. Reports lacking one metric do not borrow values from another.

Server imports provide an **Open URG Report** link. Browser-only file imports do not invent a URL for files that are not hosted. Original server report pages are sandboxed and cannot access the coverage execution API.

## Export selected coverage for analysis

1. Open **Module Source** for a mapped instance. Check the boxes beside Line coverage counts or detail table rows. **Select uncovered** adds all uncovered entries in the current metric across every page, preserving existing selections. It includes partial Line coverage and Assert failures/no-success results, but excludes excluded Line points and unknown detail rows. A table's header checkbox selects only its current filtered page. In large-source plain mode, choose a line and click **Add line to export**.
2. Switch metric tabs or pages to collect more entries. The selected count includes entries hidden by pagination or **Uncovered only**. **Clear selection** removes all entries. Switching the instance, source view, or imported report clears the selection automatically.
3. Click **Export selected** to inspect the Markdown, then **Copy Markdown** or **Download .md**. If automatic copying is unavailable, the viewer selects the preview text for manual copying.

The export includes instance paths, module, source file, report name and release, subtree metrics, and selected observations. Detail rows retain their headers, expressions, source references, and raw cells, including Assert counters. Line ratios count covered/total points.

Source context includes up to three surrounding lines, with overlapping ranges merged. Detail context is included when source paths match or Line validation has verified a relocated file for the current instance and view. Metadata records the bundled path and the report path verified by Line coverage. Rows without line references have no source context. Source text comes from the bundle; it does not establish the simulation's RTL revision.

Selection, formatting, clipboard copying, and download run in the browser. The viewer does not send the selection to an AI service. Only selected rows are exported; choosing one page never selects hidden pages.

## Data limits and validation

The importer reads `session.xml` format 1.1 and the URG module-list, self-instance, and Line HTML sections. It has been checked against URG U-2023.03. Instance pages split across `modN_*.html` are followed on demand. A module-level Line section is used only when the report proves that the module has exactly one instance.

Matching with an explicit root rebases the chosen coverage root to the chosen hierarchy node, then matches child names exactly. Automatic preload matching uses the same complete descendant-name/structure requirement and refuses ambiguous results. Neither mode merges by module name or guesses generate-name aliases. Use the same top, parameters, defines, and RTL version as the simulation. Review unmatched paths before applying a report.

Line details must agree with the instance's own Line total. The parser verifies the selected instance and module. The viewer then compares every numbered source row in the report with the bundled source at the same line number. This includes context without coverage counts and ignores leading and trailing whitespace.

When source paths differ, the viewer accepts the relocated file if its filename matches and all report excerpts pass validation. The status identifies relocated files. Different filenames, conflicting text, missing source excerpts, or out-of-range line numbers disable the overlay. Validation covers the report excerpts; keep the simulation's RTL revision separately to establish the full source version.

Ambiguous multi-file attribution, unsupported exclusion layouts, missing pages, invalid counts, and unrecognized line formats fail explicitly instead of becoming zero coverage. Detailed exclusions are not inferred from colors or comments. Other metric sections and annotation-only rows such as `MISSING_ELSE` are not treated as source lines.

HTML is parsed as data with `parse5`; imported scripts are not executed. XML DTDs are rejected. Detail links must refer to files inside the selected report. Module indexes and line details each use an eight-entry cache; full report documents are not retained after parsing.

## Verification

Run the standard frontend and Rust checks described in the project README. Native XML, stale-response, shared-file instance, and large-source tests run with `npm run test:browser`.

Run `node tests/run-coverage-cli.mjs` after building the CLI to check report packaging, static automatic loading/reload without import APIs, regeneration, and input-directory protection. This test creates and removes its own synthetic RTL and report files.

Run `node tests/run-coverage-vdb-cli.mjs` on Linux to check CLI VDB cache reuse, invalidation, forced/failed rebuilds, and conversion/preview cancellation with a stub URG executable. Rust tests also cover concurrent callers and linked inputs.

Run `node tests/run-coverage-legend.mjs` after building the CLI to check range multiselect, search intersection, No data, treemap pixels, chart filtering, and resets at desktop and narrow viewport sizes.

Run `node tests/run-coverage-workspace.mjs <viewer-url> <instance-path-query> <covered/total>` against a preloaded report with uncovered Line points. It checks pane navigation, source/detail coexistence, exports, report removal, layout persistence, narrow screens, and bounded tree rendering. Screenshots go under `target/coverage-workspace-evidence/`.

A real-report browser check accepts independently established expectations:

```sh
node tests/run-coverage-ui.mjs \
  http://127.0.0.1:8000/index.html \
  /path/to/urgReport /path/to/expectations.json /path/to/simv.vdb
```

The final VDB argument is optional. The JSON specifies the mapping and at least two source instances; queries use the viewer's displayed hierarchy paths:

```json
{
  "coverageRoot": "tb_top.u_dut",
  "matched": 3,
  "unmatchedCoverage": 0,
  "instances": [
    {"query": "q0$", "points": "1/2", "lines": {"28": "0/1"}},
    {"query": "q1$", "points": "2/2", "lines": {"28": "1/1"}}
  ]
}
```

Choose the first instance with an uncovered line to exercise navigation. The runner checks browser-folder import, XML-only degradation, server report registration, optional VDB conversion, desktop/mobile source controls, and canvas changes. It writes screenshots and measurements beside the expectations file. Keep private reports, source files, and expectations outside version control.
