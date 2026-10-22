"""Constrained task-to-code orchestration; model text is data, never Python."""

from __future__ import annotations

import json
import os
from pathlib import Path, PurePosixPath
import stat
import subprocess
import sys
import threading
import uuid

from provider import Provider, ProviderError

ROOT = Path(__file__).absolute().parent
OPERATIONS = ("trim", "lowercase", "drop_empty", "unique", "sort")
# Both engines consume the same checked-in tasks and immutable fixture examples.
SCENARIOS = json.loads((ROOT / "static" / "scenarios.json").read_text(encoding="utf-8"))
# One bounded subprocess per server at a time avoids overlapping resource usage.
RUN_LOCK = threading.Lock()


class WorkflowError(ValueError):
    """A request or proposed tool action violated this demo's contract."""


def reject_links(path: Path) -> None:
    """Reject Unix symlinks AND Windows junctions/reparse points before access."""
    info = path.lstat()
    if stat.S_ISLNK(info.st_mode) or (
        getattr(info, "st_file_attributes", 0)
        & getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0x400)
    ):
        raise WorkflowError("Symlinks and reparse points are not allowed.")


def validate_recipe(value: object) -> dict:
    """Accept only a small data language, not source code or executable names."""
    if not isinstance(value, dict) or set(value) != {"operations"}:
        raise WorkflowError("Recipe must contain exactly 'operations'.")
    operations = value["operations"]
    if not isinstance(operations, list) or len(operations) > len(OPERATIONS):
        raise WorkflowError("operations must be a list of at most five items.")
    if any(type(item) is not str or item not in OPERATIONS for item in operations):
        raise WorkflowError("Unsupported operation; arbitrary code is never accepted.")
    if len(set(operations)) != len(operations):
        raise WorkflowError("Duplicate operations are not allowed.")
    return {"operations": operations[:]}


def validate_plan(value: object) -> list[str]:
    """Explanatory model text is bounded and rendered as text in the browser."""
    if not isinstance(value, dict) or set(value) != {"plan"}:
        raise WorkflowError("Planner must return exactly a 'plan' object.")
    plan = value["plan"]
    if not isinstance(plan, list) or not 1 <= len(plan) <= 6:
        raise WorkflowError("Plan must contain one to six steps.")
    if any(type(step) is not str or not step.strip() or len(step) > 400 for step in plan):
        raise WorkflowError("Each plan step must be nonempty text, up to 400 characters.")
    return plan


class Workspace:
    """Own a new UUID directory; requests cannot supply a root or a filename."""

    ALLOWED = frozenset({"task.json", "fixtures.json", "verify.py", ".owner"})

    def __init__(self, base: Path):
        self.base = base
        self.token = uuid.uuid4().hex
        self.path = base / self.token
        self.created = False

    def __enter__(self):
        # Check the full ancestor chain, not only the final directory.
        for ancestor in reversed((self.base, *self.base.parents)):
            if ancestor.exists() or ancestor.is_symlink():
                reject_links(ancestor)
        self.base.mkdir(exist_ok=True)
        reject_links(self.base)
        self.path.mkdir(mode=0o700)
        self.created = True
        self.file(".owner").write_text(self.token, encoding="utf-8")
        return self

    def file(self, name: str) -> Path:
        # Exact allowlisting also rejects drive paths, UNC, traversal and ADS.
        if type(name) is not str or name not in self.ALLOWED:
            raise WorkflowError("Path is outside the explicit tool allowlist.")
        if PurePosixPath(name).name != name or "\\" in name or ":" in name:
            raise WorkflowError("Unsafe path.")
        reject_links(self.base)
        reject_links(self.path)
        result = self.path / name
        if result.exists() or result.is_symlink():
            reject_links(result)
            if not result.is_file():
                raise WorkflowError("Tool targets must be regular files.")
        return result

    def read(self, name: str) -> str:
        return self.file(name).read_text(encoding="utf-8")

    def write_recipe(self, edit: object) -> dict:
        # Neither fixtures nor the trusted verifier are editable by the model.
        if not isinstance(edit, dict) or set(edit) != {"path", "content"}:
            raise WorkflowError("Editor must return exactly 'path' and 'content'.")
        if edit["path"] != "task.json":
            raise WorkflowError("Only task.json is writable.")
        recipe = validate_recipe(edit["content"])
        self.file("task.json").write_text(json.dumps(recipe, indent=2) + "\n", encoding="utf-8")
        return recipe

    def __exit__(self, *_):
        # Never recursively remove a path that has lost its ownership marker.
        if self.created:
            marker = self.file(".owner")
            if marker.read_text(encoding="utf-8") != self.token:
                raise WorkflowError("Ownership marker changed; cleanup refused.")
            # Only known regular files are removed; an unexpected file stops cleanup.
            for child in self.path.iterdir():
                self.file(child.name).unlink()
            self.path.rmdir()


