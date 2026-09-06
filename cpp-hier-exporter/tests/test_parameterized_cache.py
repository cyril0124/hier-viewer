#!/usr/bin/env python3
"""Run against a real slang-hier-exporter: test_parameterized_cache.py BINARY."""

import argparse
from pathlib import Path
import sqlite3
import subprocess
import tempfile
import unittest


FIXTURE = Path(__file__).with_name("parameterized_cache.sv").resolve()
METRICS = (
    "module_port_count", "module_logic_count", "module_reg_count",
    "module_wire_count", "module_variable_count", "module_net_count",
    "module_signal_count", "module_variable_bits", "module_net_bits",
    "module_signal_bits", "module_internal_signal_count", "module_gen_signal_count",
)


def export(binary, directory, reverse):
    database = directory / ("reverse.db" if reverse else "forward.db")
    command = [str(binary), "--sqlite", "-o", str(database), "--top", "top"]
    if reverse:
        command.append("+define+REVERSE_ORDER")
    command.append(str(FIXTURE))
    subprocess.run(command, check=True, timeout=60)
    with sqlite3.connect(f"{database.as_uri()}?mode=ro", uri=True) as connection:
        connection.row_factory = sqlite3.Row
        instances = {
            row["path"]: dict(row)
            for row in connection.execute("SELECT * FROM instances ORDER BY path")
        }
        definitions = {
            row["definition_key"]: dict(row)
            for row in connection.execute("SELECT * FROM definitions")
        }
        signals = {}
        for row in connection.execute(
            "SELECT * FROM definition_signal_stats ORDER BY signal_name, signal_kind"
        ):
            signals.setdefault(row["definition_key"], []).append(
                tuple(row[column] for column in
                      ("signal_name", "signal_kind", "signal_count", "total_bits"))
            )
    return instances, definitions, signals


class ParameterizedCacheTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        with tempfile.TemporaryDirectory(prefix="hier-cache-test-") as directory:
            cls.exports = [
                export(cls.binary, Path(directory), reverse)
                for reverse in (False, True)
            ]

    def test_parameterized_metrics_and_signals(self):
        for order, (instances, definitions, signals) in enumerate(self.exports):
            self.assertEqual(len(instances), 7)
            for prefix, width in (("narrow", 8), ("wide", 32)):
                generated = width // 8
                expected = (0, 1 + generated, 1, 1, 2 + generated, 1,
                            3 + generated, 2 * width + 2 * generated, width,
                            3 * width + 2 * generated, 3 + generated, generated)
                expected_signals = [
                    ("_GENflag", "variable", generated, 2 * generated),
                    ("link", "net", 1, width),
                    ("payload", "variable", 1, width),
                    ("state", "variable", 1, width),
                ]
                for suffix in "abc":
                    path = f"top.{prefix}_{suffix}"
                    with self.subTest(order=order, path=path):
                        instance = instances[path]
                        definition = definitions[instance["definition_key"]]
                        self.assertEqual(tuple(instance[key] for key in METRICS), expected)
                        self.assertEqual(tuple(definition[key] for key in METRICS), expected)
                        self.assertEqual(signals[instance["definition_key"]], expected_signals)
                        self.assertEqual(instance["module"], "parameterized_cell")
                        self.assertEqual(definition["module"], "parameterized_cell")
                        self.assertEqual(instance["file_path"], str(FIXTURE))
                        self.assertGreater(instance["line"], 0)
                        self.assertGreater(instance["column"], 0)
                        self.assertGreaterEqual(instance["end_line"], instance["line"])
                        self.assertGreater(instance["end_column"], 0)
                        for row in (instance, definition):
                            self.assertEqual(row["definition_file_path"], str(FIXTURE))
                            self.assertEqual(row["definition_line"], 1)
                            self.assertGreater(row["definition_column"], 0)
                            self.assertGreater(row["definition_end_line"], 1)
                            self.assertGreater(row["definition_end_column"], 0)

    def test_declaration_order_does_not_change_statistics(self):
        def snapshot(exported):
            instances, definitions, signals = exported
            return {
                path: (
                    tuple(instance[key] for key in METRICS),
                    tuple(definitions[instance["definition_key"]][key] for key in METRICS),
                    signals.get(instance["definition_key"], []),
                )
                for path, instance in instances.items()
            }

        self.assertEqual(snapshot(self.exports[0]), snapshot(self.exports[1]))

    def test_equivalent_instances_share_definition(self):
        for order, (instances, definitions, signals) in enumerate(self.exports):
            with self.subTest(order=order):
                narrow = {instances[f"top.narrow_{suffix}"]["definition_key"]
                          for suffix in "abc"}
                wide = {instances[f"top.wide_{suffix}"]["definition_key"]
                        for suffix in "abc"}
                self.assertEqual(len(narrow), 1)
                self.assertEqual(len(wide), 1)
                self.assertTrue(narrow.isdisjoint(wide), (narrow, wide))
                self.assertEqual(len(definitions), 3)
                self.assertEqual(set(definitions),
                                 {row["definition_key"] for row in instances.values()})
                self.assertEqual(set(signals), narrow | wide)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("binary", type=Path, help="Path to the exporter binary to test")
    args = parser.parse_args()
    ParameterizedCacheTests.binary = args.binary.resolve(strict=True)
    unittest.main(argv=[__file__], verbosity=2)
