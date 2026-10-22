import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {spawnSync} from "node:child_process";
import {fileURLToPath} from "node:url";
import {
  OPERATIONS, VERIFIER_LABEL, WorkflowError, VirtualWorkspace, browserConfig,
  validateRecipe, validatePlan, transform, runVerifier, runWorkflow
} from "../static/browser-engine.js";

// The deployed browser and Python agent read this exact same fixture file.
const scenarios = JSON.parse(readFileSync(new URL("../static/scenarios.json", import.meta.url), "utf8"));
const invalidRecipes = [
  null, [], "print('not code')", {}, {operations: [], extra: true},
  {operations: null}, {operations: "trim"}, {operations: {}}, {operations: [null]},
  {operations: [true]}, {operations: [1]}, {operations: [{}]}, {operations: [["trim"]]},
  {operations: ["exec"]}, {operations: ["TRIM"]}, {operations: ["trim", "trim"]},
  {operations: ["sort", "trim", "unique", "lowercase", "drop_empty", "sort"]}
];
const validRecipes = [{operations: []}, {operations: [...OPERATIONS]}, {operations: ["sort", "trim"]}];

test("validation rejects unknown operations, duplicates and malformed shapes", () => {
  for (const value of invalidRecipes) assert.throws(() => validateRecipe(value), WorkflowError);
  assert.throws(() => validateRecipe({operations: Array(1)}), WorkflowError);
  for (const value of validRecipes) assert.deepEqual(validateRecipe(value), value);
});

test("validation returns a snapshot instead of a mutable source reference", () => {
  const input = {operations: ["trim"]};
  const result = validateRecipe(input);
  input.operations.push("sort");
  assert.deepEqual(result, {operations: ["trim"]});
});

test("plan validation has Python's exact keys, step count and text bounds", () => {
  for (const value of [null, [], {}, {plan: []}, {plan: "read"}, {plan: [1]},
    {plan: [""]}, {plan: [" \u001c"]}, {plan: ["x".repeat(401)]},
    {plan: Array(7).fill("read")}, {plan: ["read"], extra: "no"}]) {
    assert.throws(() => validatePlan(value), WorkflowError);
  }
  assert.deepEqual(validatePlan({plan: ["read", "😀".repeat(400)]}), ["read", "😀".repeat(400)]);
});

test("virtual read/write allowlists protect fixtures and reject paths and edit shapes", () => {
  const workspace = new VirtualWorkspace(scenarios["normalize-tags"].cases);
  const fixtures = workspace.read("fixtures.json");
  for (const path of ["fixtures.json", "verify.py", "../task.json", "C:\\task.json", "/task.json", "task.json:ads"]) {
    assert.throws(() => workspace.writeRecipe({path, content: {operations: []}}), WorkflowError);
  }
  for (const value of [null, {}, {path: "task.json", content: {operations: []}, extra: true}]) {
    assert.throws(() => workspace.writeRecipe(value), WorkflowError);
  }
  assert.throws(() => workspace.read(".owner"), WorkflowError);
  const original = workspace.read("task.json");
  assert.throws(() => workspace.writeRecipe({path: "task.json", content: {operations: ["eval"]}}));
  assert.equal(workspace.read("task.json"), original);
  assert.equal(workspace.read("fixtures.json"), fixtures);
  workspace.cleanup();
  assert.throws(() => workspace.read("task.json"), /cleaned up/);
  assert.throws(() => workspace.writeRecipe({path: "task.json", content: {operations: []}}), /cleaned up/);
});

test("interpreter respects operation ordering, stable uniqueness and immutable inputs", () => {
  const values = [" Z ", "a", "Z", "  "];
  assert.deepEqual(transform(values, ["trim", "drop_empty", "unique"]), ["Z", "a"]);
  assert.deepEqual(transform(values, ["unique", "trim", "drop_empty"]), ["Z", "a", "Z"]);
  assert.deepEqual(values, [" Z ", "a", "Z", "  "]);
  assert.throws(() => transform(values, ["eval"]), WorkflowError);
});

for (const [id, scenario] of Object.entries(scenarios)) {
  test(`${id}: deterministic workflow actually passes every shared fixture`, () => {
    const result = runWorkflow({scenario: id}, scenarios);
    assert.equal(result.status, "passed");
    assert.deepEqual(result.recipe.operations, scenario.operations);
    assert.equal(result.tests.passed, true);
    assert.equal(result.tests.checks.length, scenario.cases.length);
    assert.ok(result.tests.checks.every((check) => check.passed));
    assert.deepEqual(result.tests.checks.map((check) => check.actual), scenario.cases.map((item) => item.expected));
  });
}

