# Toolbench — constrained LLM coding-agent demo

A standalone, local-first portfolio project demonstrating **plan → constrained
read tools → proposed edit → schema/path validation → real write → subprocess
unittest → cleanup**. No packages, frontend build, credentials, or network are
required for the default demo. Python **3.11+** is the intended runtime.

This is a deliberately finite **declarative recipe editor**, not a general coding
assistant. It edits executable *behavior* through trusted operations, never by
running model-generated Python on your host.

## Run locally

From this directory in PowerShell:

```powershell
python server.py
```

Open **http://127.0.0.1:8080**. Choose a sample task, click **Run the workflow**,
and inspect six checkpoints and the expandable tool ledger. Both included tasks
have working deterministic offline solutions. Use `--port 8081` if needed.
Stop with Ctrl+C.

- **Sample task:** choose tag normalization or order-preserving label cleanup.
- **Backend:** scripted offline decisions, or two actual provider calls.
- **Planner/editor model:** independently choose administrator-allowlisted IDs
  in provider mode; using different IDs demonstrates role-based multi-model
  routing, not model benchmarking or automatic selection.
- **Next / Back / numbered checkpoints:** explain completed evidence; they do
  not pause or individually approve server tools. Before a run they show clearly
  labeled illustrative examples.
- **Reset tutorial:** clears browser evidence only; no persistent session exists.
- **Tool events:** expand to see actual before/after JSON and subprocess output.

No general free-text task box is offered: supported tasks and fixtures are
explicitly curated. That limitation is part of the safety design.

## Real OpenAI-compatible provider (optional)

Set server-side environment variables, then start/restart the server:

```powershell
$env:AGENT_API_BASE = "https://api.openai.com/v1"
$env:AGENT_MODELS = "gpt-4o-mini"
$env:AGENT_API_KEY = "your-own-key"
python server.py
```

The model ID is an example, **not a promise of current account availability**.
Use an ID your provider actually serves. For separate models, configure a
comma-separated allowlist, e.g. `planner-model,editor-model`. A local model server
can use `AGENT_API_BASE=http://127.0.0.1:11434/v1` and an explicitly installed model
ID in `AGENT_MODELS`; no local runtime/model is bundled or downloaded.

The provider must support `POST <base>/chat/completions`, `messages`, `model`, and
`temperature: 0`, and return `choices[0].message.content` as strict JSON text with
`finish_reason: "stop"`. API key is optional for local endpoints. No SDK is used.
Planner returns `{"plan":["..."]}`; editor returns exactly:

```json
{"path":"task.json","content":{"operations":["trim","lowercase","drop_empty","unique","sort"]}}
```

Operation order matters. `unique` preserves the first occurrence. Each operation
may appear at most once. Empty recipes are schema-valid but usually fail tests.

Unsupported model IDs, provider HTTP errors, timeouts, redirects, refused
responses, tool calls, truncated output, Markdown fences, duplicate JSON keys,
non-finite JSON, extra edit fields, invalid paths, and unknown operations are
**errors**, never reasons to silently use the offline solution. Models without
this exact protocol are unsupported. Remote provider behavior is not verified
by the offline test suite.

Provider mode transmits the selected sample task, plan, recipe and fixtures to
your configured provider. Provider policy, cost and data retention are your
responsibility. API keys are not sent to the browser or test subprocess. Only
administrator environment variables configure destinations; request bodies
cannot supply arbitrary URLs. HTTPS is required except on loopback HTTP.
Environment proxies and HTTP redirects are disabled.

## What really happens

1. Create `.workspaces/<random UUID>` with a matching ownership marker.
2. Install a starter `task.json`, fixed `fixtures.json`, and a copy of the
   checked-in trusted `verify.py` runner into that owned workspace.
3. Produce a validated descriptive plan (script or real planner model).
4. Read the two allowed sample data files; send only these to the editor.
5. Validate the editor proposal, then write only `task.json`.
6. Run `[sys.executable, "-I", "<owned workspace>/verify.py"]` with `shell=False`,
   a 10-second timeout and no inherited API credentials. The fixed runner uses
   `unittest` subtests for three fixtures. Show actual stdout/stderr and exit code.
7. Remove only owned allowlisted files and the UUID directory. The empty
   `.workspaces` parent may remain. Failures also attempt ownership-checked cleanup.

There is no retry/repair loop; a semantically wrong but structurally safe edit
produces a real failed test result. Provider/schema errors return HTTP 400 with
an explicit message (partial traces are not retained). A second concurrent run
is rejected. Runs are in-memory; refreshing loses the browser trace.

## Exact trust boundaries

**Untrusted:** browser request bodies, provider content, JSON edit proposals and
model prose. These cannot choose host paths, subprocess arguments, imports,
Python source, or test fixtures. All model text is rendered with `textContent`.
The recipe language consists only of `trim`, `lowercase`, `drop_empty`, `unique`,
and `sort` over fixed, small string arrays. No `eval`, `exec`, generated source,
shell commands, repository access, or user-supplied fixtures exist.

