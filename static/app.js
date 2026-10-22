import {browserConfig, runWorkflow} from "./browser-engine.js";

// These checkpoints teach the actual contract, rather than simulated tool execution.
const checkpoints = [
  {name: "Scope", title: "Start with an owned workspace.", tool: "workspace.create",
    copy: "The server creates a fresh UUID directory under this project's .workspaces. It owns every file and removes them after the run. Your repositories and arbitrary host paths are never tools.",
    example: "Writable: task.json\nRead-only to the agent: fixtures.json\nTrusted execution: verify.py"},
  {name: "Plan", title: "Separate intent from execution.", tool: "planner",
    copy: "The planner describes a short approach. Offline mode is explicitly scripted. Provider mode calls your configured planner model, then validates its JSON. A plan is text, not code.",
    example: '{"plan":["Read fixtures","Choose safe operations","Validate and test"]}'},
  {name: "Read", title: "Give tools the smallest useful surface.", tool: "read_file",
    copy: "The workflow reads only the starter recipe and fixed examples. The sample fixtures are visible to the editor, so they are acceptance examples, not an independent hidden benchmark.",
    example: '{"operations":[]}\n\nThe editor receives only sample task data, not host files or credentials.'},
  {name: "Edit", title: "Validate before writing.", tool: "validate_and_write",
    copy: "The editor proposes a JSON recipe. Exact keys, the literal task.json path, supported operations, and duplicates are checked before writing. Safe but incorrect recipes are allowed through validation so tests can catch semantic mistakes.",
    example: '{"path":"task.json","content":{"operations":["trim","lowercase","drop_empty","unique","sort"]}}'},
  {name: "Test", title: "Ask the runtime, not the model.", tool: "unittest",
    copy: "A subprocess runs the fixed unittest verifier with isolated Python, no shell, and a 10-second timeout. It interprets data using trusted operations. The UI shows its actual exit code and output, including failures.",
    example: "python -I verify.py\n\nNo eval. No exec. No model-generated imports or source code."},
  {name: "Review", title: "Close the loop honestly.", tool: "workspace.cleanup",
    copy: "The server removes only its owned allowlisted files. Inspect the complete tool ledger below. A failed test is a failed run; provider and schema errors are explicit, with no fallback or fabricated success.",
    example: "Passing fixtures does not imply arbitrary coding ability.\nPlanning + tools + validated edits + tests, within a deliberately finite domain."}
];

const byId = (id) => document.getElementById(id);
let config = null;
let scenarios = null;
let result = null;
let checkpoint = 0;
let running = false;

// textContent is intentional: every provider response remains inert text.
function showCheckpoint() {
  const item = checkpoints[checkpoint];
  byId("counter").textContent = `${checkpoint + 1} / ${checkpoints.length}`;
  byId("checkpoint-title").textContent = item.title;
  byId("checkpoint-copy").textContent = item.copy;
  const event = result?.trace.find((entry) => entry.tool === item.tool);
  byId("evidence-label").textContent = event ? "ACTUAL RUN EVIDENCE" : "WHAT TO LOOK FOR · EXAMPLE ONLY";
  byId("evidence").textContent = event ? JSON.stringify(event.data, null, 2) : item.example;
  byId("back").disabled = checkpoint === 0;
  byId("next").disabled = checkpoint === checkpoints.length - 1;
  [...byId("steps").children].forEach((button, index) => {
    button.setAttribute("aria-current", index === checkpoint ? "step" : "false");
  });
}

// Each checkpoint button, as well as Back/Next, performs only navigation.
checkpoints.forEach((item, index) => {
  const button = document.createElement("button");
  button.textContent = `${index + 1}. ${item.name}`;
  button.addEventListener("click", () => { checkpoint = index; showCheckpoint(); });
  byId("steps").append(button);
});
byId("back").addEventListener("click", () => { checkpoint--; showCheckpoint(); });
byId("next").addEventListener("click", () => { checkpoint++; showCheckpoint(); });
byId("reset").addEventListener("click", () => {
  if (running) return;
  checkpoint = 0;
  result = null;
  byId("trace").replaceChildren();
  const empty = document.createElement("p");
  empty.textContent = "Tutorial reset. Run an experiment to capture a new tool trace.";
  byId("trace").append(empty);
  byId("result-badge").textContent = "NOT RUN";
  byId("status").textContent = "Tutorial reset; no workspace files were changed.";
  showCheckpoint();
});

