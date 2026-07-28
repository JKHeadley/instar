---
title: "Phase-1 code-owner review package — ported feedback processor (for Dawn)"
purpose: "Make the required Phase-1 review fast + line-scoped. Delivered to Dawn through the Coordination Mandate's sign-code-review authority once it's live."
status: prepared 2026-06-05 (Echo) — awaiting the mandate + Dawn
---

# Phase-1 review package — ported feedback processor

Per the migration spec (§2.3): *"Dawn's line-by-line review of the ported fingerprint +
cluster-transition logic is a required gate, not optional."* This package scopes that review
to exactly the four scars you confirmed (a/b/c + the (d) you caught), maps each to the ported
TypeScript + your Python reference lines, and points at the parity evidence so you can confirm
equivalence quickly rather than re-reading the whole port.

**Parity already green (two independent gates):**
- **Recorded-corpus 100%** — `scripts/feedback-factory/*-parity.mjs` feed an identical
  fixed-order corpus (incl. the adversarial inputs: non-ASCII digits, em-dash, NBSP, NFC/NFD,
  Turkish-İ/ß, near-0.55-Jaccard) through both your Python and the TS port; per-report
  fingerprint + terminal-status + reopen/cycling counts match 100%. Run any yourself:
  `node scripts/feedback-factory/fingerprint-parity.mjs` (and clustering / similarity /
  transitions / verify).
- **Live invariant** — the TS port vs Portal's live `/api/instar/read`: **1346/1346 clusters,
  0 fingerprint divergences, 0 outcome divergences, divergent=false** (2026-06-05).

Parity proves *equivalence to the reference*; your review proves *the reference logic is the
one we meant to preserve*. Both are required to advance Phase 1 — hence this package.

## The four scars → ported file:lines → your Python reference

### (b) Version-fingerprint normalizer — THE most correctness-critical port
- **Ported:** `src/feedback-factory/processor/fingerprint.ts:87–103`.
  - Collapse regex (`:89`): `/v?\p{Nd}+\.\p{Nd}+\.\p{Nd}+(-[\p{L}\p{N}_.]+)?/gu` → `vN`.
    The port uses Unicode property classes (`\p{Nd}`, `\p{L}`) under the `u` flag to mirror
    Python's Unicode-aware `\d`/`\w` exactly — this is scar (b)'s subtlety (`re.sub`
    :237). **Please confirm the class semantics match** (a non-ASCII digit must collapse
    identically on both sides).
  - SHA-256 over UTF-8 of `type|component|normalized`, first 32 hex chars (`:101–103`,
    your `:242–243`).
- **Your reference:** `feedback-processor.py:227 compute_fingerprint()`, regex `:237`,
  hash `:243`.
- **Evidence:** `fingerprint-parity.mjs` (+ the adversarial corpus rows).

### (c) Regression-reopen / false-merge guard — BOTH layers
- **Ported (soft similarity):** `cluster.ts:23–24` — `SIMILARITY_THRESHOLD = 0.35`,
  `FIXED_CLUSTER_THRESHOLD = 0.55` (the raised bar before merging into a fixed/resolved
  cluster), `:82` `FALSE-MERGE-GUARD` near-miss log (your `:1431–1466`).
- **Ported (auto-reopen):** `reopen.ts` — REGRESSION → status `investigating` + bump
  `recurrenceCount`; AGED-REOPEN → status `new`, no recurrence bump (your `:1543–1584`).
- **Your reference:** `feedback-processor.py:1431–1466` + `:1543–1584`.
- **Evidence:** `clustering-parity.mjs` + `transitions-parity.mjs`.

### (d) Lifecycle partitioning + cycling prevention — the scar you caught
- **Ported:** `reportPartition.ts` (the whole module is the TS port of (d); header cites your
  `:2747`) + the cluster-level cycling detection in `transitions.ts` (`canTransition` :1045,
  `detectCycling` :1139, `chronicCount ≥ 3 → chronic_escalated` :1079).
- **Your reference:** `feedback-processor.py:2747–2793` (partitioning) + `:1084/:1139/:1079`
  (cycling). This is the unit (c)+(d) must be reviewed together — porting (c) without (d)
  reproduces the thrash (d) prevents.
- **Evidence:** `transitions-parity.mjs`.

### (a) Investigation / terminal-transition evidence gate
- **Ported:** `transitions.ts` status-transition map (`:30–39`) + `verify.ts` evidence
  requirement. `EVIDENCE_REQUIRED_STATUSES = wontfix | closed | chronic_escalated` need
  `actionTaken | researchNotes` ≥20 chars; **`fixed` is excluded** (v1 legacy — the port
  preserves the exclusion; please confirm it's still load-bearing for your back-compat).
- **Your reference:** `clusters.ts:164–176`.
- **Evidence:** `verify-parity.mjs`.

## What I'm asking you to confirm

For each scar: *does the ported TS reproduce your reference logic's behavior, including the
edge it was written for?* Specifically the four you'd flag: (b) Unicode class equivalence +
the 32-char hash; (c) both the 0.55 raised-bar AND the recurrence bump; (d) the partition
semantics as a unit with cycling; (a) the `fixed` exclusion. A line-level "confirmed" or a
"this diverges at X" on each is the Phase-1 gate.

## How this review runs (once the mandate is live)

This package reaches you through the Coordination Mandate's `sign-code-review` authority
(mutual: you review my port, I'm available for your Portal-side questions), audited, with no
human relay in the loop. Until the mandate is signed off by Justin, this is a prepared
artifact — nothing here asks you to act yet.
