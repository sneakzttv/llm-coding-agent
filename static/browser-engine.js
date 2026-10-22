// The browser interprets a finite data language; it never evaluates generated code.
// This module has no DOM dependencies so node:test can exercise the real engine.
export const OPERATIONS = Object.freeze(["trim", "lowercase", "drop_empty", "unique", "sort"]);
export const VERIFIER_LABEL = "browser verifier: JS re-implementation of the trusted runner's fixture checks";

export class WorkflowError extends Error {}
const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const exactKeys = (value, keys) => object(value) && Object.keys(value).length === keys.length
  && keys.every((key) => Object.hasOwn(value, key));
const clone = (value) => JSON.parse(JSON.stringify(value));

export function validateRecipe(value) {
  if (!exactKeys(value, ["operations"])) {
    throw new WorkflowError("Recipe must contain exactly 'operations'.");
  }
  const operations = value.operations;
  if (!Array.isArray(operations) || operations.length > OPERATIONS.length) {
    throw new WorkflowError("operations must be a list of at most five items.");
  }
  // Array.from also exposes sparse slots as undefined instead of skipping them.
  if (Array.from(operations).some((item) => typeof item !== "string" || !OPERATIONS.includes(item))) {
    throw new WorkflowError("Unsupported operation; arbitrary code is never accepted.");
  }
  if (new Set(operations).size !== operations.length) {
    throw new WorkflowError("Duplicate operations are not allowed.");
  }
  return {operations: [...operations]};
}

export function validatePlan(value) {
  if (!exactKeys(value, ["plan"])) throw new WorkflowError("Planner must return exactly a 'plan' object.");
  const plan = value.plan;
  if (!Array.isArray(plan) || plan.length < 1 || plan.length > 6) {
    throw new WorkflowError("Plan must contain one to six steps.");
  }
  if (Array.from(plan).some((step) => typeof step !== "string" || !strip(step) || [...step].length > 400)) {
    throw new WorkflowError("Each plan step must be nonempty text, up to 400 characters.");
  }
  return [...plan];
}

