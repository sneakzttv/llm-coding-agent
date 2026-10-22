"""Regression tests for finite edits, actual tests, and ownership/path checks."""

import json
from pathlib import Path
import stat
import subprocess
import unittest
from unittest.mock import Mock, patch

from agent import (
    ROOT, SCENARIOS, WorkflowError, Workspace, reject_links,
    run_verifier, run_workflow, validate_plan, validate_recipe,
)
from provider import Provider, ProviderError
from trusted_runner import transform


class WorkflowTests(unittest.TestCase):
    # Disposable files stay explicitly inside the project, never system temp.
    base = ROOT / ".test-workspaces"

    def test_offline_both_scenarios_run_real_subprocess_tests_and_cleanup(self):
        for scenario in SCENARIOS:
            with self.subTest(scenario=scenario):
                result = run_workflow({"scenario": scenario}, Provider(), self.base)
                self.assertEqual(result["status"], "passed")
                self.assertEqual(result["tests"]["returncode"], 0)
                self.assertIn("Ran 1 test", result["tests"]["output"])
                self.assertEqual(result["trace"][-1]["tool"], "workspace.cleanup")
                token = result["trace"][0]["data"]["id"]
                self.assertFalse((self.base / token).exists())

    def test_safe_but_incorrect_real_provider_recipe_fails_actual_tests(self):
        provider = Provider("http://127.0.0.1:9000/v1", ["test"])
        # Mock only the remote calls; the real verifier subprocess still runs.
        with patch.object(provider, "complete", side_effect=[
            {"plan": ["Read examples", "Propose a recipe"]},
            {"path": "task.json", "content": {"operations": []}},
        ]) as complete:
            result = run_workflow({
                "mode": "provider", "planner_model": "test", "editor_model": "test",
            }, provider, self.base)
        self.assertEqual(complete.call_count, 2)
        self.assertEqual(result["status"], "failed")
        self.assertNotEqual(result["tests"]["returncode"], 0)
        self.assertIn("FAILED", result["tests"]["output"])

    def test_invalid_edit_is_rejected_not_executed(self):
        provider = Provider("http://127.0.0.1:9000/v1", ["test"])
        with patch.object(provider, "complete", side_effect=[
            {"plan": ["Do something"]},
            {"path": "verify.py", "content": "import os"},
        ]), patch("agent.run_verifier") as verifier:
            with self.assertRaises(WorkflowError):
                run_workflow({"mode": "provider", "planner_model": "test",
                              "editor_model": "test"}, provider, self.base)
            verifier.assert_not_called()

    def test_provider_failure_never_falls_back(self):
        provider = Provider("http://127.0.0.1:9000/v1", ["test"])
        with patch.object(provider, "complete", side_effect=ProviderError("Explicit failure")):
            with self.assertRaisesRegex(WorkflowError, "Explicit failure"):
                run_workflow({"mode": "provider", "planner_model": "test",
                              "editor_model": "test"}, provider, self.base)

    def test_unsupported_requests(self):
        for request in [
            [], {"scenario": "../host"}, {"scenario": []}, {"mode": "magic"},
            {"path": "C:\\Windows"}, {"planner_model": "model"},
            {"mode": "provider", "planner_model": "missing", "editor_model": "missing"},
        ]:
            with self.subTest(request=request), self.assertRaises((WorkflowError, ProviderError)):
                run_workflow(request, Provider(), self.base)

    def test_recipe_rejects_source_and_bad_schema(self):
        for value in [
            None, "print('not code')", {"operations": ["exec"]},
            {"operations": ["trim", "trim"]}, {"operations": "trim"},
            {"operations": [1]}, {"operations": ["trim"], "python": "pass"},
            {"operations": ["sort"] * 6},
        ]:
            with self.subTest(value=value), self.assertRaises(WorkflowError):
                validate_recipe(value)

    def test_plan_validation(self):
        for value in [[], {"plan": []}, {"plan": [""]}, {"plan": [3]},
                      {"plan": ["a" * 401]}, {"plan": ["ok"], "extra": True}]:
            with self.subTest(value=value), self.assertRaises(WorkflowError):
                validate_plan(value)
        self.assertEqual(validate_plan({"plan": ["Read"]}), ["Read"])

    def test_paths_reject_traversal_absolute_windows_ads_and_encoded_input(self):
        with Workspace(self.base) as workspace:
            for path in [
                "../task.json", "..\\task.json", "/etc/passwd", "C:\\Windows\\win.ini",
                "\\\\server\\share", "task.json:stream", "%2e%2e%2ftask.json",
                "sub/task.json", ".", "", 5,
            ]:
                with self.subTest(path=path), self.assertRaises(WorkflowError):
                    workspace.file(path)
            with self.assertRaises(WorkflowError):
                workspace.write_recipe({"path": "../task.json", "content": {"operations": []}})
            workspace.write_recipe({"path": "task.json", "content": {"operations": ["trim"]}})
            self.assertEqual(json.loads(workspace.read("task.json")), {"operations": ["trim"]})

    def test_symlink_is_refused_when_platform_allows_creation(self):
        with Workspace(self.base) as workspace:
            target = workspace.file("fixtures.json")
            target.write_text("[]", encoding="utf-8")
            link = workspace.path / "task.json"
            try:
                link.symlink_to(target)
            except (OSError, NotImplementedError):
                self.skipTest("This Windows account cannot create symlinks.")
            try:
                with self.assertRaises(WorkflowError):
                    workspace.file("task.json")
            finally:
                # Remove only the link itself so ownership-checked cleanup can finish.
                link.unlink()

    def test_windows_reparse_attribute_is_rejected(self):
        fake_path = Mock(spec=Path)
        fake_path.lstat.return_value = Mock(st_mode=stat.S_IFDIR, st_file_attributes=0x400)
        with self.assertRaises(WorkflowError):
            reject_links(fake_path)

    def test_timeout_and_no_shell_contract(self):
        with Workspace(self.base) as workspace, patch(
            "agent.subprocess.run", side_effect=subprocess.TimeoutExpired("verify", 10)
        ) as run:
            with self.assertRaisesRegex(WorkflowError, "timeout|10-second"):
                run_verifier(workspace)
            self.assertFalse(run.call_args.kwargs["shell"])
            self.assertIn("-I", run.call_args.args[0])
            self.assertEqual(run.call_args.kwargs["timeout"], 10)
            self.assertNotIn("AGENT_API_KEY", run.call_args.kwargs["env"])

    def test_trusted_interpreter_preserves_order_and_rejects_unknown(self):
        self.assertEqual(transform([" b ", "a", "b"], ["trim", "unique"]), ["b", "a"])
        with self.assertRaises(ValueError):
            transform([], ["import"])


if __name__ == "__main__":
    unittest.main()
