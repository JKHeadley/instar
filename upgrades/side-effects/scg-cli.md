# Side-effects review — `instar spec conformance` CLI (scg-cli)

**Scope**: Ship the tracked `scg-cli` deferral from the standards-conformance-gate
spec (`docs/specs/standards-conformance-gate.md`, approved/merged in #373): a
command-line entry point to the conformance gate, so a spec can be checked
against the constitution without curl. Thin client over the existing
`POST /spec/conformance-check` route.

**Files touched**:
- `src/commands/spec.ts` — NEW. `runSpecConformance({specPath,dir,port,json})`:
  reads the spec file, resolves port + authToken from `loadConfig`, POSTs
  `{markdown}` to the local server's conformance route, prints a formatted
  rule-by-rule report (or `--json`). Server-down / 503 / missing-file are clear
  errors with non-zero exit.
- `src/cli.ts` — register `instar spec conformance <path>` (a `spec` command group
  + `conformance` subcommand) using the established Commander + `loadConfig` pattern.
- `tests/unit/spec-conformance-cli.test.ts` — 5 tests (posts markdown, prints
  findings, clean-pass, degraded-advisory, --json, missing-file exit).

**Under-block / over-block**: None. The CLI only *reads* a spec and *prints* a
report; it has no authority (mirrors the route's signal-only nature). It cannot
block anything.

**Level-of-abstraction fit**: The CLI is a thin presentation layer over the
already-built route + reviewer; it duplicates no logic. It reuses the standard
CLI→local-server pattern (`loadConfig` → port/authToken → fetch), so the
subscription-backed intelligence provider stays server-side (the CLI never
constructs an LLM client).

**Signal vs authority**: Inherits the route's signal-only posture — prints
"possible violations (you decide)", never a pass/fail verdict that gates anything.

**Interactions**:
- Requires the local server running (it's a client). Server-down → a clear
  "Is the server running?" error + exit 1, not a crash.
- Reads `config.port` (so it targets the agent's real port, e.g. 4042) with a 4040
  fallback; reads `authToken` for the Bearer header.
- 60s fetch timeout (a `capable`-tier conformance check can take a while).

**External surfaces**: New CLI subcommand `instar spec conformance <path>
[--dir] [--port] [--json]`. New exported `runSpecConformance`. No new endpoint,
no config change.

**Rollback cost**: Trivial. Remove the command registration + `src/commands/spec.ts`
+ the test. The route it calls is unaffected.

**Migration parity**: CLI code only (shipped in the package; every agent gets it
on update). No hook/template/config/skill change.
