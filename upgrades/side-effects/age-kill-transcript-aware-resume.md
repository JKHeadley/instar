# Side-Effects Review — Age-Kill Transcript-Awareness

**Version / slug:** `age-kill-transcript-aware-resume`
**Date:** `2026-06-14`
**Author:** `echo`
**Second-pass reviewer:** spec-convergence panel (6 internal reviewers + Standards-Conformance gate; external non-Claude pass degraded — see convergence report)

## Summary of the change

The session age-limit reaper (`SessionManager.monitorTick`, the `elapsed > limit` block) decides
whether an over-age session is "truly idle" and therefore age-kill-eligible. Before this change
that decision used only two signals — the tmux pane shows an idle prompt, and there is no
non-baseline child process — both BLIND to MCP/tool work (the Playwright MCP server runs out of
the pane's process tree; bash tool calls are short-lived). On 2026-06-13 an actively-working
session was terminal-killed because, between tool calls, it looked idle. This change adds a third
signal: `isTranscriptRecentlyActive(session, 120_000)` — true when the session's framework
transcript (JSONL) was modified within the last 2 minutes. The idle decision is extracted into a
pure, exported `isAgeGateTrulyIdle(idleAtPrompt, hasActiveProcs, transcriptActive)` so the exact
incident is reproducible at the decision boundary in a unit test. Files: `src/core/SessionManager.ts`
(constant `AGE_GATE_TRANSCRIPT_ACTIVE_MS`, the `isAgeGateTrulyIdle` function, the
`isTranscriptRecentlyActive` method, the import of `resolveFrameworkTranscriptPath`, and the
age-gate wiring); tests in `tests/unit/session-timeout-activity-aware.test.ts` and
`tests/unit/session-manager-behavioral.test.ts`.

## Decision-point inventory

- `SessionManager.monitorTick age-gate (ageGateTrulyIdle)` — **modify** — adds a transcript-activity
  defer condition; the kill now requires idle-pane AND no-child-proc AND transcript-not-recently-active.

---

## 1. Over-block

**What legitimate inputs does this change reject that it shouldn't?**

In reap terms, "over-block" = wrongly DEFERRING a kill. A genuinely-finished session whose
transcript was touched <2 min before the check is held off for up to one 2-minute window. This is
harmless: the idle-detection block immediately below the age gate still reaps it once its
transcript goes quiet. No session is kept alive indefinitely on a stale signal — only real,
ongoing transcript writes (which require real model activity) sustain the defer.

## 2. Under-block

**What failure modes does this still miss?**

The change ONLY adds a defer condition; it removes no kill. A session with NO resolvable transcript
(an unknown framework, or pi-cli which has no resolver case) gets `isTranscriptRecentlyActive ===
false` and the age gate falls back to EXACTLY today's pane/procs verdict — so such a session is no
better protected than before (safe degradation, no NEW under-block). The deliberate non-coverage:
the age gate does not try to be a hard resource ceiling for runaway-but-active sessions — that is
owned by SessionWatchdog (stuck-process), the context-wedge sentinel, and the CPU/memory-pressure
reaper, all unchanged.

## 3. Level-of-abstraction fit

**Is this at the right layer?**

Yes. The SessionReaper (the pressure/idle reap path) ALREADY layers transcript-growth awareness
(`probeTranscript`/`transcriptDelta`). This change brings the parallel age-kill path to parity at
the SAME layer using the SAME core resolver (`resolveFrameworkTranscriptPath` from
`core/FrameworkSessionStore`). It is a cheap detector feeding an existing defer, not a new
authority and not a re-implementation of an existing primitive. It deliberately does NOT depend on
`monitoring/transcriptProber` (that would invert core→monitoring layering); it uses the core
resolver directly.

## 4. Signal vs authority compliance

**Does this hold blocking authority with brittle logic, or produce a signal that feeds a smart gate?**

It produces a SIGNAL that ADDS a defer (keep) condition to an existing authority. It grants no new
blocking authority and moves strictly in the safe direction (fewer kills of active sessions). The
probe is brittle (a single statSync) but its failure mode is bounded by the fail-to-`false`
contract: a probe error never keeps a session alive — it only declines to add the new defer
reason, falling through to the existing pane/procs verdict. (Ref: `docs/signal-vs-authority.md`.)

## 5. Interactions

**Does it shadow another check, get shadowed, double-fire, or race with adjacent cleanup?**

Consistent with the SessionReaper's existing transcript gate (same resolver, same intent). The
single-point mtime check vs the SessionReaper's cross-tick delta is an intentional, benign
asymmetry (the SessionReaper requires repeated positive-idle confirmations before it reaps, so the
two never produce a contradictory kill on the same tick). The idle-detection block below the age
gate still owns genuinely-idle reaping (the held off path falls through, no `continue`). No new
kill/revive loop: the change does NOT touch `WorkEvidence`/`ReapGuard.evaluate()`/`workEvidence()`,
so the documented evaluate-vs-workEvidence disagreement class (2026-06-13 13-session loop) is
untouched. Adversarial review confirmed loop-safety. The `overAgeButActiveLogged` set already
prevents log spam on the held off path.

## 6. External surfaces

**Does it change anything visible to other agents/users/systems? Timing/state dependence?**

No API route, no config key, no hook, no template, no dashboard surface. The only externally
observable effect: a long-running, actively-working session is no longer terminal-killed at ~5h —
which is the intended, operator-requested behavior. The new constant is code-level (not a config
surface). The change reads only a local file's mtime; it depends on the framework runtime writing
its transcript on activity (true for claude-code, codex-cli, gemini-cli; pi-cli safely degrades).

## 7. Multi-machine posture (Cross-Machine Coherence)

**Machine-local BY DESIGN.** Each machine's `SessionManager` reaps only its OWN sessions and reads
only its OWN local transcripts. There is no shared/replicated/proxied state: the decision is a
per-session, per-machine read of a local file. No cross-machine surface is introduced or needed —
a reap decision is inherently local to the machine running the session. No user-facing notice is
added (so no one-voice gating concern); no durable cross-machine state (so no topic-transfer
strand); no generated URL.

## 8. Rollback cost

Revert the PR — a single-file behavior change plus its tests; no data migration, no agent-state
repair, no config rollback. As an interim dial without a revert, setting
`AGE_GATE_TRANSCRIPT_ACTIVE_MS` to 0 makes the new defer condition inert (reverts to the prior
two-signal behavior). Ships with the dist on update (no PostUpdateMigrator entry needed — the
change is internal runtime behavior, not an agent-installed file).
