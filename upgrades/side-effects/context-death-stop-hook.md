# Side-effects review — context-death stop hook (B15 tone-gate rule)

**Scope**: Add `B15_CONTEXT_DEATH_STOP` to `MessagingToneGate`. The
operator explicitly asked for a structural guard against the agent's
recurring "Context-Death Self-Stop" pattern (CLAUDE.md anti-pattern,
multiple memory entries) because documentation alone has not eliminated
the slip.

**Files touched**:
- `src/core/MessagingToneGate.ts` — adds `'B15_CONTEXT_DEATH_STOP'` to
  `VALID_RULES`; adds a new `## SELF-STOP rule` section in `buildPrompt`
  describing literal pattern markers + legitimate-stop carve-outs;
  updates the response-format rule list to include B15.
- `tests/unit/messaging-tone-gate-b15.test.ts` — 9 new tests covering
  prompt-render assertions, drift-detection acceptance of B15,
  propagation of a valid B15 response, and pass-through of completion /
  blocker / topic-split candidates.
- `specs/dev-infrastructure/context-death-stop-hook.md` — converged +
  approved (single-iteration; design intent authored by operator).
- `specs/dev-infrastructure/context-death-stop-hook.eli16.md` — plain-
  English companion.
- `docs/specs/reports/context-death-stop-hook-convergence.md` — report.

**Under-block**: Narrow. The rule keys on the candidate message itself.
If the agent slips into the pattern in *internal* reasoning (thought
traces, plan files) but produces an outbound message that doesn't carry
any of the literal markers, B15 does not fire — exactly the boundary the
authority is supposed to enforce. That's correct: this is the outbound-
message authority, not a thought-monitor.

**Over-block**: Minimal by design. The rule has explicit
legitimate-stop carve-outs (real question, real blocker, real error,
real completion) AND explicit non-applicability boundaries (discussion-
about-the-pattern, topic-split/move logistics, operator-initiated stop
messages). The LLM gate is the existing authority that combines literal
markers with conversational context. Failure-mode: an LLM call timeout
or parse failure → fail-open (gate's existing semantics), so a network
hiccup never silences a legitimate message.

**Level-of-abstraction fit**: B15 lives where B1–B14 already live. No
new authority, no new file, no new endpoint. The structural placement
is sibling to existing rules, and the same drift-detection (rule
citation must be in `VALID_RULES`) governs it.

**Signal vs authority**: Compliant. The literal pattern markers in the
prompt are the SIGNAL; the LLM gate (the existing authority) decides
block/pass after combining markers with the legitimate-stop carve-outs
and conversational context. No new authority is introduced; no signal
becomes a blocker on its own.

**Interactions**:
- B15 does not change B1–B14 behavior. The drift-detection (any rule
  cited must be in `VALID_RULES`) gains one entry; existing rules
  remain valid.
- The fail-open paths (`failedOpen: true`, `invalidRule: true`) are
  unchanged.
- All paths that call `MessagingToneGate.review()` automatically benefit
  from B15 — no caller changes required. Tested implicitly by the
  existing health-alert + attention-route tests passing without
  modification.

**External surfaces**: None. No new API endpoint, no new config field,
no new CLI command, no change to the tone-gate's public type contract
(`ToneReviewResult` shape unchanged). The new rule id is observable on
the `result.rule` string, which already carries B1..B14 ids today.

**Migration parity**:
- No agent-installed file change. The tone gate runs on the agent's
  server; existing agents pick up B15 the next time they update + the
  server restarts.
- CLAUDE.md template (`generateClaudeMd` and `migrateClaudeMd`) — not
  touched in this PR. The rule fires at message-send time regardless of
  what the agent reads at session-start; a future PR can add a one-line
  awareness note to the template, but it isn't load-bearing here (the
  point of the structural guard is that the agent doesn't need to
  remember).

**Rollback cost**: Trivial. Revert three files (Source edit + test +
spec triplet). The tone-gate behavior collapses to its pre-B15 state.

**Tests**: 9/9 new unit tests pass; 27/27 existing `MessagingToneGate`
tests still pass; 8/8 `messaging-tone-gate-health-alerts.test.ts` still
pass. `tsc --noEmit` clean. `npm run lint` clean.

**Decision-point inventory**:
1. LLM-gate rule (vs. regex hook) — chosen for the same reason the
   existing tone gate uses LLM judgment: literal patterns under-block
   on paraphrase and over-block on context (e.g., "we should pick this
   up later *after lunch*" is fine).
2. Single-iteration converge (vs. full 4-internal + 3-external) — the
   change is a single-rule extension to a well-defined existing
   authority with the operator-authored design intent in the topic-9984
   conversation; the full converge ceremony is calibrated for new
   subsystems. The rule is unit-testable in isolation and reversible
   trivially; if the operator wants the full ceremony for parity it
   can be a follow-up.
3. Drop "regex pre-filter" optimization — adding a regex pre-check
   before the LLM call would skip cheap-pass cases but introduces a
   second authority on the same decision, contradicting the gate's
   signal-vs-authority discipline. Rejected.
