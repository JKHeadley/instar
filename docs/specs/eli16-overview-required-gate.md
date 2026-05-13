---
title: "ELI16 overview required for every approved spec"
slug: "eli16-overview-required-gate"
author: "echo"
status: "approved"
review-convergence: "2026-05-13T00:00:00Z"
review-iterations: 1
approved: true
---

# ELI16 overview required for every approved spec

## Problem statement

When a converged spec is handed to the user for approval (or to anyone else who has to make a real decision against it), the technical spec on its own is unreadable as a first-pass artifact. A 400-line spec with 17 amendments encodes the constraints precisely, but a user has to drill into it to even tell whether the *shape* of the proposed design is right.

This happened explicitly in topic 3079 on 2026-05-13: Echo delivered a round-1-amended self-healing-remediator spec and received the reply "I can't digest this without an ELI16 overview. That should be required for every spec."

The pain is structural, not author-discipline. The user explicitly asked for the gate ("That should be required for every spec"), and reiterated it should be an instar feature, not echo-local config.

## Proposed design

A pair of structural gates that refuse to advance a spec without a plain-English ELI16 companion:

1. **Convergence-time gate** (in `skills/spec-converge/scripts/write-convergence-tag.mjs`). Refuses to stamp the `review-convergence` tag onto the spec frontmatter unless an ELI16 sibling exists and is non-stub.
2. **Commit-time gate** (in `scripts/instar-dev-precommit.js`). Refuses any `/instar-dev` commit whose spec lacks an ELI16 sibling. This is the structural backstop — even a hand-tagged spec without convergence cannot bypass it.

Both gates resolve the ELI16 path the same way:

- Default sibling: `<spec-dir>/<spec-basename>.eli16.md` (e.g., `docs/specs/foo.md` → `docs/specs/foo.eli16.md`).
- Explicit override: spec frontmatter may declare `eli16-overview: <relative-path>` to point elsewhere.

Both gates require the ELI16 file to be at least 800 chars of real content (roughly 4-5 short paragraphs). A stub is not an overview.

### ELI16 template

A new template lives at `skills/instar-dev/templates/eli16-overview.md` with the expected shape:

1. The one-paragraph version (the entire decision in one breath).
2. The problem in plain English.
3. What already exists vs. what this adds.
4. The new pieces.
5. The safeguards in plain terms.
6. What ships when.
7. What the reader actually needs to decide.

### Documentation updates

- `skills/instar-dev/SKILL.md` — Phase 0 (Spec prerequisite) gains "the spec must have an ELI16 companion" as a verifiable structural check.
- `skills/spec-converge/SKILL.md` — Phase 5 (convergence) lists the ELI16 sibling as a required output, not an optional artifact.

## Decision points touched

This change adds **blocking authority** with **structural logic** (file existence + min-length check) — exactly the shape signal-vs-authority allows. It does not depend on LLM judgment, ToneGate verdicts, or any runtime detector. The check is purely file-existence + content-length, both deterministic and verifiable.

The block is at the gate (pre-commit / pre-convergence-tag), not at a runtime decision point. This is consistent with the existing review-convergence + approved tag enforcement, which is the same shape of gate (frontmatter check, deterministic, structural).

## Open questions

None blocking. Forward-only enforcement: only specs newly converged or newly committed-against after this gate ships are subject to the check. Existing approved specs whose work has already shipped are not retroactively affected (they're not being committed against again).

## Rollback path

If the gate turns out wrong (e.g., over-blocks on legitimate small specs), the rollback is a single-line revert of the check block in `instar-dev-precommit.js` and `write-convergence-tag.mjs`. No data migration. The next release picks up the revert automatically. The check is structurally additive — disabling it does not affect any other gate.

## Test strategy

- Unit test: `tests/unit/instar-dev-precommit-eli16.test.ts` — exercises pass (with ELI16 sibling), pass (with frontmatter override), block (missing ELI16), block (stub-length ELI16), block (frontmatter override points at non-existent file).
- Unit test: `tests/unit/spec-converge-eli16-required.test.ts` — exercises `write-convergence-tag.mjs` refusing to tag a spec without ELI16, succeeding when present.
- Self-test: this PR's own spec (`eli16-overview-required-gate.md`) ships with its own ELI16 sibling (`eli16-overview-required-gate.eli16.md`). The pre-commit hook on this PR is the first real-world exercise of the gate.
