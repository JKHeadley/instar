<!-- bump: patch -->

## What Changed

The two clean-up sweeps (old promises, old self-improvement to-dos) now write
down exactly which records they would close, in
`logs/commitments-auto-expiry.jsonl` and
`logs/evolution-actions-auto-expiry.jsonl`. Before, they printed only a total, so
nobody could review them before switching practice mode off. The promise sweep
now leaves alone promises waiting on someone else or on you, counts a recent
dependency check as activity, skips another machine's promises, and no longer
labels an old promise "presumed completed": it quotes the reason it was created
without a follow-up, or says the outcome is unknown. The to-do sweep now keeps
high-priority items and items only recently overdue. Both sweeps stay in
practice mode by default.

## What to Tell Your User

Nothing changes in what gets closed by default; both clean-up sweeps are still
in practice mode. If you want to know what they would close, I can now show you
the exact list instead of a count.

## Summary of New Capabilities

- A durable, reviewable list of what each auto-expiry sweep would close.
- Honest closing notes for auto-expired promises (no "presumed completed").

## Evidence

Measured on a live agent before the change: 412 of 1119 promises and 44 of 300
to-dos were counted as eligible with no record of which. Unit, integration and
e2e tests cover the new rules and the ledger rows (full, unchanged, emptied,
applied).
