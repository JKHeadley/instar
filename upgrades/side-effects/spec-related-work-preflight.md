# Side-Effects Review — Related-work preflight

**Version / slug:** spec-related-work-preflight
**Date:** 2026-11-24
**Author:** Echo
**Second-pass reviewer:** Independent binding-scope and cross-model spec reviewers

## Summary of the change

The development workflow records which related projects, designs and pull requests it found, then checks the reviewed spec before stamping it and again on code commits that require approved convergence.

## Decision-point inventory

The writer adds a source record and reviewed-body check. The commit gate checks the same body in the Git index. The updater installs the built-in development tool and its reviewer prompts.

## 1. Over-block

An older spec can require another stamp before it drives a new qualifying implementation commit. Its historical stamp stays in Git history. A legitimate incomplete source can be recorded with its coverage and an authorized equivalent source.

## 2. Under-block

A reviewer can still miss relevant work or trust inaccurate authored evidence. The digest binds text, and reviewers challenge the underlying search. Existing lightweight exemptions remain.

## 3. Level-of-abstraction fit

The executable decision runs where convergence or implementation is accepted. Source search stays in the existing tools.

## 4. Signal vs authority compliance

The claim search and source records supply evidence. Reviewers judge overlap. The deterministic stamp and commit gates enforce only the agreed record and version contract.

## 4b. Judgment-point check

The reviewer decides search adequacy and reuse. The commit gate consumes existence and exact-body identity. There is no automated decision to rewrite or close a project.

## 5. Interactions

The draft body digest excludes leading frontmatter so adding the stamp or approval preserves it. A different body needs a fresh review and approval. The tracker reads the staged spec for each existing qualifying implementation commit.

## 6. External surfaces

The generator and checks make no external calls. No credential, project membership or delivery routing changes.

## 6b. Operator-surface quality

Errors identify the missing source or action without echoing restricted evidence. Review inputs carry only evidence suitable for their audience.

## 7. Multi-machine posture

Git carries the spec and digest. Each checkout independently validates its Git index. Private source evidence remains in its existing authority and is only linked through an authorized reference.

## 8. Rollback cost

A code revert restores the previous gate. Specs with related-work records remain readable. No runtime state needs migration.

## Conclusion

The two development acceptance checks require the same reviewed body. The remaining risk is evidence quality, addressed in the review prompts and approval process.

## Second-pass review

The independent reviewers challenged index consistency, stale review digests, migration and restricted evidence. The build applies those changes and preserves the agreed launch behavior.

## Evidence pointers

See stamp writer tests, the real pre-commit fixture and the existing installed migration test.

The installed-skill test also checks that a partial local reviewer edit survives the updater. The follow-up holds the related-work insertion when it finds unmatched experience-review markers.
