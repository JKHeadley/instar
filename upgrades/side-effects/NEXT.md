# Side-effects review — validator: tighten FIX_PATTERNS to reduce false positives

**Scope**: Three `FIX_PATTERNS` in `upgrade-guide-validator.mjs` were matching
technical prose that was not claiming a bug fix, causing the publish CI to
block with a false "no Evidence section" error on the Phase 1b connect-the-dots
release (NEXT.md v0.28.96).

**Root cause**: The NEXT.md for the Phase 1b connect-the-dots release used
three words in technical contexts that the validator treated as bug-fix claims:
- `broken` — "while a child is broken" (describes a runtime state, not a defect
  we fixed)
- `crashed` — "a crashed runner" (adjective, describes a process that exited
  non-zero, not a crash we fixed)
- `resolve` — "items resolve" and `resolve-conflict` (validation-check language
  and API action-verb name, not "I fixed an issue")

**Files touched**:
- `scripts/upgrade-guide-validator.mjs` — three pattern changes:
  1. `/\bcrashed\b/i` removed. `crashes?` and `crashing` (verb forms) are kept.
  2. `/\bbroken\b/i` tightened to `/\b(?:was|were)\s+broken\b/i` — only the
     predicate form ("X was broken") triggers; attributive uses ("a broken
     pipeline") and present-state descriptions ("is broken") do not.
  3. `/\bresolves?\b/i` tightened to `/\bresolves?\s+(?:an?\b|the\b)/i` — only
     "resolves a/an/the <defect>" triggers; bare "resolve" as a technical verb
     ("items resolve") and hyphenated action verbs ("resolve-conflict") do not.
- `tests/unit/upgrade-guide-evidence.test.ts` — three regression tests added,
  one per false-positive pattern.

**Under-block**: Three narrow edge cases are no longer caught:

1. `crashed` standalone past tense: "the server crashed when X" without also
   containing "fix" or another trigger. In practice any guide describing a crash
   fix would also say "fixed a crash" or "fixes the crash" — caught by the
   existing `\bfix(es|ed|ing)?\b` pattern. Removal of `crashed` alone is
   low-risk.

2. `broken` as attributive adjective or present state: "fixed the broken poller"
   still triggers because "fixed" catches it. "X is broken (and we fixed it)"
   would also need "fixed" or another trigger — acceptable.

3. `resolves` without article: "Resolves race condition" (unusual English, almost
   always "Resolves the/a race condition"). The tightened pattern retains all
   natural phrasing.

**Over-block**: None introduced. The change makes the validator more permissive.
Historical guide warnings decrease slightly.

**Level-of-abstraction fit**: `claimsFix` is a pure heuristic signal. The gate
(`validateGuideContent` requiring Evidence) is the authority. These changes stay
entirely within the signal layer. Evidence requirement, Evidence validation, and
all structural checks are unchanged.

**Signal vs authority**: Compliant. Tightened patterns are still signals; blocking
authority remains in the Evidence-section check. No new blocking authority.

**Interactions**: `claimsFix` is called only from `validateGuideContent`, called
by `check-upgrade-guide.js` (CI publish gate) and the test suite. No other
callers. Historical guide warnings decrease slightly — correct noise reduction.

**External surfaces**: None. `claimsFix`/`evidenceIssues` are not part of the
public npm package surface. No API, config, or CLI change.

**Rollback cost**: Trivial. 7 lines changed in validator, 18 lines added to test.
Revert brings back the over-broad patterns.

**Tests**: 24/24 unit tests pass in `upgrade-guide-evidence.test.ts` (3 new +
21 prior). 1294/1294 tests pass across all three upgrade-guide test files.
`check-upgrade-guide.js` passes against the previously-blocking NEXT.md.
