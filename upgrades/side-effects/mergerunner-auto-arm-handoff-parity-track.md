# Side-Effects Review — Track `mergeStrategy` in Migration-Parity guard test

**Change:** Add `mergeStrategy` to `legacyMigratorSections` in
`tests/unit/feature-delivery-completeness.test.ts`. Test-only. Tier 1.

**Context:** PR #1191's `PostUpdateMigrator.migrateClaudeMd` uses
`else if (!content.includes('mergeStrategy'))` as the updated-copy content-sniff to
detect+replace a STALE copy of the already-tracked "Green-PR Auto-Merge" section.
The parity guard's section-detector treats every `content.includes('X')` literal as
a section name and flagged `mergeStrategy` as untracked. The fix records it as the
re-detection marker for the already-tracked `/green-pr-automerge` section.

## Phase 1 — Principle check (signal vs authority)

Does this change involve a decision point that gates information flow, blocks
actions, filters messages, or constrains agent behavior? **No.** It is a one-line
addition to a test's allowlist of known migrator section markers. It adds no
runtime logic, no detector, no authority. The guard test it touches is itself a
signal (it fails CI; it never blocks runtime behavior). No signal-vs-authority
concern.

## Phase 4 — Side-effects answers

1. **Over-block** — None. The guard now correctly recognizes one more legitimate
   marker. It does NOT loosen the guard generally: any genuinely-new section name
   still trips it. Over-blocking would be the guard staying red on a legitimate
   marker — which is the bug being fixed.
2. **Under-block** — Could adding `mergeStrategy` mask a future real section that
   happened to also contain that literal? Negligible: the detector matches the
   exact literal inside a `content.includes('mergeStrategy')` guard in the
   migrator; `mergeStrategy` is a specific marker for one section. A future
   unrelated section would carry its own distinct sniff literal.
3. **Level-of-abstraction fit** — Correct layer. The tracking list is exactly where
   the established pattern (`/corrections`, `/cutover-readiness/import-dryrun`,
   `unlabeledCallShare`) records sub-line / re-detection sniff keys for parent
   sections that are tracked elsewhere. This entry is identical in kind.
4. **Signal vs authority compliance** — Compliant. No blocking authority added;
   the test is a CI signal, not a runtime gate.
5. **Interactions** — None. The entry sits alongside the existing
   `/green-pr-automerge` tracking entry; it doesn't shadow or double-count it (the
   detector lists each distinct literal once; both are accounted for).
6. **External surfaces** — None. Test-only; no runtime, route, message, or
   cross-agent surface changes.
7. **Multi-machine posture** — N/A (test-only, machine-agnostic). The parent
   feature's own multi-machine posture was reviewed in
   `mergerunner-auto-arm-handoff.md`; this fix changes nothing about it.
8. **Rollback cost** — Trivial. Revert the one-line test addition. No release, no
   migration, no state repair. The parent PR's runtime behavior is untouched
   either way.

## Phase 4.5 — No deferrals

This fix is complete; nothing is deferred. It is the entirety of the parity-guard
correction for #1191.

## Phase 5 — Second-pass review

Not required: the change carries no block/allow authority, no session-lifecycle,
coherence, idempotency, or runtime-gate surface. It is a test-tracking-list
addition.
