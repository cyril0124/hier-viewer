# Area Sizing Strategy

## Goal

The hierarchy treemap supports multiple sizing metrics so users can choose what "large" means for a node.

Current metrics:

- `instances`: size by subtree instance count
- `leaves`: size by subtree leaf count
- `signals`: size by subtree signal bits
- `weighted_signals`: size by subtree weighted signal bits using user-configurable variable/net coefficients

Current layout modes:

- `classic`: preserve the older binary-split visual style
- `accurate`: use a floorplan-style weighted slicing layout that keeps area proportional and makes dominant blocks read more clearly

Current decomposition modes:

- `subtree only`: render only child subtree blocks inside each hierarchy node
- `subtree + local self`: reserve an explicit `self` block for the current node's local contribution

The `signals` metric exists to reflect module implementation weight more directly than pure hierarchy fanout.
It is now bit-aware, so wide arrays and buses contribute proportionally to their total bit width.

## Data Flow

The sizing data flows through two stages:

1. `hier-viewer.py`
   Exports hierarchy CSV with per-module signal statistics and bit totals.
2. `rust-hier-viewer`
   Parses those CSV fields, stores them on each node, and uses the selected metric to drive treemap area.
3. HTML viewer
   Applies the selected layout mode and decomposition mode to decide how area should be visualized.

## CSV Fields

`hier-viewer.py --csv` emits these per-module columns:

- `module_port_count`
- `module_logic_count`
- `module_reg_count`
- `module_wire_count`
- `module_variable_count`
- `module_net_count`
- `module_signal_count`
- `module_variable_bits`
- `module_net_bits`
- `module_signal_bits`

Compatibility notes:

- The count fields are retained for diagnostics and CSV compatibility.
- The `signals` area metric now uses subtree-aggregated bit totals derived from the bit fields, not the raw count fields.

The core exported bit fields are:

- `module_variable_bits`
- `module_net_bits`
- `module_signal_bits`

With:

- `module_signal_bits = module_variable_bits + module_net_bits`

The viewer then derives:

- `subtree_variable_bits`
  Sum of `module_variable_bits` for the current node and all descendants
- `subtree_net_bits`
  Sum of `module_net_bits` for the current node and all descendants
- `subtree_signal_bits`
  Sum of `module_signal_bits` for the current node and all descendants

## How Python Collects Metrics

Implementation lives in [hier-viewer.py](/nfs/home/zhengchuyu/workspace/project/hier-viewer/hier-viewer.py).

The exporter walks the elaborated instance hierarchy from `topInstances` downward and collects two kinds of data:

1. Instance metadata
   Hierarchy path, module name, source location, definition location, and lightweight declaration-shape counts.
2. Elaborated local signal symbols
   Each instance body is scanned for local `pyslang.VariableSymbol` and `pyslang.NetSymbol` members, and nested scopes / child instances are traversed recursively.

For bit sizing, the exporter uses:

- `symbol.declaredType.type.bitstreamWidth`

This is the important part of the bit-aware change:

- it reflects the total flattened bit width of the symbol
- unpacked dimensions are included
- wide memories / arrays therefore scale correctly

Example:

- `reg [117:0] Memory[0:1];`
  contributes `236` bits, not `1`

Aggregation rules:

- `module_variable_count`
  Number of local variable-backed symbols in the module body
- `module_net_count`
  Number of local net-backed symbols in the module body
- `module_signal_count`
  `module_variable_count + module_net_count`
- `module_variable_bits`
  Sum of `bitstreamWidth` for local variable-backed symbols
- `module_net_bits`
  Sum of `bitstreamWidth` for local net-backed symbols
- `module_signal_bits`
  `module_variable_bits + module_net_bits`

Important details:

- Bit totals are local to the current module instance, not recursive subtree sums.
- Aggregation is done while recursively traversing each instance body, so symbols inside nested generate / procedural scopes still roll up to the correct module instance.
- Instance rows are materialized after traversal, which avoids traversal-order races where metrics could otherwise be emitted before symbol collection finished.
- The exporter still caches per-definition shape counts for repeated module definitions so repeated instantiations do not re-scan syntax structure.

## Why Only Variables And Nets Matter

For sizing, only the elaborated low-level symbol categories matter:

- variable-backed symbols
- net-backed symbols

This matches the intended simplification:

- `reg`, `logic`, explicit port syntax, and `wire` are useful for diagnostics
- but the sizing model ultimately reduces everything to variable bits plus net bits

That keeps the metric simple while preserving bit accuracy.

## How Rust Uses Metrics

Rust-side implementation lives in:

- [model.rs](/nfs/home/zhengchuyu/workspace/project/hier-viewer/rust-hier-viewer/src/model.rs)
- [input.rs](/nfs/home/zhengchuyu/workspace/project/hier-viewer/rust-hier-viewer/src/input.rs)
- [viewer.rs](/nfs/home/zhengchuyu/workspace/project/hier-viewer/rust-hier-viewer/src/viewer.rs)
- [html.rs](/nfs/home/zhengchuyu/workspace/project/hier-viewer/rust-hier-viewer/src/html.rs)

The Rust viewer:

