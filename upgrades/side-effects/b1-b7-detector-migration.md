# Side-Effects Review — B1–B7 detector-emits-signal migration (CMT-1793, §Design 8)

**Version / slug:** `b1-b7-detector-migration`
**Date:** `2026-06-25`
**Author:** `Instar Agent (echo)`
**Second-pass reviewer:** `general-purpose reviewer subagent (Phase 5 — touches the outbound tone gate)`

## Summary of the change

Phase 2 of `gate-prompts-judge-by-meaning-not-literal-lists` (§Design 8). Migrates tone-gate rules B1–B7 from in-prompt literal-matching to the deterministic-detector-emits-signal contract: a new pure module `src/core/GateSignalDetectors.ts` runs seven high-precision detectors (cli-command, file-path, config-key, copy-paste-code, api-endpoint, env-var, cron-or-slug) over the candidate and emits a normalized, sanitized `GateSignal` list; `MessagingToneGate.buildPrompt` renders that list inside its OWN per-call random boundary (distinct from the candidate boundary, untrusted-data framed); the B1–B7 prompt rules are reworded to judge each detected artifact IN CONTEXT (shown-to-act-on → block; mentioned-in-passing → pass) instead of self-scanning; `RULE_CLASSES` B1–B7 flip `deterministic-detection`→`signal-driven`; `PHASE2_MIGRATION_DEBT` is drained to empty; the ratchet (`tests/unit/gate-prompts-judge-by-meaning.test.ts`) inverts to assert the migration landed (B1–B7 signal-driven, allowlist empty, no rule still `deterministic-detection`).

## Decision-point inventory

