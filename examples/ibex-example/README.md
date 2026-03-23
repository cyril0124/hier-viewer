# Ibex Example

This example uses the `lowRISC/ibex` RTL as a simple, reproducible input for `hier-viewer`.

The Ibex source tree is pinned as a git submodule at:

- `examples/ibex-example/ibex`

This directory keeps the example intentionally simple:

- static filelists are committed directly
- no generator script is required
- two short wrapper scripts cover the common entry points

## Requirements

- a built `hier-viewer` binary

Build the viewer from the repo root:

```bash
cargo build --release
```

Initialize the submodule if needed:

```bash
git submodule update --init --recursive examples/ibex-example/ibex
```

## Run

From the repo root:

```bash
examples/ibex-example/run-core.sh
examples/ibex-example/run-system.sh
```

The scripts use these fixed tops:

- `run-core.sh`: `ibex_top`
- `run-system.sh`: `ibex_simple_system`

By default the scripts write outputs to:

- `examples/ibex-example/out-core/`
- `examples/ibex-example/out-system/`

They also start `hier-viewer --preview` by default. To disable the preview server:

```bash
HIER_VIEWER_EXAMPLE_PREVIEW=0 examples/ibex-example/run-core.sh
HIER_VIEWER_EXAMPLE_PREVIEW=0 examples/ibex-example/run-system.sh
```

To override the output directory for one run:

```bash
HIER_VIEWER_EXAMPLE_OUT=/tmp/ibex-view examples/ibex-example/run-core.sh
```

Extra arguments are forwarded to `hier-viewer` before the fixed `-- --top ... --single-unit` suffix. For example:

```bash
examples/ibex-example/run-core.sh --preview-host 0.0.0.0 --preview-port 9000
```

`run-system.sh` also passes `-D RVFI` because the tracing wrapper in Ibex requires it.
