# Side-Effects Review — SessionWatchdog stuck-command fail-closed

**Version / slug:** `watchdog-stuck-failclosed`
**Date:** `2026-06-09`
**Author:** `Instar Agent (echo)`
**Second-pass reviewer:** `independent reviewer subagent — concurred`

## Summary of the change

`SessionWatchdog.isCommandStuck` decides whether a long-running shell command inside a session should be Ctrl+C'd. It flags candidates after 3 min, then asks an LLM "stuck vs legitimate" before escalating. Previously, when the LLM was unavailable (`!this.intelligence`) or threw (rate-limit / circuit-open / timeout), it returned `true` (fail-open) → Ctrl+C. Under load (exactly when the LLM is unavailable) this interrupted legitimate builds/tests/coverage runs ("Interrupted · What should Claude do instead?"). This change makes both fail paths fail CLOSED via a new `hardCeilingExceeded(elapsedMs)` helper: when the judge can't run, do NOT interrupt below `hardCeilingMs` (config `monitoring.watchdog.hardCeilingSec`, default 1800s; `0` disables), and only escalate past it — preserving deterministic recovery of a genuinely hung command without the LLM. Files: `src/monitoring/SessionWatchdog.ts` (field + constructor + isCommandStuck + helper), `src/core/types.ts` (config field), `tests/unit/SessionWatchdog-failclosed.test.ts` (new), `tests/unit/SessionWatchdog-pipeline.test.ts` (updated the test that encoded the old fail-open).

## Decision-point inventory

- `SessionWatchdog.isCommandStuck` (destructive escalation gate → Ctrl+C) — **modify** — the two fail-open branches (no-LLM, catch) now fail closed with a deterministic hard-ceiling backstop. The positive-LLM-verdict path (legitimate→false, stuck→true) is unchanged.
- `hardCeilingExceeded` — **add** — pure deterministic helper (`hardCeilingMs > 0 && elapsedMs > hardCeilingMs`).
- Stdin-consumer fail-closed guard (existing, line ~389) — **pass-through** — unchanged; still refuses to escalate a stdin-consumer without an LLM.

## 1. Over-block

