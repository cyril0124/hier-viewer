#!/usr/bin/env python3
"""Check include dependency cache invalidation using an already-built viewer."""

import argparse
from contextlib import closing
import os
from pathlib import Path
import shutil
import sqlite3
import subprocess
import tempfile


def run_viewer(viewer, workspace, args):
    result = subprocess.run(
        [str(viewer), "--no-wizard", *map(str, args)],
        cwd=workspace,
        env={**os.environ, "HIER_VIEWER_LOG_COLOR": "0"},
        stdin=subprocess.DEVNULL,
        capture_output=True,
        text=True,
        timeout=60,
    )
    logs = result.stdout + result.stderr
    assert result.returncode == 0, logs
    return logs


def snapshot(database):
    with closing(sqlite3.connect(database)) as db:
        return {
            "instances": db.execute(
                "SELECT path, module, module_signal_count, module_signal_bits "
                "FROM instances ORDER BY path"
            ).fetchall(),
            "signals": db.execute(
                "SELECT d.module, s.signal_name, s.signal_kind, s.signal_count, s.total_bits "
                "FROM definition_signal_stats s "
                "JOIN definitions d USING (definition_key) "
                "ORDER BY d.module, s.signal_name, s.signal_kind"
            ).fetchall(),
        }


def check_include_mode(viewer, root, mode):
    workspace = root / mode
    includes = workspace / "include"
    includes.mkdir(parents=True)
    source = workspace / "top.sv"
    header = includes / "defs.svh"
    source.write_text(
        '`include "defs.svh"\n'
        "module top #(parameter WIDTH = `WIDTH);\n"
        "  logic [WIDTH-1:0] payload;\n"
        "endmodule\n",
        encoding="utf-8",
    )
    header.write_text("`define WIDTH 8\n", encoding="utf-8")
    output = workspace / "out"
    include_args = ["-I", includes] if mode == "dash-I" else [f"+incdir+{includes}"]
    args = ["-o", output, source, "--", *include_args, "--top", "top"]
    first = run_viewer(viewer, workspace, args)
    assert "Hierarchy exporter finished" in first, first
    databases = list((output / ".hier-viewer-cache").glob("*.sqlite"))
    assert len(databases) == 1, databases
    database = databases[0]
    with closing(sqlite3.connect(database)) as db:
        dependencies = db.execute("SELECT path FROM source_dependencies ORDER BY path").fetchall()
        assert dependencies == sorted([(str(source.resolve()),), (str(header.resolve()),)])
        signature = db.execute("SELECT dependency_signature FROM cache_metadata").fetchone()[0]
        assert signature
    initial = snapshot(database)
    assert initial["signals"] == [("top", "payload", "variable", 1, 8)], initial
    cached = run_viewer(viewer, workspace, args)
    assert "Reusing cached sqlite export" in cached, cached
    assert "Hierarchy exporter finished" not in cached, cached

    header.write_text("`define WIDTH 32\n", encoding="utf-8")
    changed = run_viewer(viewer, workspace, args)
    assert "cache miss: source dependency fingerprint changed" in changed, changed
    assert "Hierarchy exporter finished" in changed, changed
    assert "Reusing cached sqlite export" not in changed, changed
    assert list((output / ".hier-viewer-cache").glob("*.sqlite")) == [database]
    ordinary = snapshot(database)
    assert ordinary["signals"] == [("top", "payload", "variable", 1, 32)], ordinary
    assert ordinary != initial
    with closing(sqlite3.connect(database)) as db:
        assert db.execute("SELECT dependency_signature FROM cache_metadata").fetchone()[0] != signature

    forced = run_viewer(viewer, workspace, ["--rebuild-sqlite", *args])
    assert "Force rebuilding" in forced, forced
    assert snapshot(database) == ordinary

    standalone = workspace / "standalone.sqlite"
    shutil.copyfile(database, standalone)
    with closing(sqlite3.connect(standalone)) as db:
        db.execute("DROP TABLE cache_metadata")
        db.execute("DROP TABLE source_dependencies")
        db.commit()
    run_viewer(viewer, workspace, ["--db", standalone, "-o", workspace / "db-out"])
    assert (workspace / "db-out" / "index.html").is_file()
    print(f"PASS {mode}: unchanged cache hit, header change rebuilt, equals force, --db independent")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("viewer", type=Path, help="path to the built hier-viewer executable")
    viewer = parser.parse_args().viewer.resolve(strict=True)
    with tempfile.TemporaryDirectory(prefix="hier-viewer-cache-dependencies-") as temporary:
        root = Path(temporary)
        for mode in ("dash-I", "plus-incdir"):
            check_include_mode(viewer, root, mode)


if __name__ == "__main__":
    main()
