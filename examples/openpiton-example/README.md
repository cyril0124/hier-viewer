# OpenPiton Example

This example uses a fixed 2x2 OpenPiton chip-level RTL configuration as a real-world input for `hier-viewer`.

The OpenPiton source tree is pinned as a git submodule at:

- `examples/openpiton-example/openpiton`

The wrapper in this directory keeps the flow open-source only:

- it reads OpenPiton `.core` manifests
- it runs OpenPiton's own `pyhp.py` preprocessor for every required `.pyv`
- it writes a generated filelist under `examples/openpiton-example/generated/`
- it launches `hier-viewer` on that generated filelist
- it fixes the manycore topology to 2x2 tiles

No VCS or other proprietary simulator is required.

## Requirements

- `python3`
- `PyYAML`
- a built `hier-viewer` binary

Build the viewer from the repo root:

```bash
cargo build --release
```

Initialize the submodule if needed:

```bash
git submodule update --init --recursive examples/openpiton-example/openpiton
```

## Run

From the repo root:

```bash
examples/openpiton-example/run.sh
```

The script will:

1. generate `examples/openpiton-example/generated/openpiton-chip.f`
2. generate the OpenPiton RTL with a fixed 2x2 tile topology
3. pin the hierarchy top to `chip`
4. write the viewer output to `examples/openpiton-example/out/`
5. start `hier-viewer --preview` by default

The current example is intentionally fixed to a 2x2 manycore layout.

If you want to disable the preview server:

```bash
HIER_VIEWER_EXAMPLE_PREVIEW=0 examples/openpiton-example/run.sh
```

If you want to change the output directory:

```bash
HIER_VIEWER_EXAMPLE_OUT=/tmp/openpiton-view examples/openpiton-example/run.sh
```

Extra arguments are forwarded to `hier-viewer` before the fixed `-- --top chip --single-unit` suffix. For example:

```bash
examples/openpiton-example/run.sh --preview-host 0.0.0.0 --preview-port 9000
```

## Generated Artifacts

Generated files are intentionally kept outside the submodule:

- `examples/openpiton-example/generated/`
- `examples/openpiton-example/out/`

This keeps the OpenPiton checkout clean while still making the example reproducible.