- Parses both the legacy count fields and the bit fields from CSV
- Stores local per-module values on each rendered `Node`
- Computes subtree-aggregated variable bits, net bits, signal counts, and signal bits during tree stat propagation
- Exposes `signals` and `weighted_signals` as selectable metrics in the UI and CLI
- Uses `node.subtreeSignalBits` as the treemap weight when `signals` is selected
- Uses `node.subtreeVariableBits * variable_weight + node.subtreeNetBits * net_weight` when `weighted_signals` is selected

Important: the metric name `signals` remains available for CLI / UI compatibility, and its weight is subtree-aggregated and bit-aware.

## Weighted Signal Metric

`weighted_signals` is a user-tunable heuristic:

- `weighted_bits = variable_weight * subtree_variable_bits + net_weight * subtree_net_bits`

Defaults:

- `variable_weight = 1.00`
- `net_weight = 0.15`

Why it exists:

- plain `signals` treats variable bits and net bits equally
- some users want a rougher implementation-weight view where stored / variable-backed bits count more than pure connectivity bits

How it is configured:

- the HTML viewer exposes two numeric controls next to `Sizing` when `Weighted Signal Bits` is selected
- users can change `Var` and `Net` interactively
- the chosen values are persisted in local storage for that generated bundle path

This metric is intentionally heuristic. It is not a synthesis-area estimator.

## Decomposition Modes

The viewer now separates three related questions:

1. What is the node weight?
   Controlled by the sizing metric.
2. Which treemap engine should be used?
   Controlled by the layout mode.
3. How should the chosen weight be decomposed inside a parent node?
   Controlled by the decomposition mode.

### Classic

This is the previous viewer style.

- Uses the original binary split layout
- Does not expose local-self decomposition
- Good when you want the older, cleaner hierarchy look

### Accurate

This is the newer, more area-faithful mode.

- Uses a floorplan-style weighted slicing layout instead of a squarified treemap
- Anchors dominant blocks first, then packs smaller siblings into side regions so the picture reads more like a backend hierarchy/floorplan viewer
- Supports both decomposition modes below
- Better when proportional area fidelity matters, but you still want a stable and readable hierarchy picture

### Subtree Only

This is the cleaner, traditional hierarchy treemap mode.

- A node acts as a container.
- Only child subtree blocks are laid out inside it.
- The node's own local contribution is included in the node's aggregate weight, but it does not get a dedicated rectangle.

This mode is visually compact but can under-explain why a parent looks "too large" when the parent module itself carries many local bits.

### Subtree + Local Self

This mode is the more faithful bit-distribution view.

- A node's interior is laid out using:
  - one synthetic `self` edge strip with weight equal to the node's local contribution
  - one block per child instance using each child's subtree weight in the remaining interior
- For `signals`, the synthetic block weight is `module_signal_bits`
- For `instances`, the synthetic block weight is `1`
- For `leaves`, the synthetic block weight is `1` only for a leaf node, otherwise `0`

This makes the parent / child split explicit:

- `node subtree weight = node local self weight + sum(child subtree weights)`

So when a module has very large local memories, buses, or internal storage, that contribution now has a visible dedicated area instead of being hidden inside the parent container.

## Layout Engine

The HTML viewer now supports two layout engines:

- `classic`
  the original binary split heuristic
- `accurate`
  a floorplan-style weighted slicing layout with proportional area

Why this matters:

- binary splitting preserves the older familiar look but is only loosely area-faithful
- floorplan-style weighted slicing makes dominant blocks obvious while keeping smaller siblings visible in side regions
- together with `subtree + local self`, the accurate mode tracks bit weight much more closely while keeping local contribution readable as a reserved edge strip

This is still a UI layout, not a mathematically perfect synthesis-area model, but it is a more faithful representation of the selected weight metric.

## UI Behavior

In the generated HTML:

- The metric dropdown shows `Subtree Signal Bits`
- The metric dropdown also shows `Weighted Signal Bits`
- When `Weighted Signal Bits` is active, `Var` and `Net` coefficient inputs appear next to `Sizing`
- The layout dropdown lets users switch between `Classic` and `Accurate`
- The decomposition dropdown lets users choose between `Subtree Only` and `Subtree + Local Self`
- The `--metric signals` and `--metric weighted_signals` CLI options still select these modes
- The hover card shows both:
  - subtree totals: `subtree signal bits / subtree objects`
  - local totals: `local signal bits / local objects`
  - weighted totals using the current `Var` / `Net` coefficients

This gives users a quick way to validate the new sizing behavior against the raw declaration counts.

## Why This Metric Is Optional

Different metrics answer different questions:

- `instances`
  Better for structural breadth / hierarchy fanout
- `leaves`
  Better for endpoint density
- `signals`
  Better for rough implementation weight of a hierarchy region when wide buses and memories should matter
- `weighted_signals`
  Better when you want a user-tunable compromise between local state/storage pressure and connectivity pressure

No single metric is universally correct, so the viewer keeps this as a selectable option instead of replacing the old default.

## Known Limitations

- This is still a hierarchy visualization heuristic, not a synthesis area estimator.
- Two instances of the same module definition are expected to share the same local shape counts, while elaborated symbol widths still come from the actual elaborated symbols encountered under each instance.
- Symbols that do not elaborate into `VariableSymbol` or `NetSymbol` are intentionally outside this metric.
- `weighted_signals` depends on user-chosen coefficients, so different viewers may intentionally show different area emphasis for the same data set.

## Future Extensions

Possible next steps if needed:

- Add separate metrics for `variable bits` vs `net bits`
- Add user-facing legend text explaining the selected metric
