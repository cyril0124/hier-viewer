#!/usr/bin/env python3
"""Assert semantic net identities using a real slang v11 exporter binary."""

import argparse
from contextlib import contextmanager
from pathlib import Path
from queue import Empty, Queue
import sqlite3
import subprocess
import tempfile
from threading import Thread
import unittest

FIXTURE = Path(__file__).with_name("semantic_schematic.sv").resolve()
TABLES = ("schematic_scopes", "schematic_nodes", "schematic_ports", "schematic_nets", "schematic_endpoints")


def export(binary, directory, reverse=False, top="semantic_top", extra=(), schematic=True):
    database = directory / f"{top}-{reverse}.db"
    command = [str(binary), "--sqlite", "-o", str(database), "--top", top]
    if schematic:
        command.append("--schematic")
    if reverse:
        command.append("+define+REVERSE_ORDER")
    subprocess.run([*command, *extra, str(FIXTURE)], check=True, timeout=60, capture_output=True)
    db = sqlite3.connect(database)
    db.row_factory = sqlite3.Row
    return db


class SemanticTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.directory = tempfile.TemporaryDirectory(prefix="hier-schematic-")
        cls.exports = [export(cls.binary, Path(cls.directory.name), reverse) for reverse in (False, True)]
        cls.empty = export(cls.binary, Path(cls.directory.name), top="empty_cell")

    @classmethod
    def tearDownClass(cls):
        for db in [*cls.exports, cls.empty]:
            db.close()
        cls.directory.cleanup()

    def endpoints(self, db, scope, node, port):
        return {(row[0], row[1]) for row in db.execute(
            "SELECT e.net_id,e.role FROM schematic_endpoints e JOIN schematic_ports p "
            "ON p.scope_path=e.scope_path AND p.node_id=e.node_id AND p.id=e.port_id "
            "WHERE e.scope_path=? AND e.node_id=? AND p.name=?", (scope, node, port))}

    def test_schema_and_empty_scopes(self):
        for db in [*self.exports, self.empty]:
            self.assertEqual([tuple(row) for row in db.execute("SELECT * FROM schematic_metadata")], [(1,)])
            self.assertEqual({row[0] for row in db.execute("SELECT path FROM instances")},
                             {row[0] for row in db.execute("SELECT path FROM schematic_scopes")})
            for table in TABLES:
                db.execute(f"SELECT * FROM {table} LIMIT 1")
            self.assertEqual(db.execute(
                "SELECT count(*) FROM schematic_endpoints e LEFT JOIN schematic_ports p "
                "ON p.scope_path=e.scope_path AND p.node_id=e.node_id AND p.id=e.port_id "
                "LEFT JOIN schematic_nets n ON n.scope_path=e.scope_path AND n.id=e.net_id "
                "WHERE p.id IS NULL OR n.id IS NULL").fetchone()[0], 0)
        for table in TABLES[1:]:
            self.assertEqual(self.empty.execute(f"SELECT count(*) FROM {table}").fetchone()[0], 0)

    def test_default_sqlite_has_no_schematic_tables(self):
        with tempfile.TemporaryDirectory(prefix="hier-default-") as directory:
            db = export(self.binary, Path(directory), schematic=False)
            try:
                self.assertEqual(list(db.execute(
                    "SELECT name FROM sqlite_master WHERE type='table' AND name GLOB 'schematic_*'")), [])
                self.assertEqual({row[0] for row in db.execute("SELECT path FROM instances")},
                                 {row[0] for row in self.exports[0].execute("SELECT path FROM instances")})
            finally:
                db.close()

    def test_scoped_export_matches_full_graph(self):
        cases = [("semantic_top", scope, self.exports[0]) for scope in
                 ("semantic_top", "semantic_top.first", "semantic_top.first.lanes[0].first")]
        cases.append(("empty_cell", "empty_cell", self.empty))
        for top, scope, full in cases:
            with self.subTest(scope=scope), tempfile.TemporaryDirectory(prefix="hier-scope-") as directory:
                db = export(self.binary, Path(directory), top=top, schematic=False,
                            extra=("--schematic-scope", scope))
                try:
                    self.assertEqual([tuple(row) for row in db.execute("SELECT * FROM schematic_metadata")], [(1,)])
                    self.assertEqual([row[0] for row in db.execute("SELECT path FROM schematic_scopes")], [scope])
                    self.assertEqual({row[0] for row in db.execute("SELECT path FROM instances")},
                                     {row[0] for row in full.execute("SELECT path FROM instances")})
                    for table in TABLES[1:]:
                        self.assertCountEqual(
                            [tuple(row) for row in db.execute(f"SELECT * FROM {table}")],
                            [tuple(row) for row in full.execute(
                                f"SELECT * FROM {table} WHERE scope_path=?", (scope,))], table)
                    self.assertEqual(db.execute(
                        "SELECT count(*) FROM schematic_nodes n LEFT JOIN instances i "
                        "ON i.path=n.instance_path WHERE n.instance_path IS NOT NULL AND i.path IS NULL").fetchone()[0], 0)
                finally:
                    db.close()

    @contextmanager
    def worker(self, baseline, output):
        with tempfile.TemporaryFile() as diagnostics:
            process = subprocess.Popen(
                [str(self.binary), "--sqlite", "--schematic-worker", str(baseline),
                 "-o", str(output), "--top", "semantic_top", str(FIXTURE)],
                stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=diagnostics)
            messages = Queue()

            def read_messages():
                for line in process.stdout:
                    messages.put(line)

            reader = Thread(target=read_messages, daemon=True)
            reader.start()

            def expect(line, request=None):
                if request is not None:
                    process.stdin.write(request.encode("utf-8") + b"\n")
                    process.stdin.flush()
                try:
                    actual = messages.get(timeout=60)
                except Empty:
                    self.fail(f"worker timed out waiting for {line!r}; exit={process.poll()}")
                self.assertEqual(actual, line.encode("ascii") + b"\n")

            try:
                expect("HIER_SCHEMATIC_READY")
                yield expect, diagnostics
                process.stdin.close()
                self.assertEqual(process.wait(timeout=10), 0)
                reader.join(timeout=10)
                self.assertFalse(reader.is_alive())
                self.assertTrue(messages.empty(), "unexpected extra worker stdout")
                diagnostics.seek(0)
                logs = diagnostics.read().decode("utf-8")
                self.assertNotIn("Collecting hierarchy and signal statistics", logs)
            finally:
                if process.poll() is None:
                    process.kill()
                process.wait(timeout=10)
                reader.join(timeout=10)
                process.stdin.close()
                process.stdout.close()

    def assert_worker_scope(self, output, scope, allowed_paths):
        with sqlite3.connect(output) as db:
            self.assertEqual({row[0] for row in db.execute(
                "SELECT name FROM sqlite_master WHERE type='table'")},
                {"instances", "schematic_metadata", *TABLES})
            self.assertEqual([row[1] for row in db.execute("PRAGMA table_info(instances)")], ["path"])
            self.assertEqual({row[0] for row in db.execute("SELECT path FROM instances")}, allowed_paths)
            self.assertEqual(db.execute("SELECT * FROM schematic_metadata").fetchall(), [(1,)])
            for table in TABLES:
                column = "path" if table == "schematic_scopes" else "scope_path"
                self.assertCountEqual(
                    db.execute(f"SELECT * FROM {table}").fetchall(),
                    [tuple(row) for row in self.exports[0].execute(
                        f"SELECT * FROM {table} WHERE {column}=?", (scope,))], table)
            self.assertEqual(db.execute("PRAGMA integrity_check").fetchone()[0], "ok")

    def test_worker_persists_and_matches_full_export(self):
        baseline = Path(self.directory.name) / "semantic_top-False.db"
        original = baseline.read_bytes()
        allowed = {row[0] for row in self.exports[0].execute("SELECT path FROM instances")}
        with tempfile.TemporaryDirectory(prefix="hier-worker-") as directory:
            output = Path(directory) / "scope with spaces.sqlite"
            with self.worker(baseline, output) as (expect, _):
                for scope in ("semantic_top", "semantic_top.first", "semantic_top"):
                    expect("HIER_SCHEMATIC_OK", scope)
                    self.assert_worker_scope(output, scope, allowed)
                    self.assertEqual(baseline.read_bytes(), original)
        self.assertEqual(baseline.read_bytes(), original)

    def test_worker_invalid_requests_recover_and_rollback(self):
        with tempfile.TemporaryDirectory(prefix="hier-worker-invalid-") as directory:
            baseline = Path(directory) / "hierarchy.sqlite"
            allowed = {row[0] for row in self.exports[0].execute("SELECT path FROM instances")}
            allowed.add("semantic_top.ghost")
            # An allowed path missing from the compilation fails inside the write
            # transaction, after the previous schematic tables have been dropped.
            with sqlite3.connect(baseline) as db:
                db.execute("CREATE TABLE instances(path TEXT PRIMARY KEY)")
                db.executemany("INSERT INTO instances VALUES(?)", [(path,) for path in allowed])
            original = baseline.read_bytes()
            output = Path(directory) / "scope.sqlite"
            with self.worker(baseline, output) as (expect, diagnostics):
                expect("HIER_SCHEMATIC_OK", "semantic_top")
                for scope in ("", "semantic_top.missing", "semantic_top.ghost",
                              "semantic_top.含 空格", "semantic_top\r", "semantic_top\0"):
                    expect("HIER_SCHEMATIC_ERROR", scope)
                    self.assert_worker_scope(output, "semantic_top", allowed)
                    expect("HIER_SCHEMATIC_OK", "semantic_top.first")
                    self.assert_worker_scope(output, "semantic_top.first", allowed)
                    expect("HIER_SCHEMATIC_OK", "semantic_top")
                diagnostics.seek(0)
                self.assertIn("semantic_top.含 空格", diagnostics.read().decode("utf-8"))
            self.assertEqual(baseline.read_bytes(), original)

    def test_worker_uses_baseline_filters(self):
        with tempfile.TemporaryDirectory(prefix="hier-worker-filtered-") as directory:
            root = Path(directory)
            baseline_db = export(self.binary, root, schematic=False, extra=("--depth", "1"))
            baseline_db.close()
            baseline = root / "semantic_top-False.db"
            original = baseline.read_bytes()
            with self.worker(baseline, root / "scope.sqlite") as (expect, _):
                expect("HIER_SCHEMATIC_ERROR", "semantic_top.first")
                expect("HIER_SCHEMATIC_OK", "semantic_top")
                with sqlite3.connect(root / "scope.sqlite") as db:
                    self.assertEqual(db.execute("SELECT path FROM instances").fetchall(), [("semantic_top",)])
                    self.assertGreater(db.execute(
                        "SELECT count(*) FROM schematic_nodes WHERE kind='unresolved' "
                        "AND detail LIKE 'Instance excluded by hierarchy filters:%'").fetchone()[0], 0)
            self.assertEqual(baseline.read_bytes(), original)

    def test_worker_options_and_source_protection(self):
        with tempfile.TemporaryDirectory(prefix="hier-worker-options-") as directory:
            root = Path(directory)
            baseline = root / "hierarchy.sqlite"
            baseline.write_bytes((Path(self.directory.name) / "semantic_top-False.db").read_bytes())
            original = baseline.read_bytes()
            output = root / "scope.sqlite"
            worker_option = ("--schematic-worker", str(baseline))
            cases = [
                ((*worker_option, "-o", str(output)), "requires --sqlite"),
                (("--sqlite", *worker_option), "requires -o"),
                (("--sqlite", "--schematic-worker", "", "-o", str(output)), "non-empty"),
                (("--sqlite", *worker_option, "-o", ""), "non-empty"),
                (("--sqlite", *worker_option, "--schematic", "-o", str(output)), "mutually exclusive"),
                (("--sqlite", *worker_option, "--schematic-scope", "semantic_top", "-o", str(output)), "mutually exclusive"),
                (("--sqlite", "--schematic-worker", str(root / "missing.sqlite"), "-o", str(output)), "unable to open"),
            ]
            symlink = root / "symlink.sqlite"
            symlink.symlink_to(baseline)
            hardlink = root / "hardlink.sqlite"
            hardlink.hardlink_to(baseline)
            for alias in (baseline, symlink, hardlink):
                cases.append((("--sqlite", *worker_option, "-o", str(alias)), "different files"))
            for options, error in cases:
                with self.subTest(options=options):
                    result = subprocess.run(
                        [str(self.binary), *options, "--top", "semantic_top", str(FIXTURE)],
                        input="", timeout=60, capture_output=True, text=True)
                    self.assertNotEqual(result.returncode, 0)
                    self.assertIn(error, result.stderr)
                    self.assertEqual(result.stdout, "")
                    self.assertEqual(baseline.read_bytes(), original)
            self.assertFalse((root / "missing.sqlite").exists())

    def test_invalid_schematic_options_fail(self):
        cases = [
            (("--sqlite", "--schematic-scope", "semantic_top.missing"), "scope not found"),
            (("--sqlite", "--schematic-scope", "semantic_top.fir"), "scope not found"),
            (("--sqlite", "--schematic-scope", "semantic_top.first", "--depth", "1"), "scope not found"),
            (("--sqlite", "--schematic", "--schematic-scope", "semantic_top"), "mutually exclusive"),
            (("--sqlite", "--schematic-scope", ""), "non-empty exact hierarchical path"),
        ]
        for mode in ((), ("--csv",), ("--plain",), ("--tree",), ("--dir",)):
            for option in (("--schematic",), ("--schematic-scope", "semantic_top")):
                cases.append(((*mode, *option), "require --sqlite"))
        for options, error in cases:
            with self.subTest(options=options), tempfile.TemporaryDirectory(prefix="hier-invalid-") as directory:
                result = subprocess.run(
                    [str(self.binary), *options, "-o", str(Path(directory) / "invalid.db"),
                     "--top", "semantic_top", str(FIXTURE)],
                    timeout=60, capture_output=True, text=True)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn(error, result.stderr)

    def test_compilation_errors_are_visible_in_each_scope(self):
        with tempfile.TemporaryDirectory(prefix="hier-partial-") as directory:
            source = Path(directory) / "damaged.sv"
            database = Path(directory) / "damaged.db"
            source.write_text("module damaged(input wire clk); missing_module u(); endmodule\n")
            result = subprocess.run([str(self.binary), "--sqlite", "--schematic", "-o", str(database), "--top", "damaged", str(source)],
                                    check=True, timeout=60, capture_output=True, text=True)
            self.assertIn("Compilation reported errors", result.stderr)
            with sqlite3.connect(database) as db:
                self.assertEqual(db.execute("SELECT kind,label FROM schematic_nodes WHERE id='damaged:elaboration-errors'").fetchone(),
                                 ("unresolved", "Elaboration errors"))

    def test_filelists_skip_c_cpp_dpi_sources(self):
        with tempfile.TemporaryDirectory(prefix="hier-filelist-cpp-") as directory:
            root = Path(directory)
            source = root / "top.sv"
            source.write_text("module filelist_top; endmodule\n")
            (root / "dpi_func.cpp").write_text("this is intentionally not SystemVerilog\n")
            filelist = root / "sources.f"
            filelist.write_text(f"{source}\n{root / 'dpi_func.cpp'}\n")
            database = root / "filelist.db"
            result = subprocess.run([str(self.binary), "--sqlite", "-o", str(database), "-f", str(filelist), "--top", "filelist_top"],
                                    check=True, timeout=60, capture_output=True, text=True)
            self.assertNotIn("dpi_func.cpp", result.stderr)
            with sqlite3.connect(database) as db:
                self.assertEqual(db.execute("SELECT count(*) FROM instances WHERE path='filelist_top'").fetchone()[0], 1)


        for options in (("--depth", "1"), ("--exclude-wildcard", "semantic_leaf")):
            with tempfile.TemporaryDirectory(prefix="hier-filter-") as directory:
                db = export(self.binary, Path(directory), extra=options)
                try:
                    self.assertEqual({row[0] for row in db.execute("SELECT path FROM instances")},
                                     {row[0] for row in db.execute("SELECT path FROM schematic_scopes")})
                    self.assertEqual(db.execute(
                        "SELECT count(*) FROM schematic_nodes n LEFT JOIN instances i "
                        "ON i.path=n.instance_path WHERE n.instance_path IS NOT NULL AND i.path IS NULL").fetchone()[0], 0)
                    self.assertGreater(db.execute(
                        "SELECT count(*) FROM schematic_nodes WHERE kind='unresolved' "
                        "AND instance_path IS NULL AND detail LIKE 'Instance excluded by hierarchy filters:%'").fetchone()[0], 0)
                    self.assertEqual(self.endpoints(db, "semantic_top", "semantic_top.source", "data_i"),
                                     {("net:semantic_top.alpha", "sink")})
                finally:
                    db.close()

    def test_expression_storage_avoids_recursive_text_duplication(self):
        for db in self.exports:
            expression_labels = [row[0] for row in db.execute(
                "SELECT label FROM schematic_nodes WHERE kind='expr'")]
            self.assertTrue(expression_labels)
            self.assertTrue(all(len(label) <= 32 for label in expression_labels))
            nested_details = [row[0] for row in db.execute(
                "SELECT detail FROM schematic_nodes WHERE kind='expr' AND detail LIKE '%operand of %'")]
            self.assertTrue(nested_details)
            self.assertTrue(all(row[0] == "value" for row in db.execute(
                "SELECT name FROM schematic_nets WHERE id LIKE 'expr:%:value'")))


        for db in self.exports:
            keys = {row[0] for row in db.execute(
                "SELECT definition_key FROM instances WHERE path IN ('semantic_top.first','semantic_top.second')")}
            self.assertEqual(len(keys), 1)
            for child, source, target in (("first", "alpha", "result_a"), ("second", "beta", "result_b")):
                node = "semantic_top." + child
                self.assertEqual(self.endpoints(db, "semantic_top", node, "data_i"),
                                 {("net:semantic_top." + source, "sink")})
                self.assertEqual(self.endpoints(db, "semantic_top", node, "data_o"),
                                 {("net:semantic_top." + target, "driver")})
                for lane in range(2):
                    nested = f"{node}.lanes[{lane}].first"
                    self.assertEqual(self.endpoints(db, node, nested, "data_i"),
                                     {(f"net:{node}.data_i", "sink")})
                    self.assertEqual(self.endpoints(db, node, nested, "data_o"),
                                     {(f"net:{node}.lanes[{lane}].local_link", "driver")})
                nested = node + ".lanes[0].chosen.second"
                self.assertEqual(self.endpoints(db, node, nested, "data_i"),
                                 {(f"net:{node}.lanes[0].local_link", "sink")})
                self.assertFalse(any(".first." in row[0] for row in db.execute(
                    "SELECT id FROM schematic_nets WHERE scope_path='semantic_top.second'")))

    def test_fanout_boundaries_and_widths(self):
        for db in self.exports:
            self.assertEqual(db.execute("SELECT name FROM schematic_nets WHERE scope_path='semantic_top' AND id='net:semantic_top.fanout'").fetchone()[0], "fanout")
            fanout = {tuple(row) for row in db.execute(
                "SELECT node_id,role FROM schematic_endpoints WHERE scope_path='semantic_top' AND net_id='net:semantic_top.fanout'")}
            self.assertEqual(fanout, {("semantic_top.source", "driver"), ("semantic_top.sink_a", "sink"),
                                      ("semantic_top.sink_b", "sink")})
            boundaries = {tuple(row) for row in db.execute(
                "SELECT p.name,p.direction,e.role,p.width FROM schematic_nodes n JOIN schematic_ports p "
                "ON p.scope_path=n.scope_path AND p.node_id=n.id JOIN schematic_endpoints e "
                "ON e.scope_path=p.scope_path AND e.node_id=p.node_id AND e.port_id=p.id "
                "WHERE n.scope_path='semantic_top.first' AND n.kind='boundary'")}
            self.assertEqual(boundaries, {("data_i", "input", "driver", 8), ("data_o", "output", "sink", 8)})
            self.assertEqual({row[0] for row in db.execute(
                "SELECT width FROM schematic_ports WHERE scope_path='semantic_top' AND node_id='semantic_top.wide'")}, {16})
            self.assertIn("W = 16", db.execute(
                "SELECT detail FROM schematic_nodes WHERE scope_path='semantic_top' AND id='semantic_top.wide'").fetchone()[0])

    def test_expression_dependencies_constants_and_status(self):
        for db in self.exports:
            details = [row[0] for row in db.execute("SELECT detail FROM schematic_nodes WHERE scope_path='semantic_top'")]
            for kind in ("RangeSelect:", "Concatenation:", "ConditionalOp:", "BinaryOp:", "UnaryOp:"):
                self.assertTrue(any(kind in detail for detail in details), kind)
            self.assertTrue(any("165" in row[0] for row in db.execute(
                "SELECT detail FROM schematic_nodes WHERE kind='constant'")))
            statuses = dict(db.execute("SELECT id,status FROM schematic_nets WHERE scope_path='semantic_top'"))
            self.assertEqual(statuses["net:semantic_top.multidriver"], "multi-driver")
            self.assertEqual(statuses["net:semantic_top.separate_slices"], "resolved")
            self.assertEqual(statuses["net:semantic_top.pad"], "bidirectional")
            self.assertEqual(statuses["net:semantic_top.state"], "unresolved")
            self.assertEqual(statuses["net:semantic_top.initialized_net"], "resolved")
            self.assertEqual(statuses["net:semantic_top.initialized_variable"], "unresolved")
            self.assertEqual(self.endpoints(db, "semantic_top", "semantic_top.interface_user", "bus"),
                             {("net:semantic_top.bus", "unknown")})
            low_drivers = list(db.execute(
                "SELECT e.node_id FROM schematic_endpoints e JOIN schematic_nodes n "
                "ON n.scope_path=e.scope_path AND n.id=e.node_id "
                "WHERE e.scope_path='semantic_top' AND e.net_id='net:semantic_top.low' "
                "AND e.role='driver' AND n.detail LIKE 'Concatenation:%'"))
            self.assertEqual(len(low_drivers), 1)
            expression_inputs = {row[0] for row in db.execute(
                "SELECT DISTINCT e.net_id FROM schematic_endpoints e JOIN schematic_nodes n "
                "ON n.scope_path=e.scope_path AND n.id=e.node_id "
                "WHERE e.scope_path='semantic_top' AND e.role='sink' "
                "AND (n.detail LIKE 'BinaryOp:%' OR n.detail LIKE 'UnaryOp:%' OR n.detail LIKE 'ConditionalOp:%')")}
            self.assertTrue({"net:semantic_top.alpha", "net:semantic_top.beta", "net:semantic_top.select"} <= expression_inputs)
            self.assertTrue(any("Unsupported interface" in detail for detail in details))
            self.assertTrue(any("Procedural behavior" in detail for detail in details))
            self.assertTrue(any("PrimitiveInstance" in detail for detail in details))
            self.assertTrue(any("Unconnected port" in detail for detail in details))
            assignments = [row[0] for row in db.execute(
                "SELECT id FROM schematic_nodes WHERE scope_path='semantic_top.first.lanes[0].first' AND label='assign'")]
            self.assertEqual(len(assignments), 1)
            scope = "semantic_top.first.lanes[0].first"
            self.assertEqual(self.endpoints(db, scope, assignments[0], "rhs"), {(f"net:{scope}.data_i", "sink")})
            self.assertEqual(self.endpoints(db, scope, assignments[0], "lhs"), {(f"net:{scope}.data_o", "driver")})


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("binary", type=Path)
    args = parser.parse_args()
    SemanticTests.binary = args.binary.resolve(strict=True)
    unittest.main(argv=[__file__], verbosity=2)
