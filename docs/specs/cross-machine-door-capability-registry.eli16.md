---
title: "ELI16 — Cross-Machine Door + Capability Registry"
slug: "cross-machine-door-capability-registry-eli16"
status: draft
approved: false
---

# ELI16 — Cross-Machine Door + Capability Registry

Instar can already ask one machine which model doorways it knows about, and it
can already ask the mesh which machines exist. It cannot yet answer the useful
combined question: "Which machine can do this job right now, through which
doorway, and how fresh is that information?"

This proposal adds a read-only joining layer. Each machine keeps its own
doorway facts. The mesh can show a redacted, machine-labeled view of those
facts, including when a peer is stale, unknown, or disagreeing. It never copies
secrets and it does not start routing work — every answer it gives is labeled
advisory, a report card rather than a steering wheel.

The convergence review hardened the trust rules into structure rather than
promises. Each machine may only speak for itself: a peer cannot claim
capabilities on another machine's behalf, and it cannot re-tell things it
heard from others as if they were its own. Freshness is judged by the machine
RECEIVING the data, not the one sending it — so a misbehaving peer cannot
stamp itself "fresh forever," and an old recording of a machine's earlier
report is rejected rather than replayed as new. Every row also says HOW it
was verified (the tool merely exists, versus the model actually answered),
and how fresh the underlying model catalog itself is — so a stale catalog
can't masquerade as live truth.

The rollout is deliberately cautious: define the data shape, test bad and
stale peer data (including replays and floods), run it on the development
agent, then observe it on a small fleet cohort. Every step has a dark switch
and a real rollback, honestly distinguished from "empty" — a switched-off
registry says it is off; an empty one says it is empty. One honest caveat is
written into the plan: most fleet machines don't run the doorway scan yet, so
the fleet stage ships knowingly quiet until that scan graduates — that
dependency is named rather than discovered later. All ten of the draft's open
questions were settled during convergence and recorded in the spec as
frontloaded decisions, so a builder can implement it start to finish without
stopping to ask anyone anything.

One more round happened after the spec already looked finished, and it is the
part worth remembering. Five review rounds had passed and the document read as
converged, so a sixth adversarial pass was run purely to test that belief — and
it found eight real defects. The most serious was a security hole: because a
peer's "still alive" ping was accepted purely on being authentic, a captured
ping could be replayed forever to keep a dead machine looking permanently
healthy, quietly defeating the whole freshness idea. The fix requires proof
that a ping is NEW, not merely genuine, and if the underlying channel cannot
prove that, the system deliberately reports peers as stale rather than
pretending they are fresh. Others were quieter but real: two different
published limits for the same field size, two different clock-tolerance
numbers, a rule that promised to show WHICH source disagreed while having no
field able to say so, an empty answer that could mean three different things
(never checked / could not check / genuinely nothing), and a claim about
recovery that was stronger than the mechanism behind it.

The lesson is now written into the spec itself: rounds of review are not
evidence of convergence. Each round fixed wording in one place, so the numbers
drifted apart between sections while every individual round looked clean. A
document only counts as converged after a final whole-document consistency
pass — and the four regression tests protecting these particular fixes are
named in the build plan, so they cannot quietly go missing later.