def run_verifier(workspace: Workspace) -> dict:
    """Execute only the checked-in verifier, never generated executable code."""
    # Isolated Python ignores PYTHONPATH, user site packages, and Python env vars.
    command = [sys.executable, "-I", str(workspace.file("verify.py"))]
    try:
        result = subprocess.run(
            command, cwd=workspace.path, stdin=subprocess.DEVNULL,
            capture_output=True, text=True, encoding="utf-8", errors="replace",
            timeout=10, shell=False,
            env={key: os.environ[key] for key in ("SYSTEMROOT", "WINDIR") if key in os.environ},
        )
    except subprocess.TimeoutExpired as exc:
        raise WorkflowError("Trusted fixture tests exceeded the 10-second timeout.") from exc
    return {
        "passed": result.returncode == 0,
        "returncode": result.returncode,
        "output": (result.stdout + result.stderr)[-16000:],
        "command": "python -I verify.py (trusted unittest runner; no shell)",
    }


def run_workflow(request: object, provider: Provider, base: Path | None = None) -> dict:
    """Orchestrate plan → read → propose → validate → write → subprocess tests."""
    if not isinstance(request, dict) or set(request) - {
        "scenario", "mode", "planner_model", "editor_model"
    }:
        raise WorkflowError("Unsupported request fields.")
    scenario_id = request.get("scenario", "normalize-tags")
    mode = request.get("mode", "offline")
    if type(scenario_id) is not str or scenario_id not in SCENARIOS:
        raise WorkflowError("Unsupported scenario.")
    if mode not in ("offline", "provider"):
        raise WorkflowError("Mode must be offline or provider.")
    scenario = SCENARIOS[scenario_id]
    planner = request.get("planner_model", "")
    editor = request.get("editor_model", "")
    if mode == "provider":
        provider.validate_model(planner)
        provider.validate_model(editor)
    elif planner or editor:
        raise WorkflowError("Offline mode does not accept provider model IDs.")
    if not RUN_LOCK.acquire(blocking=False):
        raise WorkflowError("Another run is in progress; try again shortly.")
    trace = []

    def record(tool, explanation, data):
        trace.append({"tool": tool, "explanation": explanation, "data": data})

    try:
        with Workspace(base if base is not None else ROOT / ".workspaces") as workspace:
            workspace.file("task.json").write_text('{"operations": []}\n', encoding="utf-8")
            workspace.file("fixtures.json").write_text(
                json.dumps(scenario["cases"]), encoding="utf-8"
            )
            workspace.file("verify.py").write_text(
                (ROOT / "trusted_runner.py").read_text(encoding="utf-8"), encoding="utf-8"
            )
            record("workspace.create", "New explicitly owned disposable workspace.", {
                "id": workspace.token, "writable": ["task.json"],
                "readable": ["task.json", "fixtures.json"],
            })
            if mode == "offline":
                plan = validate_plan({"plan": [
                    "Read the starter recipe and immutable example fixtures.",
                    scenario["task"],
                    "Validate and write only the declarative recipe.",
                    "Run the trusted unittest verifier and report the actual result.",
                ]})
            else:
                plan = validate_plan(provider.complete(planner, "planner", {
                    "task": scenario["task"],
                    "contract": 'Return JSON only: {"plan":["step", "..."]}; 1–6 short steps.',
                }))
            record("planner", "A plan is descriptive, not executable.", {
                "model": planner if mode == "provider" else "deterministic-offline",
                "steps": plan,
            })
            source = workspace.read("task.json")
            fixtures = workspace.read("fixtures.json")
            record("read_file", "Only allowlisted sample files are read.", {
                "task.json": json.loads(source), "fixtures.json": json.loads(fixtures),
            })
            if mode == "offline":
                edit = {"path": "task.json", "content": {"operations": scenario["operations"]}}
            else:
                edit = provider.complete(editor, "editor", {
                    "task": scenario["task"], "plan": plan,
                    "current_recipe": json.loads(source), "fixtures": json.loads(fixtures),
                    "operations": list(OPERATIONS),
                    "semantics": "Apply operations in order. unique preserves first occurrence.",
                    "contract": 'JSON only: {"path":"task.json","content":{"operations":[...]}}. '
                                "Only the listed operation names are permitted, each at most once.",
                })
            # Preserve before/after evidence without permitting model-controlled paths.
            recipe = workspace.write_recipe(edit)
            record("validate_and_write", "Schema and path checks passed before the edit.", {
                "before": json.loads(source), "after": recipe,
                "model": editor if mode == "provider" else "deterministic-offline",
            })
            tests = run_verifier(workspace)
            record("unittest", "Actual subprocess result, not a model's claim.", tests)
            result = {
                "scenario": scenario_id, "mode": mode, "plan": plan,
                "recipe": recipe, "tests": tests, "trace": trace,
                "status": "passed" if tests["passed"] else "failed",
            }
        # This event is emitted only after successful ownership-checked cleanup.
        record("workspace.cleanup", "Owned sample files removed; no repository was edited.", {})
        return result
    except (OSError, ProviderError) as exc:
        raise WorkflowError(str(exc)) from exc
    finally:
        RUN_LOCK.release()
