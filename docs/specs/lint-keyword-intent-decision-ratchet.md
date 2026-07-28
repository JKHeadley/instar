# Spec (draft) — Lint/Ratchet: "No Keyword List Decides Meaning"

**Enforces:** the constitutional standard *Intelligence Infers, Keywords Only Guard*
(`docs/specs/standard-intelligence-infers-keywords-only-guard.md`). Sibling to the existing
`no-silent-fallbacks` ratchet and the "an LLM gate must not string-match" guard. Scoped by the audit
`docs/audits/keyword-intent-classification-audit-2026-07-03.md`.

## What it catches (the anti-pattern signature)
A keyword/phrase/regex **list of natural-language words** matched against a **message/conversation/user-text**
variable to **make a decision** (classify intent, gate/reroute/swallow a message). Concretely, in
`src/core`, `src/monitoring`, `src/server`, `src/threadline`, `src/messaging`:
- A `const X = ['word','word',...]` (or a set of anchored NL regexes) whose members are natural-language
  words/phrases (not identifiers, paths, enum tokens), that is then tested via
  `.includes(` / `.test(` / `.match(` / `.some(` against a variable named/derived from
  `text|message|msg|content|body|prompt|turn|conversation|lower(...)`.

## What it must NOT flag (the two survivors + the cleared classes)
1. **Fixed-enum validators** — arrays that validate an already-structured value against a closed set
   (`THINKING_MODES`, `EFFORT_LEVELS`, `ISSUE_SEVERITIES`, tier/severity/status enums). Heuristic: the
   list is compared for MEMBERSHIP of a whole token/field value, not scanned within free prose.
2. **Declared LLM-backed safety floors** — a deterministic first-strike (emergency-stop `^stop`) that is
   explicitly annotated as a safety floor AND has an LLM stage behind it. Requires an inline
   `@intent-safety-floor-ok` marker (new, mirroring `@silent-fallback-ok`) naming the LLM backstop.
3. **Structured-output enums** — a list used as the ALLOWED SET the model must emit into (the correct
   pattern); recognizable because the list feeds a schema/enum passed to the IntelligenceProvider, not a
   `.includes` over model prose.
4. **Cleared non-intent classes** (from the audit): process/tmux-output signature matchers, security
   scrubbers/redactors, structured command/path validators, and hook scripts that scan the AGENT's own
   output. Maintain an explicit allowlist keyed by file+symbol from the audit so these don't regress into
   noise.

## Mechanism (ratchet, like no-silent-fallbacks)
- A unit test (`tests/unit/keyword-intent-decision-ratchet.test.ts`) walks the target dirs, applies the
  signature detector, subtracts the allowlist, and asserts the count ≤ a committed baseline.
