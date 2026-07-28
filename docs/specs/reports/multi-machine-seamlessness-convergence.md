# Convergence Report — Multi-Machine Seamlessness (Unified Gap-Closure Spec)

**Spec:** `docs/specs/MULTI-MACHINE-SEAMLESSNESS-SPEC.md`
**Plain-English companion:** `docs/specs/multi-machine-seamlessness.eli16.md`
**Source audit:** `docs/research/multi-machine-ux-gap-audit-2026-06-12.md` (F1–F23)
**Run:** autonomous, topic 13481, 2026-06-12 (operator pre-approved)

## ELI10 Overview

You run one agent on more than one computer, and you asked for one thing: talking to
it should feel like talking to ONE being, no matter which machine answers. Today we
tested that by moving a live conversation from the laptop to the Mac Mini — and found
the move only flips a label. Messages kept landing on the laptop, the laptop kept
answering, and the system spent an hour politely trying (and correctly failing) to
close the laptop's copy while it was busy working. We then audited everything else
with the same question and found about twenty places where the seam between machines
shows: the agent's memories of you don't follow you between machines, things needing
your attention on one machine are invisible from the other, links break if content
lives on the other machine, two machines could both speak for the same conversation
(or both stay silent), and an idle machine looks identical to a broken one.

This spec closes all of it in five workstreams: the conversation actually follows a
move (with a polite finish-your-sentence handoff), the agent's memory replicates
between machines (encrypted, carefully merged, fully reversible), exactly one machine
ever speaks for a conversation, the dashboard becomes genuinely one pane of glass,
and quota/account awareness spans the pool. Everything ships dark behind switches,
with dry-run modes, and a single-machine setup is structurally untouched.

The main tradeoffs: replicating memories costs disk and network (bounded, with caps,
compaction, and a quarantine for suspicious records); keeping one web address for all
machines concentrates traffic on the fronting machine (streamed, capped, cached, with
honest load-shedding); and the two security-heavy pieces — syncing the agent's model
of PEOPLE (PII) and enrolling subscription accounts across machines — are deliberately
deferred to their own focused security reviews with formal sign-off, so nothing risky
ships from this spec.

## Original vs Converged

The review process changed this design substantially:

- **Originally**, if message routing failed to classify a message, it fell back to
  "deliver locally like today." Reviewers proved that silently re-opens the exact
  wrong-place-delivery bug being fixed. **Now** an unresolvable message goes to the
  durable on-disk queue — local delivery happens only when ownership positively says
  "local."
- **Originally**, a machine could take over a conversation from an unreachable owner
  after a timer. Reviewers showed a merely-SLOW machine looks identical to a dead one
  — the timer would steal live conversations mid-sentence. **Now** takeover requires
  positive evidence of death (lapsed lease, missed heartbeats, failed probe), with
  authenticated provenance, and a slow-but-alive owner gets a polite handoff instead.
- **Originally**, memory merges used "newest timestamp wins." Reviewers showed a
  machine with a fast clock would win every merge forever — silent corruption of the
  agent's model of you. **Now** merges use logical clocks, suspicious records are
  quarantined (in a bounded, coalescing store — reviewers then bounded the quarantine
  itself), conflicting versions are both preserved and flagged, and an authenticated
  resolve-conflict endpoint with a dashboard surface lets you settle disagreements.
- **Originally**, "one machine speaks" gates could leave BOTH machines silent when
  ownership was unclear — worse than double-talk. **Now** the rule fails toward
  speech with a deterministic tiebreak and a stability dwell so a flapping lease can't
  bounce the microphone, with a test asserting exactly one speaker always.
- **Originally**, turning memory-sync off was a flag flip. Reviewers showed merged
  foreign records would simply stay. **Now** replicated records live in origin-tagged
  namespaces that local reads union — disabling a store atomically un-merges it.
- **Reviewers also grounded the spec against the real code**: the replication layer
  silently DROPS record types it doesn't know, so new record types are only sent to
  peers that advertise support; the job-claim upgrade got a strict cutover rule so two
  claim mechanisms never run side by side; the cross-machine drain is a new
  authenticated verb with a version bump and an honest old-version fallback; and the
  build order now says plainly that the status-surface fix shipping before the
  delivery fix does NOT yet move conversations.

## Iteration Summary