function updateControls() {
  const real = byId("mode").value === "provider";
  byId("models").hidden = !real;
  const ready = config && (!real || config.provider_configured);
  byId("run").disabled = running || !ready;
  for (const id of ["scenario", "mode", "planner", "editor", "reset"]) {
    byId(id).disabled = running;
  }
  if (config) {
    const scenario = config.scenarios.find((item) => item.id === byId("scenario").value);
    byId("task-description").textContent = scenario?.task || "";
  }
  if (!running && real && !config?.provider_configured) {
    byId("status").textContent = "Provider not configured. Set AGENT_API_BASE, AGENT_MODELS and optional AGENT_API_KEY on the server, then restart.";
  } else if (!running && config) {
    byId("status").textContent = real ? "Ready for two real provider calls. Task data will leave this process." : "Ready offline. Scripted decisions, not an LLM; no provider network calls.";
  }
}
byId("mode").addEventListener("change", updateControls);
byId("scenario").addEventListener("change", updateControls);

function renderTrace() {
  byId("trace").replaceChildren();
  result.trace.forEach((event, index) => {
    const details = document.createElement("details");
    const summary = document.createElement("summary");
    summary.textContent = `${String(index + 1).padStart(2, "0")} / ${event.tool}`;
    const explanation = document.createElement("p");
    explanation.textContent = event.explanation;
    const output = document.createElement("pre");
    output.tabIndex = 0;
    output.textContent = JSON.stringify(event.data, null, 2);
    details.append(summary, explanation, output);
    byId("trace").append(details);
  });
}

byId("run").addEventListener("click", async () => {
  running = true;
  result = null;
  byId("trace").replaceChildren();
  byId("result-badge").textContent = "RUNNING";
  updateControls();
  byId("status").textContent = "Running the complete workflow. Provider mode can take about a minute…";
  showCheckpoint();
  // A bounded UI wait accommodates two provider requests and subprocess tests.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 80000);
  let finalMessage;
  try {
    const request = {scenario: byId("scenario").value, mode: byId("mode").value};
    if (request.mode === "provider") {
      request.planner_model = byId("planner").value;
      request.editor_model = byId("editor").value;
    }
    let data;
    if (config.engine === "browser") {
      data = runWorkflow(request, scenarios);
    } else {
      // Once the local server is selected, errors never trigger browser fallback.
      const response = await fetch("./api/run", {
        method: "POST", headers: {"Content-Type": "application/json", "X-Demo-Token": config.token},
        body: JSON.stringify(request), signal: controller.signal
      });
      data = await response.json();
      if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
    }
    result = data;
    byId("result-badge").textContent = data.status.toUpperCase();
    finalMessage = data.tests.passed ? "Tests passed. Explore each checkpoint and tool event." : "Tests failed. Inspect the actual verifier output at checkpoint 5.";
    checkpoint = data.tests.passed ? 0 : 4;
    renderTrace();
  } catch (error) {
    byId("result-badge").textContent = "ERROR";
    finalMessage = error.name === "AbortError" ? "Request timed out; the server may still be completing cleanup. No fallback was used." : `Run rejected: ${error.message}`;
  } finally {
    clearTimeout(timer);
    running = false;
    updateControls();
    byId("status").textContent = finalMessage;
    showCheckpoint();
  }
});

