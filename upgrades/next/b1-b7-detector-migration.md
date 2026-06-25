<!-- bump: patch -->

## What Changed

Phase 2 of the judge-by-meaning tone-gate work (the §Design 8 detector contract). Tone-gate rules B1–B7 (cli-command, file-path, config-key, copy-paste-code, api-endpoint, env-var, cron-or-slug) are migrated from in-prompt literal-matching to the deterministic-detector-emits-signal contract:

- New pure module `src/core/GateSignalDetectors.ts` — seven high-precision detectors emit a normalized, sanitized `GateSignal { kind, detected, spans?, normalizedValue?, confidence? }`. Security per §Design 8: closed `kind` enum (out-of-enum rejected), `confidence` clamped [0,1], `spans` bounded to the candidate length + count-capped, `normalizedValue` length-clamped; rendered inside its OWN per-call random boundary as untrusted data (JSON-encoded, so an attacker-derived value can't break the envelope).
- `MessagingToneGate.buildPrompt` runs the detectors on the candidate and renders the signal list; the B1–B7 prompt rules are reworded to judge each detected artifact IN CONTEXT (shown-to-act-on → block; mentioned-in-passing → pass) instead of self-scanning. This removes the LAST in-prompt literal-gating, completing the "An LLM Gate Must Not String-Match" standard for the behavioral + artifact rules.
- `RULE_CLASSES` B1–B7 flip `deterministic-detection`→`signal-driven`; the legacy class is retired; `PHASE2_MIGRATION_DEBT` is drained to empty. The CI ratchet (`tests/unit/gate-prompts-judge-by-meaning.test.ts`) is inverted to assert the migration landed (B1–B7 signal-driven, allowlist empty, no rule still `deterministic-detection`, and B1–B7 are now scanned for necessary-literal-gate constructions like every other judgment rule).

Two spec-acknowledged secondary sub-scopes (pi-cli gate-awareness shadow note + richer agent-state signals: context-window % / turn-count plumbing for B15) are tracked under CMT-1800, not bundled here. <!-- tracked: CMT-1800 -->

## What to Tell Your User

Nothing you need to do. Under the hood, the safety check that screens your agent's outbound messages for leaked internals (raw shell commands, file paths, config keys, URLs, env vars, internal ids) got smarter: instead of the language model eyeballing the text for those patterns itself (which a slightly-different format could slip past), a precise deterministic detector finds them and hands the model an exact, in-context note, and the model decides whether the artifact is actually being handed to you to act on (worth blocking) or just mentioned in passing (fine). Net effect: fewer leaks slip through AND fewer false alarms on harmless mentions. Message behavior is otherwise unchanged.

## Summary of New Capabilities

- `GateSignalDetectors` — a deterministic detector layer for the tone gate's artifact rules (B1–B7): it finds leaked CLI commands, file paths, config keys, code, API endpoints, env vars, and cron/slug ids and emits a sanitized, bounded signal the gate's model judges in context. The model no longer string-matches these patterns in its own prompt — completing the "an LLM gate must not string-match" standard across the gate's rule set.

## Evidence

- `tests/unit/GateSignalDetectors.test.ts` — 19 tests: detection precision both-sides (artifacts fire; prose, hostnames, and digit-less hyphenation do NOT) + security clamping (enum rejection, confidence [0,1], bounded spans, length-clamped normalizedValue).
- `tests/unit/gate-prompts-judge-by-meaning.test.ts` — the ratchet, inverted to lock the migration.
- Regression: b15/b16/b17 integration + MessagingToneGate + spawn-cap + post-update + attention + feature-delivery — all green. `npm run build` + `tsc --noEmit` clean.
- Independent second-pass review: concur (Signal-vs-Authority, §Design 8 envelope security, ratchet integrity, ReDoS all PASS); one non-blocking B3/B7 precision concern raised and fixed in-PR with prose-negative tests.
