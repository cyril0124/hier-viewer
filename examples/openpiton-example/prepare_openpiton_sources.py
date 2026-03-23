#!/usr/bin/env python3

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any

try:
    import yaml
except ImportError as exc:  # pragma: no cover - dependency check
    raise SystemExit(
        "PyYAML is required for examples/openpiton-example. Install it with "
        "`python3 -m pip install pyyaml`."
    ) from exc


ROOT_DIR = Path(__file__).resolve().parent
OPENPITON_ROOT = ROOT_DIR / "openpiton"
PITON_ROOT = OPENPITON_ROOT / "piton"
GENERATED_ROOT = ROOT_DIR / "generated"
FILELIST_PATH = GENERATED_ROOT / "openpiton-chip.f"
SUMMARY_PATH = GENERATED_ROOT / "openpiton-chip.json"
ROOT_VLNV = "openpiton::chip"
PREFERRED_TARGET = "pickle"
TOP_MODULE = "chip"
X_TILES = 2
Y_TILES = 2
NUM_TILES = X_TILES * Y_TILES
NETWORK_CONFIG = "2dmesh_config"


@dataclass(frozen=True)
class Core:
    name: str
    short_name: str
    path: Path
    data: dict[str, Any]

    @property
    def base_dir(self) -> Path:
        return self.path.parent

    @property
    def generated_dir(self) -> Path:
        return GENERATED_ROOT / self.path.relative_to(OPENPITON_ROOT).parent


class OrderedPaths:
    def __init__(self) -> None:
        self._seen: set[Path] = set()
        self.items: list[Path] = []

    def add(self, path: Path) -> None:
        resolved = path.resolve()
        if resolved in self._seen:
            return
        self._seen.add(resolved)
        self.items.append(resolved)


class Builder:
    def __init__(self) -> None:
        self.core_by_name: dict[str, Core] = {}
        self.core_by_short_name: dict[str, Core] = {}
        self.incdirs = OrderedPaths()
        self.header_units = OrderedPaths()
        self.sources = OrderedPaths()
        self.generated_outputs = OrderedPaths()
        self.visiting: set[str] = set()
        self.visited: set[str] = set()

    def load_cores(self) -> None:
        for core_path in sorted(PITON_ROOT.rglob("*.core")):
            text = core_path.read_text(encoding="utf-8")
            yaml_text = "\n".join(text.splitlines()[1:])
            data = yaml.safe_load(yaml_text) or {}
            name = data["name"]
            short_name = strip_version(name)
            core = Core(name=name, short_name=short_name, path=core_path.resolve(), data=data)
            self.core_by_name[name] = core
            previous = self.core_by_short_name.get(short_name)
            if previous is not None and previous.name != name:
                raise SystemExit(
                    f"ambiguous short VLNV '{short_name}' between "
                    f"'{previous.name}' and '{name}'"
                )
            self.core_by_short_name[short_name] = core

    def resolve_core(self, name: str) -> Core:
        normalized = strip_conditional(name)
        if normalized is None:
            raise KeyError(name)
        core = self.core_by_name.get(normalized)
        if core is not None:
            return core
        core = self.core_by_short_name.get(normalized)
        if core is not None:
            return core
        raise KeyError(normalized)

    def visit(self, name: str) -> None:
        core = self.resolve_core(name)
        if core.name in self.visited:
            return
        if core.name in self.visiting:
            raise SystemExit(f"dependency cycle detected at '{core.name}'")

        self.visiting.add(core.name)
        target = select_target(core.data, PREFERRED_TARGET)
        fileset_names = normalize_list(target.get("filesets"))
        generate_names = normalize_list(target.get("generate"))

        for fileset_name in fileset_names:
            if is_conditional_token(fileset_name):
                continue
            fileset = (core.data.get("filesets") or {}).get(fileset_name)
            if fileset is None:
                raise SystemExit(f"missing fileset '{fileset_name}' in {core.path}")
            for dep in normalize_list(fileset.get("depend")):
                dep_name = strip_conditional(dep)
                if dep_name is None:
                    continue
                self.visit(dep_name)

        for generate_name in generate_names:
            self.run_generator(core, generate_name)

        for fileset_name in fileset_names:
            if is_conditional_token(fileset_name):
                continue
            fileset = (core.data.get("filesets") or {}).get(fileset_name)
            if fileset is None:
                continue
            self.collect_files(core, fileset)

        self.visiting.remove(core.name)
        self.visited.add(core.name)

    def run_generator(self, core: Core, generate_name: str) -> None:
        spec = ((core.data.get("generate") or {}).get(generate_name)) or {}
        pairs = ((spec.get("parameters") or {}).get("process_me")) or []
        if not pairs:
            return

        pyhp = PITON_ROOT / "tools" / "bin" / "pyhp.py"
        env = make_pyhp_env()
        core.generated_dir.mkdir(parents=True, exist_ok=True)

        for input_name, output_name in pairs:
            input_path = core.base_dir / input_name
            output_path = core.generated_dir / output_name
            output_path.parent.mkdir(parents=True, exist_ok=True)
            with output_path.open("w", encoding="utf-8") as handle:
                subprocess.run(
                    [sys.executable, str(pyhp), input_name],
                    cwd=core.base_dir,
                    env=env,
                    stdout=handle,
                    check=True,
                )
            self.generated_outputs.add(output_path)
            self.incdirs.add(output_path.parent)
            if is_header_path(output_path):
                self.header_units.add(output_path)
            elif output_path.suffix == ".v":
                self.sources.add(output_path)

    def collect_files(self, core: Core, fileset: dict[str, Any]) -> None:
        for entry in normalize_list(fileset.get("files")):
            path_text, metadata = parse_file_entry(entry)
            file_path = (core.base_dir / path_text).resolve()
            if not file_path.exists():
                raise SystemExit(f"referenced file does not exist: {file_path}")

            is_include = bool(metadata.get("is_include_file"))
            if is_include and is_verilog_text_path(file_path):
                self.header_units.add(file_path)
            elif not is_include and is_source_path(file_path):
                self.sources.add(file_path)
            self.incdirs.add(file_path.parent)

    def write_outputs(self) -> None:
        GENERATED_ROOT.mkdir(parents=True, exist_ok=True)
        with FILELIST_PATH.open("w", encoding="utf-8") as handle:
            handle.write(f"// Generated by {Path(__file__).name}\n")
            handle.write(f"// Root VLNV: {ROOT_VLNV}\n")
            handle.write(f"// Preferred target: {PREFERRED_TARGET}\n")
            handle.write(f"// Top module: {TOP_MODULE}\n")
            handle.write(f"// Tiles: {X_TILES}x{Y_TILES} ({NUM_TILES} total)\n")
            handle.write(f"// Network config: {NETWORK_CONFIG}\n")
            for incdir in self.incdirs.items:
                handle.write(f"+incdir+{incdir}\n")
            for header in self.header_units.items:
                handle.write(f"{header}\n")
            for source in self.sources.items:
                handle.write(f"{source}\n")

        openpiton_commit = subprocess.run(
            ["git", "-C", str(OPENPITON_ROOT), "rev-parse", "HEAD"],
            check=True,
            capture_output=True,
            text=True,
        ).stdout.strip()

        summary = {
            "root_vlnv": ROOT_VLNV,
            "preferred_target": PREFERRED_TARGET,
            "top_module": TOP_MODULE,
            "x_tiles": X_TILES,
            "y_tiles": Y_TILES,
            "num_tiles": NUM_TILES,
            "network_config": NETWORK_CONFIG,
            "openpiton_commit": openpiton_commit,
            "filelist": str(FILELIST_PATH.resolve()),
            "include_dir_count": len(self.incdirs.items),
            "header_unit_count": len(self.header_units.items),
            "source_count": len(self.sources.items),
            "generated_output_count": len(self.generated_outputs.items),
        }
        SUMMARY_PATH.write_text(json.dumps(summary, indent=2) + "\n", encoding="utf-8")


