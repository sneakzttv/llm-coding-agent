"""Trusted, fixed unittest runner copied into each owned sample workspace.

Only declarative JSON is consumed. No eval, exec, imports from model output, or
model-generated Python is involved. This file is NOT an editable agent tool.
"""

import json
from pathlib import Path
import unittest


def transform(values, operations):
    """Interpret a tiny finite recipe language over bounded string fixtures."""
    values = list(values)
    for operation in operations:
        if operation == "trim":
            values = [value.strip() for value in values]
        elif operation == "lowercase":
            values = [value.lower() for value in values]
        elif operation == "drop_empty":
            values = [value for value in values if value]
        elif operation == "unique":
            values = list(dict.fromkeys(values))
        elif operation == "sort":
            values = sorted(values)
        else:
            raise ValueError("Unsupported recipe operation.")
    return values


class FixtureTests(unittest.TestCase):
    """Each immutable case is a separate visible unittest subtest."""

    def test_sample_contract(self):
        root = Path(__file__).absolute().parent
        recipe = json.loads((root / "task.json").read_text(encoding="utf-8"))
        cases = json.loads((root / "fixtures.json").read_text(encoding="utf-8"))
        for index, case in enumerate(cases):
            with self.subTest(fixture=index):
                self.assertEqual(transform(case["input"], recipe["operations"]), case["expected"])


if __name__ == "__main__":
    # The command-line arguments are fixed by the host, not proposed by a model.
    unittest.main(verbosity=2)
