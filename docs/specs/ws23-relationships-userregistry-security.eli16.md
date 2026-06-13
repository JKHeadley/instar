# WS2.3 relationships + user-registry replication security — plain-English overview

## What this is

For "one agent, many machines" to truly know the same people everywhere, your
relationship notes and your user-identity registry need to exist on all your
machines. Both of those hold **real personal information about other people**
(names, phone/email channel handles, notes, permissions). This document is the
**security convergence round** the parent multi-machine spec required before any
of that replication code is allowed to ship (tracked as CMT-1413). It is a
**spec for review, not a build** — no code changes here.

## What already exists vs what's new

Already fixed by the parent spec (this round details, doesn't re-litigate):
records travel **sealed per-recipient** (the existing X25519 encrypted secret-sync
transport), the receiver **re-validates** any identity field rather than trusting
the sender, forged records are rejected by provenance binding, and disabling
replication has a real origin-tagged un-merge.

The honest residual, stated plainly: **at rest, replicated records land as
plaintext JSON** (same protection as locally-created PII today — the seal is
transit-only), so replication widens how many machines hold that PII. The parent
spec recorded that you accepted this trade-off; this spec names it without
euphemism.

## The most important finding

The convergence surfaced a **real blocker the earlier framing missed**: WS2.3's
merge/ordering depends on two primitives that **do not exist in the codebase
yet** — a hybrid logical clock (HLC) for ordering edits across machines without
trusting wall-clocks, and snapshot-then-tail compaction so the record log stays
bounded. A grep confirmed zero such symbols today. So the spec installs a
**dependency gate**: no WS2.3 store/merge/tombstone code may begin until those
primitives are built and converged on their own. This is the spec doing its job —
catching a missing foundation before a PII feature is built on sand.

## Safeguards in plain terms

Threat-modeled and mitigated: forged records, replays, a malicious peer injecting
PII or instruction-shaped text (neutralized as quoted data), exfiltration via an
added peer, a deauthorized user's records lingering (erasure propagation incl.
offline peers), and clock-skew abuse (HLC, not wall-clock). Every bound (quarantine
ring, per-store budget, deferred-erasure queue, tombstone GC) is a fixed ceiling
independent of how many machines you run — so it holds for N cloud VMs, not just
two Macs.

## What you actually need to decide

Two things, when you're ready: (1) approve this spec (it discharges the CMT-1413
WS2.3-transport deferral) — or send it back; and (2) acknowledge it gates the
actual WS2.3 build behind first building the HLC + compaction primitives. Until
you approve, nothing replicates relationship/user PII.