This change strictly REDUCES over-block. Before, under load the watchdog Ctrl+C'd every command past 3 min (massive over-block of legitimate work). After, those legitimate commands are left alone. No new legitimate input is now interrupted that wasn't before. (Inside the attention of "could a legitimate command exceed the 30-min hard ceiling with the LLM down and get killed?" — yes, a >30-min legitimate command running while the LLM is fully unavailable would be Ctrl+C'd. That is far rarer than the 3-min false-positives this removes, and the ceiling is tunable / disengageable with `0`.)

## 2. Under-block

A genuinely-stuck command running while the LLM is unavailable is no longer killed at 3 min — it waits until the 30-min hard ceiling (or, with `hardCeilingSec: 0`, is never auto-killed without a positive LLM verdict). This is the deliberate, safe trade for a destructive action: recovery of a truly-hung command is delayed (not lost — the ceiling still fires, the user can `/interrupt`, and the SilenceSentinel observes a non-progressing session). Residual gap (stated, not deferred): the change does not add an output-progress signal (kill-only-if-no-new-output) to the LLM-available path — a wrong "stuck" verdict from the LLM on a quiet-but-legitimate command can still escalate; that path is unchanged by this fix and is a much rarer failure than the fail-open path being closed here.

## 3. Level-of-abstraction fit

Correct layer. The decision lives in the watchdog's own escalation gate, where the destructive authority (Ctrl+C) is exercised. The new helper is a deterministic primitive at the same layer. No higher-level gate should own "is this shell command hung" — it is a per-session, per-process judgment the watchdog already owns. The fix aligns the normal-command path with the already-correct stdin-consumer fail-closed behavior at the same layer (consistency, not a new layer).

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [x] No — this change has no NEW block/allow surface; it narrows an existing brittle authority so it no longer fires destructively on an unavailable judge.

This is the canonical case the "No Silent Degradation to Brittle Fallback" standard targets: a destructive action (Ctrl+C) was gated on an LLM judgment that fell OPEN to a brittle default. The fix makes the destructive action fail CLOSED (do nothing) when the judge can't run, with a deterministic backstop for the genuinely-hung case. It removes brittle destructive authority rather than adding any.

## 5. Interactions

- **Shadowing:** runs in the same `checkSession` escalation path; order unchanged. The stdin-consumer guard (line ~389) still runs after `isCommandStuck`; since `isCommandStuck` now returns false more often (below ceiling, no LLM), the path simply returns earlier (temporaryExclusions.add). No check is newly shadowed.
- **Double-fire:** none — escalation still happens at most once per candidate; `temporaryExclusions` and `escalationState` semantics unchanged.
- **Races:** `hardCeilingMs` is read-only after construction; `hardCeilingExceeded` is pure. No new shared state.
- **Feedback loops:** none.

## 6. External surfaces

- **Other agents / users:** ships to the install base. User-visible effect is positive: fewer "Interrupted" events on healthy sessions under load. No message format or API change.
- **Config:** adds optional `monitoring.watchdog.hardCeilingSec`. Code default `?? 1800`, so existing agents get the new behavior on update with NO config-file change required — **no migration needed** (the default lives in the constructor, not in a config file). `ConfigDefaults.ts` is untouched intentionally.
- **Persistent state:** none.
- **Timing:** behavior depends on `elapsedMs` vs `hardCeilingMs` and on LLM availability — all already-present runtime inputs.

## 7. Rollback cost

Pure code change, no persistent state, no migration. Back-out = revert the commit, ship the next patch; behavior returns to the prior (fail-open) state. No agent-state repair. Low rollback cost. (Operational note: a deployed agent can also neutralize the change live by setting `hardCeilingSec` very low to restore aggressive behavior, or `0` to make it maximally conservative — no redeploy needed.)

## Conclusion

The review confirms a scope-narrowing, safety-improving fix: it removes a destructive fail-open (the observed cause of "interrupted out of nowhere" under load) and adds no new blocking surface, while a deterministic hard ceiling preserves recovery of genuinely-hung commands. No design change required by the review. Because the change touches a watchdog with kill authority, a Phase-5 second-pass review is required before commit.

## Second-pass review (if required)

**Reviewer:** independent reviewer subagent (general-purpose)
**Independent read of the artifact: concur**

Concur with the review. The reviewer independently traced every path and confirmed: (1) both fail paths now return `hardCeilingExceeded(elapsedMs)` not bare `true` (SessionWatchdog.ts:671, 732), with a correct strict-`>` boundary and `0`-disables guard (:748); (2) the genuinely-hung non-consumer case still reaches `sendKey('C-c')` past the ceiling (traced :671→:418); (3) **kill authority strictly narrows** — for the two changed branches `new ≤ old` for every input, so the change can never produce a Ctrl+C the old code wouldn't have; (4) the stdin-consumer guard (:395) composes correctly — a hung stdin-consumer without an LLM is still (intentionally, conservatively) not killed even past the ceiling, while the `crontab -` deterministic-recovery example is a non-consumer so it does reach the kill path; (5) `?? 1800` honors an explicit `0`; (6) tests exercise both sides with realistic inputs and the pipeline test was strengthened (old fail-open assertion replaced with fail-closed + a real past-ceiling recovery assertion), not weakened. The §2 residual gap (LLM-available wrong-"stuck" verdict on a quiet legitimate command) is out of scope and disclosed, not silently deferred.

## Evidence pointers

- Live: `logs/server.log` — `[Watchdog] "<session>": stuck command (190s|230s) … — sending Ctrl+C` on legitimate work under load; user screenshot of a session interrupted mid-`docs-coverage.mjs --check`.
- Tests: `tests/unit/SessionWatchdog-failclosed.test.ts` (8, both sides), `tests/unit/SessionWatchdog-pipeline.test.ts` (updated). 175 watchdog/triage unit tests green; tsc + lint clean.
