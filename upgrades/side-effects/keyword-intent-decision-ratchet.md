# Side-Effects Review — Keyword-Intent Decision Ratchet (report-mode)

**Version / slug:** `keyword-intent-decision-ratchet`
**Date:** `2026-07-03`
**Author:** `Echo (instar-dev)`
**Second-pass reviewer:** `not required`

## Summary of the change

Adds `tests/unit/keyword-intent-decision-ratchet.test.ts`, a bespoke vitest ratchet (sibling to `no-silent-fallbacks`) enforcing the constitutional standard "Intelligence Infers, Keywords Only Guard". It walks `src/{core,monitoring,server,threadline,messaging}`, detects the anti-pattern (a natural-language keyword/phrase/regex list tested against a message/conversation/text variable to DECIDE what a human meant), subtracts an explicit per-file allowlist reproduced from the 2026-07-03 audit, exempts declared safety floors carrying a new `@intent-safety-floor-ok` marker, and asserts the remaining offender count against a committed baseline of `6`. Ships in report mode (`ENFORCE = false`): it prints offenders but does not fail CI on a net-new violation. The only behavioral/in-scope file touched is `src/core/MessageSentinel.ts`, which receives a ~15-line comment adding the `@intent-safety-floor-ok` marker (no logic change). Supporting docs (design spec, audit, standard doc) ship alongside.

## Decision-point inventory

- `keyword-intent-decision detector (test-only)` — add — a static-analysis signature that flags files; it never runs at agent runtime and holds no runtime authority over any message.
- `MessageSentinel FAST_STOP/FAST_PAUSE fast-path` — pass-through — unchanged logic; only a documentation marker is added declaring it the standard's survivor #2 safety floor.

---

## 1. Over-block

**What legitimate inputs does this change reject that it shouldn't?**

None at runtime — this is a CI test, not a message gate. Its only "block" surface is failing CI. In report mode (`ENFORCE = false`) it cannot fail CI on a net-new violation at all; it only asserts the six known offenders are still detected (a detector-alive guard) and prints anything new. A CI-level over-block (flagging an innocent file) is prevented by the allowlist, which reproduces the audit's cleared set: enum validators, security scrubbers, error/process-message classifiers, structured-output parsers, cosmetic selectors, quantity extractors, and observe-only signal loggers. Verified on `JKHeadley/main`: the flagged-minus-allowlist set is exactly the six audit offenders — zero false positives.

---

## 2. Under-block

**What failure modes does this still miss?**

By design, it errs toward false negatives (the conservatism mandate — a noisy ratchet gets disabled). Known blind spots: (a) a NEW keyword-intent gate added INSIDE an already-allowlisted file is masked (the allowlist is keyed by file); each allowlist entry is documented by symbol so a reviewer can spot-check. (b) The detector's message-variable set is tight (`text|message|content|body|t|lower|normText|…`); a keyword gate written against an unusually-named variable would be missed. (c) Scope is the five source dirs only; `.instar/hooks/*` and other trees are out of scope (audit-cleared as agent-output). These are accepted per the standard's "miss a subtle one over flag an enum validator" guidance.

---

## 3. Level-of-abstraction fit

**Is this at the right layer?**

Yes — it is a build-time static-analysis ratchet (low-level, cheap, deterministic), which is exactly the right layer for "no code should string-match to decide intent." It does NOT attempt to be a runtime authority (that would itself violate the standard it enforces). It mirrors the proven `no-silent-fallbacks` ratchet's shape. The runtime conversions of the six offenders (to LLM-with-context) are separate follow-up work the ratchet's baseline tracks; this change only installs the guard.

---

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

**Does this change hold blocking authority with brittle logic?**

- [x] No — this change has no runtime block/allow surface. It is a CI test. Its detector is brittle-by-nature (regex signature) but holds NO authority over any user message or agent action; it only counts source-code patterns and, when enforcement is later enabled, gates the build against net-new regressions — the same authority every ratchet here holds. The MessageSentinel marker adds no logic.

[The ratchet is the enforcement arm of a standard whose whole point is that brittle keyword logic must not hold intent-decision authority. The ratchet itself scrupulously avoids doing so: it never inspects a live message, only source text.]

---

## 5. Interactions

**Does this interact with existing checks, recovery paths, or infrastructure?**

- **Shadowing:** Sibling to the `no-silent-fallbacks` ratchet and the "an LLM gate must not string-match" guard; complementary, no shadowing. Runs as an ordinary unit test in the vitest suite.
- **The `@intent-safety-floor-ok` marker** is new and independent of `@silent-fallback-ok` (different detector); no collision.
- **MessageSentinel:** the marker is a comment inside the file, above `FAST_STOP_PATTERNS`. It does not alter emergency-stop behavior, imports, or exports.
- **Migration parity:** none required — this touches no agent-installed files (`.claude/settings.json`, `.instar/config.json`, CLAUDE.md template, hook scripts, built-in skills). It is repo-internal test + docs.
- **CI:** adds one fast unit test (~3ms). No new dependencies (node `fs`/`path` only).

## 6. Rollback

Deleting `tests/unit/keyword-intent-decision-ratchet.test.ts` and reverting the MessageSentinel comment fully removes the change with no state or data implications. The report-mode flag (`ENFORCE = false`) means even a mis-tuned detector cannot block CI before the deliberate enforcement flip.
