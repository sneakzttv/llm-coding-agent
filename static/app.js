"use strict";

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
  byId("status").textContent = "Tutorial reset; no server files were changed.";
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
    byId("status").textContent = real ? "Ready for two real provider calls. Task data will leave this process." : "Ready offline. No credentials or network needed.";
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
    const response = await fetch("/api/run", {
      method: "POST", headers: {"Content-Type": "application/json", "X-Demo-Token": config.token},
      body: JSON.stringify(request), signal: controller.signal
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
    result = data;
    byId("result-badge").textContent = data.status.toUpperCase();
    finalMessage = data.tests.passed ? "Tests passed. Explore each checkpoint and tool event." : "Tests failed. Inspect the actual unittest output at checkpoint 5.";
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

// Configuration exposes model IDs, never credentials or administrator URLs.
async function initialize() {
  try {
    const response = await fetch("/api/config");
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    config = await response.json();
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
  } catch (error) {
    byId("status").textContent = `Cannot connect: ${error.message}. Open the page through python server.py, not as a file.`;
  }
}
showCheckpoint();
initialize();
