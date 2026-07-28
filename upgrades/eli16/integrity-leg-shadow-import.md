# ELI16 — Wire the cutover door's integrity check so it can actually go green

## What this is

The feedback-process migration (Dawn → Echo) ends with one irreversible step: an operator clicks "cut over," and from then on the new instance is canonical. To make that click safe, there's a **readiness door** that only reads green when two things are true: the live data still matches (parity), AND a real import of the curated data passes every integrity check (no corrupted clusters, no broken links, no schema surprises).

The door's formula is literally `ready = integrity.passed && parity.cleared && !parity.stale`.

## What already existed

- The **parity** half works (verified live — a clusters-only pass clears in ~1s).
- The integrity gate's *math* existed (`runIntegrityGate` — checksums, fingerprint-uniqueness, schema-equivalence, referential integrity) and was already proven clean over the live 145K-row corpus.
- BUT the function that records a passing integrity report — `recordIntegrityReport` — had **zero callers**. Nothing in the running server ever ran a real import and wrote that report. So the integrity half could never turn green, which meant the door could never open. The migration was stuck one wire short of the finish line.

## What's new

A single new trigger: **`POST /cutover-readiness/integrity-pass`**. When called, it:
1. Fetches the live curated corpus (read-only).
2. Imports it AS-IS into a **persisted shadow** (a throwaway on-disk copy — never the canonical database).
3. Runs the full integrity gate over what landed.
4. Records the verdict to the canonical integrity path — a **passing** report turns the integrity leg green; a **failing** one keeps it shut (the door always reflects the latest real check).

Because importing 145K rows would freeze the server's event loop, the heavy work runs in a **separate child process** (the same lesson that drove the parity fix). The shadow is a verification copy only — the real production import still happens *after* the operator clicks, on Dawn's side.

## What you need to decide

Nothing changes automatically. Building or merging this **cannot** make the door go green — that only happens when someone explicitly triggers the pass on the deployed server. The cutover click itself stays entirely the operator's. This change just makes "is everything up to the door green?" answerable from real evidence instead of an un-runnable gap.
