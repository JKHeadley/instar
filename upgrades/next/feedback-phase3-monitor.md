<!-- bump: patch -->

## What Changed

Added the Phase-3 invariant-parity monitor for the feedback-factory migration: a
windowing layer over parity results that computes the objective
parity-zero-divergence condition (a sustained run of clean passes over a minimum
real-traffic window) which the future cutover step reads as its go signal. Includes
a durable, restart-surviving variant (append-only pass journal, torn-line tolerant).
Internal migration tooling — not yet wired to any live behavior.

## What to Tell Your User

Nothing changes for you. This is internal plumbing for the feedback-system handover:
a safety meter that has to read "clean for a sustained window" before the one-way
switch can ever be considered. It ships dormant.

## Summary of New Capabilities

- Internal: order-independent parity windowing (per-report fingerprint,
  terminal-status, recurrence/cycling counts) with a conservative
  cleared-or-blocked gate verdict; survives restarts.
- Maturity: internal migration tooling, dormant until the dual-forward phase.
