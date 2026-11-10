# Side-effects review — the adapter verification suite (Claude Code), run and recorded

**Version / slug:** `cb-adapter-suite`
**Date:** 2026-11-10
**Author:** Echo
**Second-pass reviewer:** independent reviewer subagent (Fable 5.2; see end)
**Spec:** `docs/specs/context-budget-layered-summaries.md` §9.6 ("each engine supplies one harness adapter with these capabilities, each declared `supported`, `partial` …, `synthesized` … or `absent` per engine version, verified by the **adapter verification suite** (the Phase 0 checks made re-runnable; runner: … on a **throwaway headless session**, never a channel topic; triggers: adapter build and any change of the retained engine binary version; results stored … keyed per `(machine, engine, version)` …; cost bound: one throwaway session per run)"), §17 ("unmeasured or version changed ⇒ `absent` until the suite re-runs for that binary"), §16 Phase 0 ("the adapter verification suite, run for Claude Code"). Converged 6 rounds, approved 2026-11-09 17:22 PST. Phase 0 task 11; stacked on 10c.
**Tier:** 2 (a self-triggered process that spends model calls; behind its own switch, default off).

## Summary of the change

1. **`src/monitoring/adapterVerificationSuite.ts`** (new):
   - `runClaudeCodeAdapterSuite` — one run in a fresh throwaway project directory with PROBE hooks (they record the payloads the engine hands them and print fresh random tokens) driving one engine session line headlessly (`claude -p`, 7 engine calls plus `--version`): learn a codeword; take a real engine checkpoint (in the run's own throwaway state dir); `/compact` as a prompt; ask what the model sees; `/clear` as a prompt; ask the fresh session; a Bash `touch <marker>` against a PreToolUse(`*`) deny; materialise the checkpoint as a new session and ask for the codeword. Every step except the tool-policy one runs with tools disallowed, so a probe session never writes memory or files. Never a channel topic, never tmux.
   - `evaluateSuite` — PURE: decides every §9.6 capability from the evidence (`supported` / `partial` with the exact behaviour / `absent`); a capability the suite does not measure is `absent` with the reason ("unmeasured by this suite: …"), never assumed. Tool policy needs the strongest evidence (spec: absent ⇒ no fold): an ERROR tool_result carrying the deny token AND the command's marker file absent. `/clear` must yield a different session id.
   - A run with any failed engine call, or an unreadable version, is **inconclusive**: it measured the environment (a rate limit, a lapsed sign-in), not the engine, so it is never recorded as that version's result (`writeSuiteResult` refuses it; `readSuiteResults` ignores one).
   - `writeSuiteResult` / `readSuiteResults` — `state/context-budget/adapter-suite/<engine>-<version>.json` (machine-local; the version is sanitised into the file name).
2. **`src/monitoring/adapterSuiteCli.ts`** (new) — the suite's own process (the ~30 s of synchronous engine calls never run on the server's event loop). Its throwaway project and checkpoint live in an OS temp directory, OUTSIDE any repository or agent home (so the probe sessions load no agent CLAUDE.md or memory), removed afterwards; leftovers of a killed run are swept at the next run. A conclusive run is written as the version's result; an inconclusive one exits non-zero (so the trigger's attempt counter retries it) and only `last-run.json` records it, with its errors. Recognised by `INSTAR_ADAPTER_SUITE_CLI=1` (set by the spawner, stripped from the engine's environment) or its own path.
3. **Trigger** — `ContextBudgetSentinel` gains an optional `adapterSuite` dep: each tick, when the engine version (cached `claude --version`, hourly) has no recorded result, start ONE run (not awaited), the attempt stamped durably BEFORE it starts, at most one run at a time, retried at most once per 24 h and given up after 3 attempts per version (`gaveUp` in the status). `productionAdapterSuite` probes the version asynchronously (never blocking the server; `null` until it answers), spawns the CLI in its own process GROUP with the configured Claude binary, keeps its stderr for the failure reason, and kills the whole group after 10 minutes. Server: `contextBudget.adapterSuite.enabled` (default **off** — it spends model calls), inside the (dark) sentinel.
4. **Status** — `GET /context-budget/sentinel` carries `adapterSuite: { running, results (newest 5), attempts, gaveUp, engineVersion (null ⇒ unknown: wrong binary path or failed probe), lastRun (ok, or an inconclusive run's errors) }`; the capability-index description names it.
5. **Self-action registry** — `context-budget-adapter-suite` with its convergence model (≤ 3 runs per version over any horizon).

## Recorded result — Claude Code on this machine

Run 2026-11-10 05:14 PST (result file mtime 05:14:43) through the production entry (`adapterSuiteCli`, the isolated runner after review) against the real binary, recorded at `.instar/state/context-budget/adapter-suite/claude-code-2.1.322.json` on machine `m_e8c9b243c449b1337713bc29d47a6f3a` (the Mama PC), 27.9 s, conclusive (no errors):

| Capability | State | Evidence |
|---|---|---|
| Transcript read | supported | session JSONL at a known path with entries and ids |
| Control-command `/compact` | supported | a `/compact` prompt compacted the session (manual trigger) |
| Control-command `/clear` | supported | a `/clear` prompt started a fresh session (a different id, SessionStart source=clear) |
| Compaction detection | supported | native PreCompact fired AND the transcript carries a compact-boundary entry |
| Pre-compaction steering | supported | PreCompact stdout reached the compaction: the steering token is in the summary |
| Post-compaction event with summary | supported | PostCompact received `compact_summary` (1,563 chars) |
| Fresh-context seed after compaction | supported | SessionStart(compact) fired and the model saw its seed token |
| Fresh-context seed after clear | supported | the model saw the clear seed and NOT the pre-clear codeword |
| Materialise-and-resume restore | supported | a checkpoint materialised as a new session id resumed and recalled the codeword |
| Per-prompt delta injection | supported | UserPromptSubmit `additionalContext` reached the model |
| Per-session tool policy | supported | a PreToolUse(`*`) deny refused the Bash call (error tool_result carrying the reason) and the command never ran |
| Framework discriminator | supported | `INSTAR_FRAMEWORK` reached the hook environment |
| Spawn with initial context (rung 2) | absent (unmeasured) | Instar's own spawn path; covered by its tests |
| Compaction window setting | absent (unmeasured) | needs a full context fill; Phase 2 backstop work |
| Clean-stop signals | absent (unmeasured) | Instar-side signals, not engine capabilities |
| Cost model | absent (unmeasured) | first-party pricing table |

The two pre-review runs (inside the agent home, 28.7 s and 70.7 s) gave the same twelve `supported`; the 70.7 s one loaded the agent's CLAUDE.md and memory, which the isolated runner no longer does (27.9 s). Its leftover checkpoint in the agent's context archive was removed.

## Decision-point inventory

- **Added:** the trigger's run-or-not decision (version unrecorded, no recent attempt, under 3 attempts, not running). It spends model calls; it gates nothing else. Capability results gate nothing yet (Phase 4 uses them to enable an engine).

## 1. Over-block

None.

## 2. Under-block

- **Results are machine-local files**, not yet in the replicated layer kind, so another machine with the same binary re-runs its own suite. Transfer between machines sharing a retained binary is Phase 1, with the layer store. <!-- tracked: CMT-1536 (Phase 1: replicate adapter-suite results through the layer kind; transfer between machines with the same retained binary) -->
- **Cost bound:** the spec says "one throwaway session per run"; a run is one throwaway PROJECT whose session line spans four engine sessions (the main one, the one `/clear` creates, the tool-policy one, the materialised restore), 8 engine calls (~28 s), with tools off on all but one step. The restore and `/clear` checks cannot run in a single engine session by construction.
- **Runner shape:** the spec names "a FoldCoordinator job"; the sentinel owns the trigger here (it already owns the other Phase 0 checks), which is the same machine-local, owner-acting home. A FoldCoordinator lease is not taken because no context is being replaced.
- **Four rows are unmeasured** (above); they read `absent` with the reason, which is the spec's rule for unmeasured capabilities.
- **The Codex adapter suite** is Phase 1 (spec §16). <!-- tracked: CMT-1536 (Phase 1: Codex adapter verification suite) -->
- **The canary's synthetic press** is not performed by this slice; the suite's `/compact` runs on its own throwaway session, which is not topic-bound and so is outside the canary's scope. A press on a throwaway topic session is the Phase 0 verification run on the test agent. <!-- tracked: CMT-1536 (Phase 0 verification: synthetic positive control for the canary on the test agent) -->
- **Agent awareness:** `contextBudget.adapterSuite.enabled` is dark-by-absence (no config default, like the sentinel's own switch); the agent finds the suite through `GET /context-budget/sentinel` (its CLAUDE.md row and capability entry, slice 10c). Turning it on is part of the test-agent verification run, with the sentinel.
- **Engine-checkpoint concurrent append** (tracked from 9a): the suite's checkpoint is taken while the session is quiescent; the racing-append case is not exercised by a real engine here. <!-- tracked: CMT-1536 (Phase 2 runner: concurrent append during checkpoint copy against a real engine) -->

## 3. Level-of-abstraction fit

Pure evaluator + thin runner + process entry + a trigger in the sentinel. The probe hooks measure the ENGINE; Instar's own hooks are verified by their slices.

## 4. Signal vs authority compliance

Signal only (results are evidence; nothing gates on them yet).

## 5. Interactions

- **Subscription quota:** 7 engine calls per run, at most 3 runs per engine version (normally 1). Behind its own switch.
- **Engine transcripts:** the throwaway sessions' transcripts stay in the engine's project directory for the throwaway path (by design: evidence the operator can inspect); the work directory itself is removed.
- **The canary** never sees the suite's sessions (not topic-bound).

## 6. External surfaces

Model calls on the configured subscription when switched on.

## 7. Multi-machine posture

Machine-local by design (the suite measures THIS machine's binary; results name the machine); replication is Phase 1 (above).

## 8. Rollback cost

Revert, or leave `contextBudget.adapterSuite.enabled` off (default). Result files are inert.

## Class-Closure Declaration

- `unbounded-self-action` — closure `guard`: registered `context-budget-adapter-suite`; at most 3 runs per engine version ever (durable attempt count, 24 h floor), one at a time; convergence model in `selfActionRegistry`.

## Evidence

- `tests/unit/adapter-verification-suite.test.ts` (16): the live evidence ⇒ the twelve `supported` and the four unmeasured `absent` with reasons; nothing collected ⇒ all `absent`; twelve spoilers each move exactly their capability (steering partial, detection partial without PreCompact, an auto compaction is not `/compact`, summary-less PostCompact partial, unseen seed partial, clear leaving old context partial, restore without recall partial, no delta absent, no refused tool_result absent, a deny logged but the command RAN absent, `/clear` keeping the same id absent, framework not visible absent); the result store (per version, newest first, torn file skipped, unsafe version sanitised, an inconclusive run refused on write and ignored on read); the CLI against a rate-limited stub engine (ok:false, nothing recorded, errors in `last-run.json`, stale work dirs swept).
- `tests/unit/ContextBudgetSentinel.test.ts` (+4): one run per unrecorded version, never two at once, not again once recorded; a failed run retries only after the backoff, durably across instances; gives up after 3 with `gaveUp` reported; a new version triggers, an unknown version never does.
- `tests/integration/adapter-verification-suite-runner.test.ts` (5): the real runner, probe hooks (through `sh`), evidence collection, real engine-checkpoint restore and evaluator against a fake headless engine: a capable engine reads the twelve `supported`; an engine without PostCompact reads it `absent` and steering `partial`; an engine that cannot run, or is rate-limited, is INCONCLUSIVE and cannot be recorded; an engine that logs the deny but runs the tool reads `toolPolicy` absent; a work path with a space and a quote still measures every hook.
- `tests/integration/context-budget-sentinel-route.test.ts` (+1): the route carries the recorded results.
- `tests/e2e/adapter-suite-lifecycle.test.ts` (2): `productionAdapterSuite` probes a real binary's `--version` asynchronously, the sentinel spawns the REAL suite process, which drives the binary (a fake headless Claude Code, `tests/fixtures/fake-claude-headless.mjs`, running the real probe hooks) and records the result; the status carries it and `lastRun`; the next tick does not re-run; nothing of the throwaway project or its checkpoint lands under the agent's state; WIRED source check (own switch, configured binary).
- **L7:** the production entry against the real Claude Code 2.1.322 on this machine (table above).
- Self-action suite (convergence incl. the new controller), capabilities discoverability, sentinel/canary suites: 1033 unit, 8 integration, 7 e2e green; `tsc --noEmit` clean.

## Second-pass review

**Reviewer (independent subagent on Fable 5.2, 2026-11-10 05:10 PST): "Concern raised."** BLOCKING: (1) a failed run (probe: every call exits 1 with a 429) was written as a measured all-`absent` result with its errors dropped, and the trigger then never retried — permanently marking the version incapable; (2) the throwaway project sat inside the agent's git repo, so every probe session loaded the agent's CLAUDE.md and real auto-memory (~60K tokens of cache creation each), with tools open on the codeword steps, so the model could write the codeword into the agent's memory and the restore check could pass from memory; (3) `toolPolicy` was a substring match over the transcript, so an engine that logged the deny but ran the tool read `supported`. MINOR: unquoted deny-script path (a state dir with a space flipped toolPolicy); the CLI flag leaked into the engine's env; the child's stderr was lost; a wrong binary path was invisible; the 10-minute kill missed the engine calls and skipped cleanup; the version probe blocked the event loop; an `unknown` version burned attempts; the suite's checkpoint was left in the agent's context archive; `/clear` did not check the id changed; undisclosed session count and config awareness; test gaps (fakes shared the evaluator's assumptions). Verified fine: distinct token prefixes, prompts carry no tokens, one source per token, the bounded trigger, the live deny evidence being a real `is_error` tool_result.

**Resolution:** all three BLOCKING fixed — inconclusive runs (any failed engine call, unreadable version) are never recorded (write refuses, read ignores), exit non-zero so the attempt counter retries, and keep their errors in `last-run.json`; the work dir and checkpoint live in an OS temp dir outside any repo or agent home and every step but the tool-policy one runs with tools disallowed (re-run live: 27.9 s instead of 70.7 s); tool policy needs an error tool_result carrying the token AND the command's marker file absent. Minors: quoted path; flag stripped from the engine env; stderr kept; `engineVersion` and `lastRun` in the status; process-group kill and a stale-work sweep; async version probe; `unknown` version ⇒ inconclusive; the old checkpoint removed and new ones kept in the throwaway dir; `/clear` must change the id; the session count and the dark switch disclosed in §2. Tests added for each blocking case with fakes that can now disagree with the evaluator (a deny-ignoring engine, a rate-limited engine, a path with a space and a quote), and the CLI against a stub engine.

**Re-check (same reviewer, 2026-11-10 05:18 PST): "Concur with the review."** Probes now come out right: a 429 stub is inconclusive (nothing recorded, errors in `last-run.json`, `run()` rejects so the attempt counter handles it); deny-ignoring stubs read `toolPolicy: absent`; space-in-path runs read twelve `supported` with nothing landing in the agent's context archive; the engine no longer sees the CLI flag; a missing dist's rejection carries stderr; a wrong binary shows `engineVersion: null` and `lastRun`; the version probe is asynchronous. Live re-run evidence (read-only): sessions under `/tmp/instar-adapter-suite-…`, no CLAUDE.md or agent memory loaded, ~8K tokens of cache creation per session (was ~60K), the deny transcript carries an `is_error` tool result. Not exercised: the 10-minute process-group kill (read correct). Minors and resolution: read tools also closed on the non-policy steps (`Read,Grep,Glob` added); the marker path is quoted in the prompt; a failure message keeps stderr's head (the "Cannot find module" line); the first suite run starting one tick after boot (the async probe) is accepted.
