# Job-completion audit: jobs claim their effects, the audit verifies the claim

## What Changed

The audit's deterministic column was inert on every row (363/363 on the
originating agent, 2026-09-23) because no job declared an effect, and the
enabled jobs could not honestly declare an *unconditional* one — they write
only when they have something to write.

New `conditionalEffects` frontmatter (same jail and cap as `declaredEffects`):
a path the audit verifies ONLY when the run claims it with an `EFFECT: <path>`
stdout line. Outcomes:

- nothing claimed → `deterministic: conditional-unclaimed` (a quiet run; not
  suspicious; gated on `false_success` alone)
- claimed and changed during the run → `all-present-and-fresh`
- claimed but absent / untouched → `missing` / `stale` (suspicious — the
  false-success signal the audit exists to catch)
- a claim naming an undeclared path → ignored for verification, counted as
  `claimedUndeclared` on the pack

`reflection-trigger` (`.instar/MEMORY.md`) and `commitment-detection`
(`.instar/state/commitment-detection-bookmark.json`) now declare one effect
each and instruct the run to print the marker after writing.

## Evidence

`tests/unit/JevJobCompletionAudit.test.ts` — nine tests: quiet run is
`conditional-unclaimed` with no effects; claimed+landed is fresh and marked
`claimed`; claimed+absent is `missing`; claimed+untouched is `stale`;
undeclared claims are ignored and counted; unconditional effects still verify
alongside an unclaimed conditional; absent field is byte-identical to today;
the parser is bounded, whitespace-tolerant, deduping, and ignores prose; and
in the batch an unclaimed pack is gated on `false_success` alone and never
enters the suspicious stratum.

`tests/unit/jev-audit-wiring.test.ts` — the builder carries the field, the
loader jails it identically to `declaredEffects`, and the INSTALLED manifests
for both declaring jobs carry the right path (read from the installed
artifact, not the template — the assertion shape from the previous fix).

## What to Tell Your User

If the scheduled-job checker is on, two of the built-in jobs can now be
properly checked: the memory reflection job and the commitment detector. Each
tells the checker when it wrote its file, and the checker confirms the file
really changed. A quiet run is treated as fine. A job that says it wrote
something it didn't is now visible.

## Summary of New Capabilities

- `conditionalEffects` frontmatter on any job: a file the audit verifies only
  when the run prints `EFFECT: <path>`.
- `deterministic: conditional-unclaimed` on evidence packs; `claimed: true` on
  verified entries; `claimedUndeclared` count.