test("a schema-valid but wrong recipe fails real JS fixture comparisons", () => {
  const workspace = new VirtualWorkspace(scenarios["normalize-tags"].cases);
  workspace.writeRecipe({path: "task.json", content: {operations: []}});
  const result = runVerifier(workspace);
  assert.equal(result.passed, false);
  assert.equal(result.returncode, 1);
  assert.match(result.output, /FAIL expected/);
  assert.equal(result.checks[0].passed, false);
  assert.equal(result.checks[2].passed, true);
  workspace.cleanup();
  // A wrong deterministic proposal also yields a failed workflow, not canned success.
  const wrong = structuredClone(scenarios);
  wrong["normalize-tags"].operations = [];
  assert.equal(runWorkflow({}, wrong).status, "failed");
});

test("trace has UI event/data shape and honest browser-only verifier evidence", () => {
  const result = runWorkflow({}, scenarios);
  assert.equal(result.engine, "browser");
  assert.equal(result.mode, "offline");
  assert.equal(result.plan.length, 4);
  assert.deepEqual(result.trace.map((event) => event.tool), [
    "workspace.create", "planner", "read_file", "validate_and_write", "browser_verifier", "workspace.cleanup"
  ]);
  for (const event of result.trace) {
    assert.deepEqual(Object.keys(event), ["tool", "explanation", "data"]);
    assert.equal(typeof event.explanation, "string");
    assert.equal(typeof event.data, "object");
  }
  const [, , read, edit, verifier] = result.trace;
  assert.deepEqual(read.data["task.json"], {operations: []});
  assert.deepEqual(edit.data.before, {operations: []});
  assert.deepEqual(edit.data.after, result.recipe);
  assert.equal(verifier.data.command, VERIFIER_LABEL);
  assert.match(verifier.data.output, /No Python or subprocess was executed/);
  assert.equal(verifier.data.returncode, 0);
  assert.deepEqual(result.trace.at(-1).data, {});
  assert.notEqual(result.trace[0].data.id, runWorkflow({}, scenarios).trace[0].data.id);
  result.recipe.operations.length = 0;
  assert.equal(edit.data.after.operations.length, 5);
});

test("browser config disables provider mode and exposes no token or credentials", () => {
  const config = browserConfig(scenarios);
  assert.equal(config.provider_configured, false);
  assert.deepEqual(config.models, []);
  assert.equal(config.scenarios.length, 2);
  assert.equal(config.token, undefined);
  assert.throws(() => runWorkflow({mode: "provider"}, scenarios), /expose API keys.*CORS/);
});

test("unsupported requests never silently choose a scenario or provider fallback", () => {
  for (const request of [null, [], {scenario: []}, {scenario: "toString"}, {scenario: "../host"},
    {mode: "invented"}, {mode: null}, {path: "task.json"}, {planner_model: "model"}, {editor_model: "model"}]) {
    assert.throws(() => runWorkflow(request, scenarios), WorkflowError);
  }
});

test("JS validation and all 326 legal operation orders match Python over shared fixtures", () => {
  function permutations(prefix = []) {
    return [prefix, ...OPERATIONS.filter((op) => !prefix.includes(op))
      .flatMap((op) => permutations([...prefix, op]))];
  }
  const recipes = permutations();
  assert.equal(recipes.length, 326);
  const values = Object.values(scenarios).flatMap((scenario) => scenario.cases.map((item) => item.input));
  // Catch whitespace and code-point ordering differences outside the ASCII examples.
  values.push(["\u001c A \u0085", "\ufeffB\ufeff", "😀", "\ue000", "İ", "ΟΣ"]);
  const candidates = [...invalidRecipes, ...validRecipes];
  const python = spawnSync("python", ["-X", "utf8", "-c", `
import json, sys
from agent import SCENARIOS, WorkflowError, validate_recipe
from trusted_runner import transform
payload = json.load(sys.stdin)
valid = []
for candidate in payload["candidates"]:
    try:
        validate_recipe(candidate)
        valid.append(True)
    except WorkflowError:
        valid.append(False)
print(json.dumps({"scenarios": SCENARIOS, "valid": valid, "outputs": [
    [transform(values, recipe) for values in payload["values"]]
    for recipe in payload["recipes"]
]}))
`], {cwd: fileURLToPath(new URL("..", import.meta.url)), encoding: "utf8",
    input: JSON.stringify({candidates, recipes, values}), maxBuffer: 4 * 1024 * 1024});
  assert.equal(python.status, 0, `Python parity process failed: ${python.error || python.stderr}`);
  const expected = JSON.parse(python.stdout);
  assert.deepEqual(expected.scenarios, scenarios);
  assert.deepEqual(candidates.map((candidate) => {
    try { validateRecipe(candidate); return true; } catch { return false; }
  }), expected.valid);
  assert.deepEqual(recipes.map((recipe) => values.map((input) => transform(input, recipe))), expected.outputs);
});