// Python str.strip includes U+001C–001F but not the BOM; JS trim differs.
const strip = (value) => value.replace(/^[\u0009-\u000d\u001c-\u0020\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+|[\u0009-\u000d\u001c-\u0020\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+$/gu, "");
// Python sorts Unicode code points, not JavaScript's default UTF-16 code units.
function compareStrings(a, b) {
  const left = Array.from(a, (char) => char.codePointAt(0));
  const right = Array.from(b, (char) => char.codePointAt(0));
  for (let i = 0; i < Math.min(left.length, right.length); i++) {
    if (left[i] !== right[i]) return left[i] - right[i];
  }
  return left.length - right.length;
}

export function transform(values, operations) {
  const recipe = validateRecipe({operations});
  let output = [...values];
  for (const operation of recipe.operations) {
    switch (operation) {
      case "trim": output = output.map(strip); break;
      case "lowercase": output = output.map((value) => value.toLowerCase()); break;
      case "drop_empty": output = output.filter((value) => value !== ""); break;
      case "unique": output = [...new Set(output)]; break;
      case "sort": output.sort(compareStrings); break;
    }
  }
  return output;
}

export class VirtualWorkspace {
  #files = new Map();
  constructor(cases) {
    // JSON strings give read/write snapshot semantics instead of shared references.
    this.#files.set("task.json", '{"operations":[]}\n');
    this.#files.set("fixtures.json", JSON.stringify(cases));
  }
  read(name) {
    if (!["task.json", "fixtures.json"].includes(name)) {
      throw new WorkflowError("Path is outside the explicit tool allowlist.");
    }
    if (!this.#files.has(name)) throw new WorkflowError("Virtual workspace has been cleaned up.");
    return this.#files.get(name);
  }
  writeRecipe(edit) {
    if (!exactKeys(edit, ["path", "content"])) {
      throw new WorkflowError("Editor must return exactly 'path' and 'content'.");
    }
    if (edit.path !== "task.json") throw new WorkflowError("Only task.json is writable.");
    this.read("task.json");
    const recipe = validateRecipe(edit.content);
    this.#files.set("task.json", `${JSON.stringify(recipe, null, 2)}\n`);
    return recipe;
  }
  cleanup() { this.#files.clear(); }
}

export function runVerifier(workspace) {
  const recipe = validateRecipe(JSON.parse(workspace.read("task.json")));
  const fixtures = JSON.parse(workspace.read("fixtures.json"));
  const checks = fixtures.map((fixture, index) => {
    const actual = transform(fixture.input, recipe.operations);
    return {fixture: index, passed: JSON.stringify(actual) === JSON.stringify(fixture.expected),
      actual, expected: fixture.expected};
  });
  const passed = checks.every((check) => check.passed);
  return {passed, returncode: passed ? 0 : 1, command: VERIFIER_LABEL, checks,
    output: `${VERIFIER_LABEL}\n${checks.map((check) =>
      `fixture ${check.fixture}: ${check.passed ? "PASS" : `FAIL expected ${JSON.stringify(check.expected)}, got ${JSON.stringify(check.actual)}`}`
    ).join("\n")}\n${checks.filter((check) => check.passed).length}/${checks.length} fixture checks passed.\nNo Python or subprocess was executed.`};
}

export function browserConfig(scenarios) {
  return {engine: "browser", models: [], provider_configured: false,
    scenarios: Object.entries(scenarios).map(([id, {title, task}]) => ({id, title, task}))};
}

export function runWorkflow(request, scenarios) {
  if (!object(request) || Object.keys(request).some((key) =>
    !["scenario", "mode", "planner_model", "editor_model"].includes(key))) {
    throw new WorkflowError("Unsupported request fields.");
  }
  const scenarioId = request.scenario === undefined ? "normalize-tags" : request.scenario;
  if (typeof scenarioId !== "string" || !Object.hasOwn(scenarios, scenarioId)) {
    throw new WorkflowError("Unsupported scenario.");
  }
  const mode = request.mode === undefined ? "offline" : request.mode;
  if (mode !== "offline") {
    throw new WorkflowError("Provider mode is local-server only: browsers expose API keys and most providers block CORS.");
  }
  if (request.planner_model || request.editor_model) {
    throw new WorkflowError("Offline mode does not accept provider model IDs.");
  }
  const scenario = scenarios[scenarioId];
  const workspace = new VirtualWorkspace(scenario.cases);
  const trace = [];
  // Every event is a snapshot: cleanup and later edits cannot rewrite evidence.
  const record = (tool, explanation, data) => trace.push({tool, explanation, data: clone(data)});
  try {
    record("workspace.create", "New disposable virtual workspace in browser memory; no host files.", {
      id: `browser-${globalThis.crypto.randomUUID()}`, writable: ["task.json"],
      readable: ["task.json", "fixtures.json"]
    });
    const plan = validatePlan({plan: [
      "Read the starter recipe and immutable example fixtures.", scenario.task,
      "Validate and write only the declarative recipe.",
      "Run the browser verifier (JS fixture checks, not Python unittest) and report the actual result."
    ]});
    record("planner", "A plan is descriptive, not executable.", {model: "deterministic-offline", steps: plan});
    const source = JSON.parse(workspace.read("task.json"));
    const fixtures = JSON.parse(workspace.read("fixtures.json"));
    record("read_file", "Only allowlisted virtual sample files are read.", {
      "task.json": source, "fixtures.json": fixtures
    });
    const recipe = workspace.writeRecipe({path: "task.json", content: {operations: scenario.operations}});
    record("validate_and_write", "Schema and path checks passed before the virtual edit.", {
      before: source, after: recipe, model: "deterministic-offline"
    });
    const tests = runVerifier(workspace);
    record("browser_verifier", VERIFIER_LABEL, tests);
    workspace.cleanup();
    record("workspace.cleanup", "Virtual sample files discarded; no disk or repository was edited.", {});
    return {scenario: scenarioId, mode, engine: "browser", plan, recipe, tests, trace,
      status: tests.passed ? "passed" : "failed"};
  } finally {
    // Also discard memory when validation or execution throws; no persistent state.
    workspace.cleanup();
  }
}
