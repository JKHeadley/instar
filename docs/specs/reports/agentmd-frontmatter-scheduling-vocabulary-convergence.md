# Convergence Report — Agentmd frontmatter scheduling vocabulary

**Spec:** `docs/specs/AGENTMD-FRONTMATTER-SCHEDULING-VOCABULARY-SPEC.md`
**Iterations:** 2 (round 1 = 3 parallel reviewers; round 2 = adversarial re-confirm of the corrected security narrative)
**Outcome:** CONVERGED. Fix direction (expand `ALLOWED_FRONTMATTER_KEYS`) unanimously endorsed.

## Round 1 verdicts

| Reviewer | Verdict | Headline |
|----------|---------|----------|
| Lessons-aware | APPROVE-WITH-CHANGES | Decision sound; tighten test to assert field values + dynamic count + closed-set regression |
| Integration | APPROVE | Pure accept-list widening in one file; no downstream scheduling value read from frontmatter; lock-file hashing unaffected; loader-only migration correct |
| Adversarial | APPROVE-WITH-CHANGES | Security *reasoning* factually wrong (`toolAllowlist` IS read from frontmatter); orphan mislabeled; add precedence + self-grant tests |

## Findings addressed

1. **Security narrative corrected (adversarial #1).** `resolveAllowlist` (JobScheduler.ts:1600-1601)
   reads `toolAllowlist` directly from frontmatter; the manifest carries `unrestrictedTools`,
   the `*`-gate. Neither alone escalates (clamps to `['Read']`). The original "frontmatter is
   authority only for name/description" claim was wrong and is replaced with the accurate
   two-key model. The 12 keys this spec *adds* remain decorative (manifest is their authority);
   `toolAllowlist` was already accepted and is unchanged. **Round-2 adversarial re-review: CONVERGED.**
2. **Test asserts VALUES, not just count (lessons #2, test-can-encode-the-bug).** E2E test now
   asserts every loaded `JobDefinition` has non-empty `schedule`, valid `priority`,
   `expectedDurationMinutes > 0` — not merely that loading didn't error.
3. **Dynamic count (lessons #3).** `installedCount` derived from the template dir read in-test,
   never hardcoded `18`.
4. **Closed-set regression-locked (lessons #4, adversarial #2).** A genuinely-unknown key still
   rejects — asserted, not assumed.
5. **Orphan mislabel fixed (adversarial #3).** `session-reaper-promotion-review.json` is a
   `manifest-invalid` (origin=custom), not `agentmd-frontmatter-invalid`. Out of code scope;
   swept as one-off Echo data cleanup so it stops emitting a per-boot warn.
6. **Precedence + self-grant tests added (adversarial #5a/#5b).** Manifest-wins-on-disagreement
   test; security regression test (frontmatter `unrestrictedTools` cannot self-grant).
7. **Code comment** documents the agent-behavior vs decorative-scheduling split + the
   8-derived-vs-3-forward-vocabulary distinction (lessons #1, integration minor).

## Standards conformance

- Testing Integrity: end-to-end gap-closer test is the assertion #425 missed. ✓
- Structure > Willpower: deliberate allowlist growth, closed-set guard preserved. ✓
- Signal vs authority: manifest remains the correctness authority; no new validation surface. ✓
- Migration parity: loader-only (shadow-install ships it); broken `.md` self-heal on next load. ✓
- Near-silent / no-manual-work: no user-facing surface; no manual steps. ✓
- Bug-fix evidence bar: live test-as-self (jobCount 0→18) required before "fixed". ✓
