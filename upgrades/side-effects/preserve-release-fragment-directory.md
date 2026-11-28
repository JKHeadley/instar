# Side-effects review for keeping release notes in place

**Date:** 2026-11-27
**Author:** Echo, verification and release throughput

**Second-pass reviewer:** Independent Codex reviewer, 2026-11-27

The publish workflow checks that a tracked non-Markdown file survives after it consumes its Markdown fragments. Repository Invariants reports Markdown files that appear at the upgrade root outside the existing guide, legacy NEXT, and ELI16 conventions.

## Decision points and authority

The existing CI invariants job remains the authority for repository layout. Its diagnostic names the misplaced path. The release workflow continues to consume only Markdown fragments, and the assembler skips the placeholder through its existing filename filter.

## Over-block and under-block

The root layout check accepts version guides, including prereleases, as well as NEXT.md and ELI16 companions. A future root Markdown kind would require an explicit invariant update. The check catches relocation to the root and does not infer that an edit to a versioned guide originally targeted a pending fragment. Review the prepared merge tree against current main before releasing a PR held for that case.

## Interactions and external surfaces

Publishing remains the only writer of a release guide. The placeholder is retained by the existing checkout and staging steps. CI reports a missing placeholder, and the publish step checks Git tracking and file presence before publishing. A checkout containing only the placeholder assembles no release notes. The change affects hosted CI and release preparation, with no agent configuration, client surface, or machine-local migration.

## Rollback

Revert the CI invariant and workflow changes if they block an established file convention. Keep the tracked placeholder unless intentionally rolling back directory preservation. No stored agent data needs repair.

## Evidence

The repository invariants accept the current tree and reject a temporary root Markdown probe. The assembler reports no fragments for a placeholder-only directory. In a disposable Git repository, publishing the sole preceding fragment and then merging a branch with a new fragment retained the new fragment under the pending directory.

## Second-pass review

**Reviewer:** Independent Codex reviewer queue_cap_review (release-fix follow-up).

The reviewer concurred against main 482a94b9 after checking the hosted and local publish paths, fragment assembly, and the existing upgrade-root names. The marker is unignored. Publishing removes only Markdown fragments and stages the marker with the upgrade directory. The reviewer confirmed the root lint is scoped to misplaced files and cannot detect a fragment edit that Git folds into an existing versioned guide. The review used static inspection and git diff --check.

The follow-up reviewer found two post-release and assembly fixtures that needed the newly required marker. They now represent the tracked layout. The test file also covers a missing marker and a stray root note.