**Trusted:** installed source/static files, the Python interpreter and stdlib,
administrator environment, OS, and local account. The tools use exact filename
allowlists; absolute, UNC, traversal, backslash, encoded and alternate-stream
paths do not match. Workspace ancestors and files are checked for symlinks and
Windows reparse points/junctions. Cleanup verifies an ownership marker and does
not recursively follow unknown files. If cleanup encounters unexpected changes,
it refuses rather than deleting unknown content.

**Not an OS sandbox:** checks are not race-proof against a malicious local
process that can mutate the directory between checking and opening files.
Use a trusted local account and project directory. `-I`, timeouts, and Docker
are defense-in-depth, not permission to execute arbitrary generated code. A
crash/forced termination can leave an owned UUID workspace; inspect it manually
before deletion. A writable parent or compromised checked-in runner defeats the
trust assumptions. Hosts with reparse-point ancestors must move the project to
a plain local path.

**HTTP boundary:** default bind is `127.0.0.1`. Exact Host checks, same-local-origin
checks, a per-process session token, no CORS, bounded request bodies, explicit
asset routes, CSP, and no framing mitigate drive-by browser access and DNS
rebinding. The token is not user authentication: any local process can fetch it.
Do not expose this server publicly, place it behind an untrusted proxy, or use
it as a multi-tenant service. Threads/network waits have basic timeouts but not
production-grade connection/rate/resource limits. No authentication, TLS server,
audit persistence, request cancellation propagation, or credential vault is
provided. `--host 0.0.0.0` is explicit and intended for the container only.

**Validation boundary:** fixed visible fixtures are acceptance examples, not
hidden evaluation or a proof of correctness. Model plans are not checked for
truth or usefulness beyond their schema. A successful test run certifies only
these examples under this finite interpreter.

## Tests and validation

Run centrally from this directory:

```powershell
python -m unittest discover -s tests -v
python -m compileall -q agent.py provider.py server.py trusted_runner.py tests
```

The suite includes both offline workflows, a safe-but-wrong provider edit with
real failed subprocess tests, schema/output failures, traversal/absolute/UNC/ADS
paths, Windows reparse detection, optional real symlink checks (skipped without
OS permission), provider protocol doubles, no-fallback behavior, and loopback
HTTP integration. All fixtures/workspaces remain inside this project. No live
provider calls or external dependencies are required. CI is configured for
Windows/Linux and Python 3.11–3.13; this states intended validation coverage,
not a claim that CI has already run.

Manual browser smoke: exercise both tasks, all checkpoint buttons, Back/Next,
Reset, trace expansion, mobile width, offline/provider selection and the
unconfigured-provider explanation. For real provider verification, configure a
served model and inspect both actual call roles and resulting tests. The
implementation author did **not** execute commands/tests during generation;
central execution is required before calling this validated.

## Optional Docker

```powershell
docker build -t constrained-agent-demo .
docker run --rm --cap-drop=ALL --security-opt=no-new-privileges -p 127.0.0.1:8080:8080 constrained-agent-demo
```

The image runs as UID 10001, writes only its owned `.workspaces` directory in
normal operation, and binds all container interfaces so loopback-only host
publishing can reach it. Do not mount host directories or the Docker socket.
No secrets are baked into the image; local `.env` files are excluded. If needed,
pass credentials with explicit runtime environment variables using your own
secret-management approach. Container loopback is not host loopback: a local
provider on the host may require a secure reachable HTTPS endpoint instead.
Docker build/runtime is optional and not claimed verified until run.

## Portfolio honesty / resume alignment

| Resume topic | Implemented here |
| --- | --- |
| Planning, tool use, edits, validation | Finite, explicit Python orchestration with actual JSON edits and tests |
| Python | Standard-library server, provider client, interpreter and tests |
| OpenAI / local LLM | Optional real OpenAI-compatible HTTP protocol; no bundled models |
| Multi-model | Independently allowlisted planner/editor roles; no automatic routing/evaluation |
| Docker | Optional non-root container definition; not a security sandbox claim |
| LangChain / LangGraph | **Not used**; orchestration is ordinary Python, not framework graphs |
| GitHub API / PR automation | **Not implemented**; CI YAML is not an API integration |
| General autonomous coding | **Not implemented**; no arbitrary source edits or generated-code execution |

This working demonstrator supports those narrowly stated portfolio claims. It
does not retroactively substantiate broader resume claims about missing
frameworks, integrations, benchmarks, deployments or production usage.

## Source map

- `agent.py`: workflow, validation, owned read/write tools and subprocess boundary.
- `provider.py`: explicit provider configuration and strict HTTP/JSON protocol.
- `trusted_runner.py`: fixed finite interpreter and immutable-fixture unittest.
- `server.py`: stdlib HTTP routes and browser-origin guards.
- `static/`: interactive checkpoint tutorial and real tool trace viewer.
- `tests/`: dependency-free unit and integration coverage.

MIT licensed; see `LICENSE`.