- `MessagingToneGate` B1–B7 block/allow — **modify** — the JUDGMENT moves from in-prompt string-match to LLM-judges-a-deterministic-signal-in-context (Signal-vs-Authority applied to the gate's own prompt).
- `GateSignalDetectors.detectGateSignals` — **add** — pure signal producer; NEVER blocks (signal, not authority).

## 1. Over-block

A detector firing only ADDS a signal the LLM then judges; it is not itself a block. The detectors are high-precision (anchored to artifact shapes, not loose prose — e.g. B1 requires a real CLI leader, B3 requires 3+ dotted segments) so prose like "I'll run the migration" or "and/or" does not fire (unit-tested). Residual over-block risk: a candidate that legitimately quotes a path/command while explaining — but the prompt explicitly instructs pass for mentioned/in-passing artifacts, and B1–B7 severity is not the false-negative-favoring class B15 is. Net over-block is LOWER than the prior in-prompt literal-match (which had no contextual carve-out beyond prose hints).

## 2. Under-block

A detector that misses an artifact form yields no signal → that rule falls back to no-block for that candidate (the LLM is told not to self-scan). This is the deliberate trade of §Design 8: deterministic detection is auditable + improvable, vs an LLM literal-scan that was itself brittle. New artifact forms are added to the detector (one place), not re-litigated in the prompt. The detectors are intentionally conservative; a missed exotic form is the safe direction here (B1–B7 are leak-hygiene, not safety-critical gates — the deterministic safety FLOORS, dangerous-command-guard etc., are unchanged).

## 3. Level-of-abstraction fit

Correct. This is the §Design 8 contract realized: pattern-matching is the deterministic layer's job (the detector module), fed to the LLM as a signal; the LLM does the contextual judgment. It mirrors the EXISTING B8/B9/B12/B20 signal-driven pattern (and the pre-existing `signals.filePath` anchor for B2, which now corroborates the unified signal). The detectors live in their own module (like `JargonDetector.ts`), pure + independently testable.

## 4. Signal vs authority compliance

- [x] No — the new code produces a SIGNAL consumed by the existing smart gate (the LLM). `detectGateSignals` has no block authority; the `MessagingToneGate` LLM remains the single authority. This is the textbook Signal-vs-Authority shape and is exactly what the new "An LLM Gate Must Not String-Match" standard mandates. The migration REMOVES brittle in-prompt literal-gating.

## 5. Interactions

- **Shadowing:** the new ARTIFACT-SIGNALS prompt section is additive; it sits beside the existing UPSTREAM SIGNALS section. The pre-existing `signals.filePath` B2 anchor still renders — both now corroborate B2 (no conflict; both point the same way).
- **Double-fire:** none — the detector runs once per `buildPrompt`; the gate makes one decision.
- **Races:** none — pure synchronous function on the candidate string; no shared state.
- **Boundary safety:** the signal list has its OWN per-call random boundary; `normalizedValue` is length-clamped + JSON-encoded inside it and framed as untrusted data, so an attacker-derived "path" cannot break the envelope (unit-tested clamping).

## 6. External surfaces

- Prompt content changes (B1–B7 rules reworded; a new signals section). No new HTTP route, config key, or persistent state. The verdict is still channel-independent (computed pre-adapter from text). No operator-facing action added → Mobile-Complete N/A.

## 6b. Operator-surface quality

No operator surface touched (no dashboard/approval/grant file). Not applicable.

## 7. Multi-machine posture

**REPLICATED / uniform by construction.** The detectors + prompt are rebuilt from source each review; the module is stateless; the ratchet ships compiled. Identical across machines, converging as each updates. No machine-local state affects the verdict. No user-facing notice, no durable state, no generated URL.

## 8. Rollback cost

Pure code change. Back-out = `git revert` the commit — B1–B7 return to the prior in-prompt literal-match (the reverted ratchet assertions go with it). No data migration, no persistent state, no user-visible regression window.

## Tracked sub-scope (no orphan deferrals)

The spec named two SECONDARY sub-scopes for CMT-1793 as "folded in OR a noted sub-gap": pi-cli gate-awareness shadow note, and richer agent-state signals (context-window % + turn/action-count plumbing for B15). The substantive B1–B7 migration ships here; the two secondary items are tracked under **CMT-1800** (a real, open commitment), not dropped. <!-- tracked: CMT-1800 -->

## Conclusion

The review produced no design changes. The migration realizes §Design 8 exactly, removes the last in-prompt literal-gating (B1–B7), and is Signal-vs-Authority + No-Silent-Degradation compliant. Clear to ship pending second-pass concurrence.

## Second-pass review (if required)

**Reviewer:** general-purpose reviewer subagent
**Independent read of the artifact: concur (with one non-blocking concern, now ADDRESSED)**

The reviewer independently verified and PASSED: Signal-vs-Authority (the detector holds zero block authority; pure signal producer; removing in-prompt literal-gating), the §Design 8 envelope/clamping security (confirmed empirically that an attacker-derived `normalizedValue` containing `<<<SIG_BOUNDARY_…>>>`/newlines/injected instructions is neutralized — `JSON.stringify` collapses it to one quoted line and the real boundary is an unpredictable per-call `randomBytes(8)` token), the ratchet inversion (correctly inverted, not weakened — B1–B7 are now genuinely scanned for necessary-literal-gate constructions; the standard is ENFORCED on them, not exempted), and ReDoS (all seven regexes linear-time on 50KB adversarial inputs).

**Concern (non-blocking, now fixed):** B3/B7 detector precision — `config-key` fired on hostnames (`www.example.com`) and `cron-or-slug` on plain hyphenated English (`well-thought-out`, `state-of-the-art`). Signal-only, so it could never block, but it diluted the signal list. FIXED in this PR: B3 drops hostname-shaped matches (leading `www.` or a known-TLD tail without a camelCase segment); B7's lowercase-kebab branch now requires a DIGIT (so adjectival hyphenation and digit-less slugs don't fire — a digit-less internal slug leaked to a user is caught by the separate B20 internal-id-leak signal). Prose-negative tests added (`well-thought-out`, `state-of-the-art`, `www.example.com`, `docs.instar.sh`) to lock the precision. 19 detector tests + 8 ratchet tests green after the tuning.

## Evidence pointers

- `tests/unit/GateSignalDetectors.test.ts` — 17 tests: detection precision both-sides (artifacts fire; prose doesn't) + security clamping (closed kind enum, confidence [0,1], bounded spans, length-clamped normalizedValue).
- `tests/unit/gate-prompts-judge-by-meaning.test.ts` — the ratchet, inverted: B1–B7 signal-driven, `PHASE2_MIGRATION_DEBT` empty, no `deterministic-detection` rule remains, B1–B7 prompt blocks reference their signal.
- Regression: b15/b16/b17 integration + MessagingToneGate + spawn-cap + post-update + attention + feature-delivery — all green (123 + 63 tests across the runs). `npm run build` + `tsc --noEmit` clean.
