# ELI16 — Track the `mergeStrategy` content-sniff in the Migration-Parity guard test

## What this change is, in plain English

PR #1191 (the MergeRunner auto-arm handoff) taught the updater how to **rewrite an
old copy** of the "Green-PR Auto-Merge" section that already lives in a deployed
agent's `CLAUDE.md`. It does that by looking for a small marker word —
`mergeStrategy` — that only exists in the *new* version of that section. If an
agent has the old section (it mentions `/green-pr-automerge`) but is missing the
`mergeStrategy` marker, the updater knows it's looking at a stale copy and swaps
in the fresh text. This is a standard "is this the old version? then replace it"
trick we use all over the migrator.

There is a **guard test** — `feature-delivery-completeness.test.ts` — whose job is
to make sure every `CLAUDE.md` section the updater can add is also written down in
a tracking list, so a section can never be silently shipped to agents without a
human-readable note explaining what it is. That guard works by scanning the
updater code for `content.includes('SOMETHING')` patterns and treating each
`SOMETHING` as the name of a section to account for.

The catch: the guard can't tell the difference between a *real new section name*
and a *re-detection marker for a section that's already tracked*. It saw
`mergeStrategy`, didn't find it in the tracking list, and went red — even though
`mergeStrategy` isn't a new section at all; it's just the marker the updater uses
to recognize the **already-tracked** Green-PR Auto-Merge section.

## What already exists

The Green-PR Auto-Merge section is already fully tracked in the guard's list (the
`/green-pr-automerge` entry). The pattern of "a re-detection marker that points at
an already-tracked section" is already established and tracked several times over —
`/cutover-readiness/import-dryrun`, `/corrections`, `unlabeledCallShare` are all
exactly this shape: a sub-line sniff key for a parent section that's tracked
elsewhere.

## What's new

One line added to the guard test's `legacyMigratorSections` list: `mergeStrategy`,
with a comment explaining it's the updated-copy re-detection marker for the
already-tracked Green-PR Auto-Merge section (no new capability, no template or
shadow-capability parity required — the parent section is dark, repo-gated, and
migrator-only).

## Safeguards, in plain terms

Nothing about runtime behavior changes. This is a test-only edit that makes a
guard test correctly recognize a marker it already should have recognized. The
guard still fails loudly for any genuinely-new untracked section. All 101 tests in
the file pass after the change.

## What you actually need to decide

Nothing — this is a mechanical CI-ratchet-satisfaction fix that unblocks #1191's
already-armed auto-merge. It ships under Tier 1 (test-only, low-risk).
