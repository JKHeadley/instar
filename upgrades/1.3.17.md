# Instar Upgrade Guide — NEXT

<!-- bump: patch -->

## What Changed

**Framework-Onboarding Mentor System — forensic dedup stability.** A live validation run surfaced
that the same root issue could be logged 2–3 times across ticks under different IDs, because when the
model omitted a stable identifier the system derived one from the (drifting) wording — the exact
title-dependence the design doc warns against. Fixed two ways: the forensic prompt now demands a
stable, symptom-based identifier (no version numbers, counts, ids, or wording variants), and the
fallback derivation strips volatile tokens before building a key. Live re-run confirmed cross-tick
merging now works (16 → 12 issues over the same 3 iterations). Still dormant.

## What to Tell Your User

- The mentor's notebook now keeps one entry per real problem even when the wording wobbles between
  inspections — no more slow drizzle of near-duplicate entries.

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Stable forensic dedup | Automatic — the same root issue collapses to one ledger entry across ticks |

## Evidence

Found by running the real loop through multiple iterations against real data (the iterate-and-harden
loop working as designed). Fix proven by: 3 new unit tests asserting the model-supplied stable key is
preferred, that two phrasings of one issue differing only in volatile tokens (`8s` vs `8000ms`)
collapse to the **same** dedupKey, and that version/percent/hex tokens are stripped from the derived
fallback; plus a live re-run on Echo's real server.log + Codey's real rollouts showing cross-tick
merge dropped duplicates from 16 → 12 over the same 3 iterations. 13 unit tests total; affected
push-config suite green vs canonical main.
