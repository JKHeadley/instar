# Side-effects review — causalAutopsy field in the instar-dev gate

## What changes

scripts/instar-dev-precommit.js: (1) Step 4.55 validates an OPTIONAL
`causalAutopsy` field in the trace JSON (origin enum prior-pr |
environment-shift | new-code | latent | unknown; relatedPrs required for
prior-pr; validated-when-present); (2) the field is copied verbatim into the
per-commit decision-audit entry (null when absent); (3) a fix-class commit
(branch name or staged release fragment says fix) with NO autopsy gets an
ADVISORY stderr warning — never a block.

## Over-block surface (the risk direction for a gate change)

The ONLY new block is a PRESENT-but-malformed autopsy — a deliberate choice:
a corrupt record poisons the meta-analysis dataset, so it is rejected with the
exact shape printed. Absence NEVER blocks (pinned by test). Commits with no
trace, non-fix commits, Tier-2 flows: behavior unchanged. The blocked attempt
is recorded with verdict 'blocked' via the existing exit handler — the
riding-the-retry design is untouched.

## Advisory noise

The warning fires only on a fix-class signal: branch segment matching fix, or
a staged upgrades/next fragment containing change_type: fix. A non-fix Tier-1
commit with no autopsy prints NOTHING (pinned by test). Both detection probes
are wrapped in try/catch — a detached HEAD or unreadable fragment silently
skips the advisory rather than erroring the gate.

## Audit-entry compatibility

Entries gain one key (causalAutopsy: object|null). Existing consumers read
named keys from these JSON files; an additional key is inert. Parallel-PR
conflict immunity (per-entry files, #80) and verdict finalization (#844) are
unchanged — the new field is written before the exit handler finalizes, so
both the working-tree and staged copies carry it.

## Blast radius

One script, additive. No src/ change, no API, no config, no migration: the
gate ships inside the repo and every fresh worktree gets it from main on
branch. Slice 2 (hard-require for fix-class + a report command) is a separate
decision after the field earns trust and Justin shapes the policy.