| Iteration | Reviewers | Material findings | Outcome |
|-----------|-----------|-------------------|---------|
| 1 | security 9 · scalability 9 · adversarial 18 · integration 11 · lessons-aware 8 · Gemini 7 | **62** | Full spec rewrite (custody invariants, fail-to-queue, HLC merges, origin-tag rollback, one-voice invariant, pool flag coherence, migration/awareness section, test plan) |
| 2 | security 5 · scalability 5 · adversarial 7 · integration 7 · lessons-aware 3 · Gemini 2 | **29** | Targeted hardening of round-1 mechanisms (owner-death evidence for force-win, bounded quarantine, audience-bound assertions, operator-bound acks, journal-kind discipline, claim cutover, deferral frontmatter) |
| 3 | security 0 · adversarial 0 · integration+scalability 0 · lessons-aware 0 · Gemini 0 | **0** | Converged |

External reviewer note: GPT-tier and Grok-tier CLIs are not installed on this machine;
Gemini (gemini-2.5-pro) served as the external cross-model reviewer in every round.
All five internal perspectives ran in every round, including the mandatory
lessons-aware pass with foundation audit.

## Full Findings Catalog

The complete per-reviewer finding texts (91 findings: 62 round-1, 29 round-2) with
their resolutions are preserved in the autonomous run transcript (topic 13481,
2026-06-12). Catalog highlights by theme:

**Correctness/custody (adversarial+Gemini):** fail-open re-opened F1 → fail-to-queue;
double/zero delivery across ownership flips → single-custody contract + acknowledged
transfer; forward ping-pong → hop-TTL 2 + placement-disputed; bounce↔forward cycling →
bounce counts against hop budget + parks until a new epoch; drain timeout undefined →
force-close terminal semantics + barrier + emergency-stop rule; simultaneous release →
orphan tombstone + lease-holder adoption + exactly-one-owner invariant + quorum
fallback; closeout reaper unbounded retry (P19 foundation violation) → breaker added.

**Security:** WS2 replication = write surface → receiver revalidation + own-authored
only; forged pin → authenticated provenance (both normal and force-win paths);
WS4.4 proxy → end-user credential end-to-end + audience-bound single-use assertions;
remote ack → mutating RBAC class + operator-principal binding + current-class-wins;
heartbeat flag advertisement → authenticated envelope + audited; KB bodies →
holder-authorized; WS5.2 boundary → operator-initiated, PIN-gated, no peer
self-enrollment.

**Data integrity (all):** wall-clock merges corrupt under skew → HLC + skew
quarantine; quarantine itself unbounded → bounded ring + coalesce by (peer,
failure-class) + per-peer breaker; append-both floods → idempotent on (record-key,
version-pair) + operator escalation + POST /state/resolve-conflict; merged-store
rollback → origin-tagged namespaces with atomic un-merge + union-reader at the lowest
primitive with wiring-integrity tests.

**Deployment (integration):** dispatchInbound seam exists only on the unmerged
durable-queue branch → hard dependency gate + CI precondition; journal applier
silently drops unknown kinds → flag-gated kind emission; MachineCapacity needs the
seamlessnessFlags field with absent=non-participant; JobClaimManager two-mechanism
window → all-peers-advertise cutover; drain = new mesh verb + protocol bump + 501
degrade; WS1.3-before-WS1.1 ships only the honest surface (build-order note);
migration parity + CLAUDE.md awareness per workstream; single-machine strict no-op.

**Performance (scalability):** placement reads local-only sub-ms; forwards async +
bounded + spill-to-queue; per-store bounds/retention/compaction + ONE aggregate
journal budget across ALL new kinds; snapshot-then-tail off the event loop + reuse
window + rebuild breaker; pool-scope reads share one per-peer poll cache; fronting
machine load-sheds to last-cached-with-staleness.

**Process (lessons-aware):** principal-deferral-approval frontmatter for the two
recurrence-risking deferrals (tracked: CMT-1413); P8 engaged (consent-before-context,
no dead ends); P17 engaged at the pool-merge point; lessons-engaged frontmatter added
and verified honest in round 3.

## Convergence verdict

Converged at iteration 3. No material findings in the final round from any of the
five perspectives (security, adversarial, integration+scalability, lessons-aware,
external/Gemini), with every round-2 fix verified present in the text by quotation.
Spec is ready for operator review and approval.