- **Baseline = the 6 audit findings** (3 live + 3 latent) MINUS whatever is fixed by the time it lands
  (the move-recognizer exemplar removes #2). The number can only DECREASE. A new violation fails CI.
- Each remaining known offender carries a `// TODO(keyword-intent): convert to LLM-with-context — CMT-N`
  marker so the ratchet's remaining set is self-documenting (Close the Loop).
- Detector conservatism: err toward FALSE NEGATIVES (miss a subtle one) over FALSE POSITIVES (flag an
  enum validator) — a noisy ratchet gets disabled. Pair with the audit allowlist so the initial run is
  clean-by-construction.

## Rollout
Ship report-mode first (prints the offender set, does not fail CI) for one cycle to confirm zero false
positives against the allowlist, then flip to failing. Same graduated discipline as other ratchets.

### Flip to ENFORCE + latent-offender resolution — 2026-07-04 (CMT-1907)
The soak cycle passed (the lint merged 2026-07-03; many PRs landed since with the detector
clean-by-construction and zero false positives). Two things happened in this change:

1. **`ENFORCE = false → true`** — the `<= BASELINE` guard is now HARD. No net-new keyword-intent
   offender can merge; a new offender in the five scanned dirs fails CI until it is converted to
   LLM-with-context or justified as an allowlisted survivor. This is the standard's enforcement teeth.
   Rollback lever: set `ENFORCE = false` (back to report-only) — no code path outside the test changes.

2. **The three LATENT offenders resolved, `BASELINE 4 → 1`:**
   - **`core/TopicClassifier.ts` (#4, `scoreKeywords`)** — verified genuinely DEAD: zero runtime importers
     across `src/` (no static import, no dynamic `import()`, no registry/dynamic reference, no
     function-name import); the sole consumer was a test-only e2e block. **REMOVED** (module + its
     `discovery-round2-final.test.ts` describe block). A keyword classifier nothing calls is dead weight —
     deleted, not converted.
   - **`core/AutonomySkill.ts` (#5, `INTENT_PATTERNS`)** — verified unwired: only a barrel re-export in
     `src/index.ts` plus its own unit test; no `new AutonomySkill` anywhere in `src/`. **REMOVED** (module +
     barrel export + unit test).
   - **`core/AgentReadinessScorer.ts` (#6, `scoreText`)** — a legitimate **SURVIVOR**: it scores a TASK'S
     coordination-vs-judgment NATURE for the advisory `/agent-readiness` endpoint (`COORDINATION_SIGNALS` /
     `JUDGMENT_SIGNALS` density), NOT "what a human MEANT by a message." It never gates/reroutes/swallows a
     user message. **Moved to the `ALLOWLIST`** (cleared class), not removed or converted.

   Only `#1 topicProfileIngress` (`parseProfileTrigger`) remains the sole baseline offender; its LLM
   conversion lands separately. `EXPECTED_OFFENDERS` and the detector-alive guard are kept consistent with
   `BASELINE = 1`.

## Open questions (resolved at implementation)
1. Detector as a bespoke AST/regex walker vs an eslint custom rule — **RESOLVED: bespoke Node/vitest
   test**, mirroring `no-silent-fallbacks`. eslint is not wired for custom rules here, and the house style
   is a self-contained vitest ratchet. The detector is a two-part regex signature (named NL-intent list +
   a message-like decision test; and an inline NL-phrase regex tested against message text), not an AST
   walker — deliberately, per the conservatism mandate (a coarser signature that errs toward false
   negatives, paired with the audit allowlist, over a precise walker that risks flagging enum validators).
2. Extend scope to `.instar/hooks/instar/*` NL hooks — **RESOLVED: out of scope.** The audit cleared them
   as operating on the agent's own Stop-hook output / tool calls, not user-message intent. The ratchet
   scans only the five source dirs (`src/core`, `src/monitoring`, `src/server`, `src/threadline`,
   `src/messaging`).

## Implementation
`tests/unit/keyword-intent-decision-ratchet.test.ts` (this ratchet). Baseline `6` (per file), the audit's
six offenders; the number only decreases. Ships in **report mode** (`ENFORCE = false`) — it prints the
offender set every run but never fails CI on a net-new violation; flip `ENFORCE = true` after a clean soak
to make the `<= BASELINE` guard hard. The declared safety floor (`MessageSentinel`) is exempted via a new
inline `@intent-safety-floor-ok` marker (mirroring `@silent-fallback-ok`); the audit's cleared classes are
subtracted via an explicit per-file `ALLOWLIST` documented by symbol. Verified clean-by-construction on
`JKHeadley/main`: exactly the six offenders remain, zero false positives on the enum validators / security
scrubbers / process-and-error matchers / structured-output parsers.

**Update 2026-07-04 (CMT-1907):** `ENFORCE` is now `true` and `BASELINE` is `1` — see the *Flip to ENFORCE*
subsection under Rollout. Three original offenders (2 removed as dead code, 1 allowlisted as a task-nature
survivor) were resolved; only `topicProfileIngress` remains.
