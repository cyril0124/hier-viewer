# Schematic view

Schematic shows RTL connectivity for the current hierarchy scope. Choose **Schematic** in the normal or Zen view switcher. Double-click a module to enter it; use the breadcrumbs, hierarchy tree, Home or Parent controls to change scope. A module's pinned hover card also provides hierarchy and source actions.

## Loading scopes

Default RTL generation skips all schematic tables and scope JSON. Run with `--preview`, or reopen the bundle with `hier-viewer serve out`, then choose **Schematic**. The built-in service generates only the current scope and caches the result on disk. The first uncached RTL scope starts a persistent Slang worker that parses and elaborates the design once. Later uncached scopes reuse its `Compilation` and extract their graph without repeating global signal statistics or hierarchy export. The worker retains the elaborated design in memory until service shutdown, worker failure, or source invalidation. A failed worker is restarted on an explicit retry; finished disk caches remain reusable. The service builds one scope at a time; further uncached requests show busy until the active job finishes.

Keep the original RTL and the output's private `.hier-viewer-cache/` locally. Completed scope caches survive service restarts. If source inputs change, regenerate the bundle before loading more scopes. Switching scope or leaving Schematic stops the browser's old wait; a server job that finishes may still cache its result for a later visit. On-demand generation also works with `--preview-host 0.0.0.0` or `serve --host 0.0.0.0`; coverage service restrictions are unchanged.

For ordinary static hosting or sharing, prebuild all scopes by placing `--schematic` before `--`:

```bash
hier-viewer -f rtl/files.f --output out --schematic -- --top Top
```

With `--db`, the built-in service extracts only the requested scope from existing schematic tables; keep the database available. A database without those tables cannot rebuild RTL and leaves Schematic unavailable. Regenerate from RTL to enable it. A valid empty scope displays an empty-graph message. Invalid connection data or missing prebuilt scope files produce an explicit error.

When a simulator filelist contains DPI or other C/C++ implementation files, the embedded exporter ignores those entries automatically. If a simulation-only memory exceeds slang's object-size limit, pass `--ignore-object-too-large` after `--`, for example `hier-viewer -f vsrc.f --output out -- --ignore-object-too-large`. This permits hierarchy and schematic extraction to continue, but the resulting **Partial RTL** graph must be checked before treating every connection as complete. A smaller memory stub is safer when one is available.

## Reading and editing the view

Module rectangles show connected terminals with input pins on the left and outputs on the right. Physical pins in the same signal group and direction share a compact interface terminal, labeled with its signal count. Unconnected pins remain in the details card. Boundary inputs drive the current scope, and boundary outputs receive its results. Expression and constant nodes describe RTL expressions, not synthesized gates. Complete port names, widths and RTL expressions remain available in details when their canvas labels are shortened. Unresolved nets use dashed lines; bidirectional and multi-driver nets use a distinct color and retain their status in hover details.

Component boxes and junctions grow with connected bus width using bounded logarithmic spacing. Module boxes also scale with the current **Weighted Signal bits** value, calculated as subtree variable bits × variable weight plus subtree net bits × net weight. Schematic compares the logarithmic metric range within the current scope, then scales module width up to 2× and height up to √2×. The hover card shows the exact value. `INPUTS` and `OUTPUTS` use rounded interface cards with opposing side markers and arrows. `MODULE` uses a plain framed box. `OPERATOR` uses a rounded dashed box. `CONST` uses a hard edged gold box. `BUS` uses a rounded teal box with three short bus marks. `NET` uses a dotted box. `ERROR` uses an orange dashed box. Hover cards retain exact RTL kind, names, widths and top-level expressions. Nested expression nodes keep their semantic kind and parent reference while the complete root expression remains available in the card and source view.

Signal groups share a naming prefix and the same set of endpoint nodes and roles. The grouping rule splits underscores, dots, array delimiters and camel-case boundaries, then prioritizes the prefix covering the most nets. Ties favor the deeper prefix. This keeps a wide interface together instead of making a separate box for every field. Sorting makes the result stable. Names only choose presentation groups; exported net and endpoint identities determine connectivity. Coincident paths between the same nodes with the same status appear as one thicker bus. Its details list every represented net. Expanding a group separates paths at its individual signal rows.

Click a group to pin its complete signal list in the top-right inspector. Bus clicks never change the canvas geometry. The list remains scrollable for wide interfaces. The most recently selected group replaces the previous card. Hover over a group to inspect its complete scrollable signal list in the top-right corner of the canvas. The card stays visible while the pointer crosses the canvas to reach it. Click **Pin** or the card body to keep it open; pinned cards can be dragged by the header and closed. Clicking a wire selects its full net path and pins its signal details in the top-right inspector. The card includes each selected signal's width, status and endpoint names. Hold **Ctrl** while clicking to add or remove another net. Multiple selected trunks keep their orange overlays at the same time. A plain click, node click, canvas click or **Escape** clears the wire selection.

