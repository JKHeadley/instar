<!-- bump: patch -->

## What Changed

`src/commands/devClaimCheck.ts` reads GitHub by running `gh` and parsing its `--json` output —
textbook state detection under Rule 3 — but it entered `main` via #813 (2026-06-05) carrying
neither of the two things Rule 3 requires: an in-file Rule 3.1 rationale and a state-detector
registry row. Both are added here.

It survived because the pre-commit Rule 3 gate evaluates **staged** files only, so a file that
entered `main` without tripping the gate at its own commit time is never re-examined.

That is not a cosmetic gap. A merge stages everything, so anyone merging `main` into an older
branch is judged as the author of all of `main` and hits this refusal for a violation absent
from their own diff — a hard blocker on locally refreshing older open PRs. It blocked exactly
that work on 2026-07-28 and is the reason this was found at all.

The registry row is deliberately **🟡 Partial rather than 🔵 Exempt**, unlike the neighbouring
`gh --json` reads that are exempt on "versioned structured contract" reasoning. The difference
is the fallback. A thrown error (gh missing, auth, network) degrades loudly — the caller sets
`ghDegraded` and reports spec-scan-only. But empty stdout parses to `null`, and the caller's
`?? []` renders that as "zero PRs claim these files" with no degradation flag: a check that
could not run reading identically to one that ran clean. Narrow (`gh pr list --json` emits `[]`
on success, not empty) and advisory-only, so the blast radius is a false all-clear on a
pre-build hint — but it is named in both the rationale and the registry rather than papered
over, and the row flips to Exempt once that path degrades as loudly as the throw path.

Fixing the silent-empty path is a behaviour change and is tracked separately, not bundled into
a comment-only commit.

## What to Tell Your User

Nothing. No user-visible change, no new command, no behaviour difference in any conversation.
This is a documentation and registry fix to a contributor-facing CLI helper.

## Summary of New Capabilities

None. `instar dev:claim-check` behaves exactly as before — same flags, same output, same exit
codes. The only functional effect is that `main` stops failing its own Rule 3 gate, which
unblocks locally merging `main` into older branches.

## Evidence

- The violation was confirmed on `main`, not inferred: `grep -c "RULE 3"
  src/commands/devClaimCheck.ts` on `origin/main` returns 0, and the file is absent from the
  diff of the branch that hit the refusal.
- The refusal is reproducible, and so is the fix: the same staged change was **blocked** by the
  Rule 3 gate before the rationale comment, blocked again for the missing registry row after it,
  and **passed** once both halves were present. Each verdict was observed, not predicted.
- Comment-and-registry only — no statement, signature, export, or type is modified, so `tsc`
  emits identical JS.
- Side-effects review: `upgrades/side-effects/rule3-rationale-devclaimcheck.md`.
- ELI16: `upgrades/rule3-rationale-devclaimcheck.eli16.md`.