// Same six checkpoints, but evidence must describe the actual execution engine.
function configureBrowserTutorial() {
  byId("runtime-label").textContent = "BROWSER ENGINE / STATIC HOSTING";
  byId("verifier-badge").textContent = "Browser verifier / JS fixture checks";
  byId("runtime-detail").textContent = "Browser engine: virtual in-memory workspace; browser verifier: JS re-implementation of the trusted runner's fixture checks. No Python, subprocess, host files, or LLM runs here.";
  const provider = byId("mode").querySelector('[value="provider"]');
  provider.disabled = true;
  provider.textContent = "Provider (local Python server only)";
  byId("mode-help").textContent = "Offline uses scripted decisions, not an LLM. Provider mode is disabled on static hosting: a browser would expose API keys and most providers block CORS. Run python server.py to enable it.";
  checkpoints[0].copy = "The browser creates an isolated in-memory sample workspace, not a directory. Only task.json is writable; fixtures are read-only to the editor. No host paths or disk tools exist.";
  checkpoints[0].example = "Virtual writable: task.json\nVirtual read-only: fixtures.json\nNo disk workspace or Python runner";
  checkpoints[1].copy = "A deterministic planner describes a short approach, then its JSON shape is validated. These decisions are scripted, not an LLM response. A plan is text, not executable code. Provider mode requires the local Python server.";
  checkpoints[4].tool = "browser_verifier";
  checkpoints[4].copy = "Browser verifier: JS re-implementation of the trusted runner's fixture checks. It actually interprets the written recipe and compares every output. No Python unittest, subprocess, or shell runs here; the result code is a JS success/failure convention, not a process exit code.";
  checkpoints[4].example = "Apply trusted JS operations, then compare with shared fixture expectations.\nNo eval. No generated code. No Python execution.";
  checkpoints[5].copy = "The engine discards virtual files after the run. Inspect the actual tool ledger below: a failed fixture is a failed run, never a fabricated success. Refreshing or resetting clears displayed evidence.";
  byId("workspace-boundary").textContent = "A JSON list of five known string operations in a disposable virtual workspace. The editor cannot write fixtures, source code, paths, or commands. No files are written to disk.";
  byId("execution-boundary").textContent = "Browser verifier: JS re-implementation of the trusted runner's fixture checks. It reads the written recipe and compares outputs against shared examples. No Python unittest runs here; passing examples is not a proof of general correctness.";
}

// Configuration exposes model IDs, never credentials or administrator URLs.
async function initialize() {
  try {
    // Only a missing API selects static mode. Broken server configs are errors,
    // never a silent downgrade; provider failures cannot select scripted results.
    const response = await fetch("./api/config", {cache: "no-store"});
    if (response.status === 404) {
      const fixtures = await fetch("./scenarios.json");
      if (!fixtures.ok) throw new Error(`Fixture HTTP ${fixtures.status}`);
      scenarios = await fixtures.json();
      config = browserConfig(scenarios);
      configureBrowserTutorial();
    } else {
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      config = await response.json();
      if (typeof config.token !== "string" || !Array.isArray(config.scenarios)
          || !Array.isArray(config.models)) throw new Error("Invalid local server configuration");
      config.engine = "server";
      byId("runtime-label").textContent = "LOCAL SERVER / PYTHON STDLIB";
      byId("verifier-badge").textContent = "Real unittest subprocess";
      byId("runtime-detail").textContent = "Local engine: owned disk workspace and Python unittest subprocess. Provider credentials stay server-side.";
    }
    config.scenarios.forEach((scenario) => {
      const option = document.createElement("option");
      option.value = scenario.id;
      option.textContent = scenario.title;
      byId("scenario").append(option);
    });
    for (const id of ["planner", "editor"]) {
      config.models.forEach((model) => {
        const option = document.createElement("option");
        option.value = option.textContent = model;
        byId(id).append(option);
      });
    }
    updateControls();
    showCheckpoint();
  } catch (error) {
    config = null;
    byId("run").disabled = true;
    byId("status").textContent = `Cannot initialize: ${error.message}. Use Pages, a static HTTP server, or python server.py (not file://).`;
  }
}
showCheckpoint();
initialize();
