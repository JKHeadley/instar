---
title: "ELI16 — Cross-Machine Door + Capability Registry"
slug: "cross-machine-door-capability-registry-eli16"
status: draft
approved: false
---

# ELI16 — Cross-Machine Door + Capability Registry

Instar can already ask one machine which model doorways it knows about, and it
can already ask the mesh which machines exist. It cannot yet answer the useful
combined question: “Which machine can do this job right now, through which
doorway, and how fresh is that information?”

This proposal adds a read-only joining layer. Each machine keeps its own
doorway facts. The mesh can show a redacted, machine-labeled view of those
facts, including when a peer is stale, unknown, or disagreeing. It never copies
secrets and it does not start routing work.

The first steps are deliberately cautious: define the data shape, test bad and
stale peer data, run it on the development agent, then observe it on a small
fleet cohort. Every step has a dark switch and rollback. The open questions in
the main spec—freshness, transport, authorization, vocabulary, and operator
display—must be answered in convergence before any implementation or routing
decision is approved.