For module scopes with more than 32 nodes and 16 local expressions/constants connected to child instances, the default view summarizes the local RTL body as one **Local logic** box. Its terminals preserve distinct external nets; it does not electrically join them. Internal unresolved, bidirectional and multi-driver nets are counted on the summary and remain available in RTL detail. A summary containing diagnostics uses the unresolved color and shows its issue count. The legend states how many local nodes are summarized. Enable **RTL detail** to lay out the complete graph, or turn it off to return to the module view. At small zoom levels, module names and bus counts replace dense pin text; zoom in to read the pins.

Drag a module or group to move it. Click **Reset layout** to discard the current scope's manual positions, camera and RTL detail mode, rerun the initial layout, and fit the scope. Grid visibility and snap settings remain unchanged. Drag a wire's interior orthogonal segment to adjust its channel. A move that would overlap a module or violate obstacle clearance is constrained by the router. **Snap to grid** rounds geometry edits to a 12-unit grid; **Show grid** independently toggles the faint background grid. Drag empty canvas to pan freely. The wheel zooms around the pointer, and **Fit** centers the scope.

## Layout and runtime

elkjs 0.12.0 runs ELK Layered inside the local schematic Worker. The layout uses left-to-right flow, fixed terminal positions and orthogonal routing. Pins sharing one visible interface terminal become one ELK port, and parallel connections between identical terminals become one layout edge. The controller retains the raw graph; the visible scene preserves individual interface net edges, with the resulting bus geometry mapped back to every member. Scope boundary inputs and outputs use separate boxes. Signal groups are inspected through their cards; invalid or missing engine geometry produces an explicit error.

The viewer uses ELK placement as the starting point, then reroutes initial edges with a stable heuristic for scenes up to 320 edges. Long forward edges establish the main channels, shorter edges avoid those channels, feedback edges are processed last, and one improvement pass keeps lower-cost routes. Larger scenes retain ELK's valid routes and only pay for required repairs, so dense scopes remain responsive.

The SVG renderer combines coincident bus paths and draws one trunk path per bus and module pair. The top-right signal inspector lists every net in a bus without changing the canvas. Dependencies that point back toward an earlier layer use an outer feedback lane when obstacle clearance permits. ELK runs when a scope has no cached scene. Dragging updates transforms and paths once per animation frame; pan and zoom only change the camera. Hover and selection use pointer-transparent overlays with stroke widths independent of zoom. Scope changes abort downloads, terminate obsolete workers and reject late results. The controller keeps four recent scenes and persists camera, group and module-position preferences separately from treemap/chart state. The worker is released after initial layout.

Schematic loads `viewer-schematic.js`, `viewer-schematic-worker.js` and the current scope's JSON on demand. All viewer assets and source copies are local. Node and npm are build-time tools; viewing requires no CDN, external layout service or Node server. Default bundles use the built-in service for scope generation; bundles generated with `--schematic` use ordinary static HTTP. See [Export and bundle contracts](export-and-bundle-contracts.md#schematic-data) for the data, cache and service contracts.

## Layout references

[ELK Layered](https://eclipse.dev/elk/reference/algorithms/org-eclipse-elk-layered.html) supports directed graphs, orthogonal routing and [fixed port constraints](https://eclipse.dev/elk/reference/options/org-eclipse-elk-portConstraints.html). The local [elkjs package](https://github.com/kieler/elkjs) is distributed under EPL-2.0, with its license text included in the generated worker. Fixed circuit terminals and compact interfaces are the reason for using this layout family. No layout engine guarantees a readable full-screen diagram for an arbitrarily large scope; entering a child scope and inspecting individual buses provide the detailed view.

## Verification

Run the frontend checks from the repository root:

```sh
npm run typecheck
npm test
npm run test:browser
npm run test:schematic-ui
npm run test:schematic-lazy
npm run build
npm run check:generated
```

Rust changes require `cargo check` and `cargo clippy --all-targets --all-features -- -D warnings`. TypeScript checks project code in strict mode; `skipLibCheck` avoids elkjs's invalid optional-children indexing inside its own declaration file. The semantic RTL exporter regression is separate from the definition-statistics cache fixture:

```sh
python3 cpp-hier-exporter/tests/test_semantic_schematic.py /path/to/slang-hier-exporter
```

Browser tests use actual local layout workers and inspect geometry during gestures. They retain screenshots under `target/schematic-evidence/browser/`. LinkNan acceptance results and screenshots are local validation artifacts under `target/schematic-evidence/`; generated design data is not part of the repository.
