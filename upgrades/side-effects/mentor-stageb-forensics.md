# Side-Effects Review — Stage-B deep forensics (§19.4 follow-on)

**Spec:** `docs/specs/FRAMEWORK-ONBOARDING-MENTOR-SPEC.md` (converged 5 iters, approved by Justin)
**Change:** Makes Stage B *real* — instead of returning `[]`, it now reads the mentee's actual
signals (recent server-log error/sentinel lines + a codex-rollout usage digest) and classifies them
into bucketed findings via the LLM. New pure module `MentorStageBForensics` (prompt assembly +
defensive parse, fully unit-tested); the AgentServer closure does the I/O (read logs/rollouts) and
injects `IntelligenceProvider.evaluate`.
**Files:** `src/scheduler/MentorStageBForensics.ts` (new), `src/server/AgentServer.ts`,
`tests/unit/MentorStageBForensics.test.ts` (new), `tests/e2e/mentor-onboarding-lifecycle.test.ts`,
`upgrades/NEXT.md`.

## Principle check (Phase 1)

Decision point? No new one. Stage B produces *signal* (ForensicFinding[] → the ledger). It reads
logs/rollouts (read-only) and classifies via the LLM. No gating, no action. Still dormant
(`mentor.enabled=false`), and Stage B only runs inside an enabled+safe+in-budget tick.

## The seven questions

1. **Over-block.** N/A — produces findings, blocks nothing. The prompt instructs the model to
   report `[]` rather than speculate, biasing toward fewer (real) findings over false ones.
2. **Under-block.** Forensic signals are bounded (last 40 error-ish log lines + ≤3 recent rollout
   digests); a subtle issue not evidenced in those signals won't be caught — acceptable (the loop's
   other signal is the Stage-A leak detector, and the funnel logs every run). The parse is defensive:
   invalid-bucket / titleless / malformed entries are dropped; a non-JSON or throwing LLM call yields
   `[]`, never a crash or a poisoned ledger entry.
3. **Level-of-abstraction fit.** Prompt + parse are a pure module (`MentorStageBForensics`) — no I/O,
   no LLM — so the classification logic is unit-tested in isolation. The AgentServer closure owns the
   I/O (reads `logs/server.log` + `~/.codex/sessions/` via the existing `parseCodexRollout`). Correct
   split; reuses the established rollout parser rather than re-implementing.
4. **Signal vs authority.** Compliant. Findings are signal; the human + normal gates hold authority.
   The model is constrained to the three buckets + JSON; free-text is title-only and length-capped.
5. **Interactions.** Reuses `parseCodexRollout` (no new rollout logic) and `IntelligenceProvider`
   (the established judgment-call path, `model: capable`, attributed `mentor-stage-b`). Findings flow
   to `ledger.captureRun` (existing funnel). Signal-gathering is wrapped in try/catch — a log/rollout
   read failure degrades to fewer signals, never a crash.
6. **External surfaces.** No new routes. Reads existing on-disk logs/rollouts (read-only). The LLM
   call is a background-attributed judgment call. Still Bearer-gated overall; still dormant.
7. **Rollback cost.** Low. Revert restores the `[]` stub. No schema/migration change.

## Phase 5 — second-pass

Not required. No new decision surface — Stage B was always specced to read + classify; this fills in
the real reader/classifier behind the §19.4 loop (which carried the dedicated second-pass). The new
logic is pure + defensively-tested; the I/O is read-only with try/catch. Bias is explicitly toward
no-finding over false-finding.

## Remaining before `live`

`getSurface` still returns an empty conversation history (Stage A has thin context until the
Threadline conversation source is wired) — tracked (<!-- tracked: topic-13435 -->), and validated at
the live step. Forensic depth is intentionally bounded; richer diff/PR analysis is a future follow-on.

## Testing

- Tier 1 (unit, +10): prompt names framework + buckets + JSON-only; parse handles clean JSON,
  markdown fences, invalid-bucket/titleless drops, non-JSON/empty → [], finding cap, dedupKey
  derivation; analyzeForensics no-LLM-call-without-signals, classifies real signals, []-on-throw.
- Tier 3 (e2e, +1): server boots clean with the forensics wiring; mentor stays dormant
  (`/mentor/tick` → disabled) on the production path.
- route-completeness + discoverability gates pass; affected push-config suite green (488) vs main.
