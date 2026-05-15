---
slug: token-burn-detection-phase-2
parent-spec: docs/specs/token-burn-detection-and-self-heal.md
review-convergence: "derived-from-umbrella"
review-iterations: 1
review-completed-at: "2026-05-15T20:25:00Z"
review-report: docs/specs/reports/token-burn-detection-and-self-heal-convergence.md
approved: true
approved-by: justin
approved-at: "2026-05-15T20:35:00Z"
approved-via: "Telegram topic 8615 — umbrella approval covers this phase"
eli16-overview: docs/specs/token-burn-detection-phase-2.eli16.md
---

# Token-Burn Detection — Phase 2 Spec

**Parent**: `docs/specs/token-burn-detection-and-self-heal.md` (umbrella, approved by Justin 2026-05-15).

Phase 2 of six. Implements the **read-side AttributionResolver** — a pure function that maps an existing TokenLedger event (with no chokepoint-written attribution) to a stable `attribution_key`. Phase 3 (BurnDetector) wires it; Phase 2 only builds the function plus the static manifest.

## Scope (Phase 2)

1. `src/monitoring/attribution-manifest.ts` — static mapping of known instar-internal LLM call patterns (InputDetector's bleed shape, MessagingToneGate, CommitmentSentinel, MessageSentinel, StallTriageNurse, CoherenceReviewer, ProjectDriftChecker, ResumeValidator, TopicLinkageHandler). Order-significant, first-match wins.
2. `src/monitoring/AttributionResolver.ts` — `resolveAttribution(event)` pure function:
    - Tries manifest-based prompt match first (the most informative signal for the bleed-detection case).
    - Falls back to cwd-based inference for scheduled jobs (`.instar/jobs/<name>`) and hooks (`.claude/hooks/<file>` and `.instar/hooks/<file>`).
    - Otherwise returns `unknown::<sessionId-prefix>` so a single misbehaving session shows up as one key.
3. 22 unit tests in `tests/unit/burn-detection-phase-2.test.ts` covering manifest hits, cwd-inference (Posix + Windows-style backslash paths), fallback shape, manifest integrity (uniqueness, non-empty components, every entry has a matcher).

## Out of scope

- **Wiring the resolver into TokenLedger ingest.** Phase 3 BurnDetector consumes the resolver on its read path; Phase 2 is the pure function only.
- **Backfilling existing rows.** Existing rows keep their `unknown::pre-attribution` default until Phase 3 resolves them on read.
- **User-prompt extraction from JSONL.** Phase 3 will pair user lines with their assistant counterparts; Phase 2's resolver simply accepts a `prompt` argument.

## Files touched

```
src/monitoring/attribution-manifest.ts                  (NEW — static manifest)
src/monitoring/AttributionResolver.ts                   (NEW — pure resolver)
tests/unit/burn-detection-phase-2.test.ts               (NEW — 22 tests)
docs/specs/token-burn-detection-phase-2.md              (this file)
docs/specs/token-burn-detection-phase-2.eli16.md        (NEW — Phase 2 ELI16)
upgrades/side-effects/token-burn-detection-phase-2.md   (NEW)
upgrades/NEXT.md                                        (release notes)
```

## Acceptance criteria (Phase 2)

1. `resolveAttribution({prompt: 'analyzing terminal output'})` returns `InputDetector::<8hex>` — the 2026-05-15 bleed shape.
2. Each of the nine manifest entries resolves to its component name on a representative prompt.
3. `cwd` containing `.instar/jobs/<name>` resolves to `user-job:<name>::<fp>`.
4. `cwd` containing `.claude/hooks/<file>` resolves to `user-hook:<file>::<fp>`.
5. Windows-style backslash paths resolve identically (regex covers `[/\\]`).
6. Empty / unknown event resolves to `unknown::<8-char-session-prefix>` (or `unknown::no-session` if sessionId is empty).
7. First-match-wins for ordered manifest entries.
8. Manifest integrity tests pass (uniqueness of component names, non-empty, every entry has a matcher).

## Rollback

The phase ships two pure modules with no I/O. Backout is a delete of both files plus the test file. No production caller depends on the resolver until Phase 3.