def normalize_list(value: Any) -> list[Any]:
    if value is None:
        return []
    if isinstance(value, list):
        return value
    return [value]


def strip_version(name: str) -> str:
    return name.rsplit(":", 1)[0] if name.count(":") >= 2 else name


def is_conditional_token(value: str) -> bool:
    return "? (" in value and value.endswith(")")


def strip_conditional(value: str | None) -> str | None:
    if value is None:
        return None
    stripped = value.strip()
    if is_conditional_token(stripped):
        return None
    return stripped


def select_target(data: dict[str, Any], preferred: str) -> dict[str, Any]:
    targets = data.get("targets") or {}
    if preferred in targets:
        return targets[preferred] or {}
    if "default" in targets:
        return targets["default"] or {}
    return {}


def parse_file_entry(entry: Any) -> tuple[str, dict[str, Any]]:
    if isinstance(entry, str):
        return entry, {}
    if isinstance(entry, dict) and len(entry) == 1:
        path_text, metadata = next(iter(entry.items()))
        return path_text, metadata or {}
    raise SystemExit(f"unsupported file entry format: {entry!r}")


def is_source_path(path: Path) -> bool:
    return path.suffix in {".v", ".sv"}


def is_header_path(path: Path) -> bool:
    return path.suffix in {".h", ".vh", ".svh"}


def is_verilog_text_path(path: Path) -> bool:
    return is_source_path(path) or is_header_path(path)


def make_pyhp_env() -> dict[str, str]:
    env = os.environ.copy()
    env.update(
        {
            "PITON_ROOT": str(OPENPITON_ROOT),
            "DV_ROOT": str(PITON_ROOT),
            "MODEL_DIR": str(OPENPITON_ROOT / "build"),
            "PITON_X_TILES": str(X_TILES),
            "PITON_Y_TILES": str(Y_TILES),
            "PITON_NUM_TILES": str(NUM_TILES),
            "PITON_NETWORK_CONFIG": NETWORK_CONFIG,
            "PROTOSYN_RUNTIME_DESIGN_PATH": str(PITON_ROOT / "verif" / "env"),
            "PROTOSYN_RUNTIME_BOARD": "manycore",
            "PYTHONWARNINGS": "ignore::SyntaxWarning",
        }
    )
    return env


def clean_generated_dir() -> None:
    try:
        shutil.rmtree(GENERATED_ROOT)
    except FileNotFoundError:
        return


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Generate an OpenPiton chip filelist for hier-viewer."
    )
    parser.add_argument(
        "--keep-existing",
        action="store_true",
        help="reuse the current generated directory instead of cleaning it first",
    )
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    if not OPENPITON_ROOT.exists():
        raise SystemExit(
            "OpenPiton submodule is missing. Run "
            "`git submodule update --init --recursive examples/openpiton-example/openpiton`."
        )

    if not args.keep_existing:
        clean_generated_dir()

    builder = Builder()
    builder.load_cores()
    builder.visit(ROOT_VLNV)
    builder.write_outputs()

    print(f"Generated filelist: {FILELIST_PATH.resolve()}")
    print(f"Tiles: {X_TILES}x{Y_TILES} ({NUM_TILES} total)")
    print(f"Include directories: {len(builder.incdirs.items)}")
    print(f"Header units: {len(builder.header_units.items)}")
    print(f"Source files: {len(builder.sources.items)}")
    print(f"Generated outputs: {len(builder.generated_outputs.items)}")


if __name__ == "__main__":
    main()
