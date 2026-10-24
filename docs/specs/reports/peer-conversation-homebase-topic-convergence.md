# Convergence Report — Per-peer homebase topic

## ⚠ Cross-model review: codex-cli:gpt-6-astra — RAN, but convergence STOPPED BY OPERATOR DIRECTION, not by the automated bar

Read this before applying `approved: true`.

The external pass **ran** (codex-cli, gpt-6-astra) on every round, so this spec did receive real
non-Claude review. But it did **NOT** meet `/spec-converge`'s own two-consecutive-DESIGN-clean-
rounds criterion. It was stopped deliberately, by the operator, mid-process:

> *"Why is this taking so long? Is this really that complicated of a feature. Instar design and
> review has a habit of over-engineering, NOT applying the fractal 80/20 principle, NOT applying
> Occam's razor. 'Convergence' on reviews means it reaches fractal 80/20 convergence, it does NOT
> mean that all the long tail issues are resolved."* — Justin, 2026-10-22

His instruction was explicit: build the simplest version, review one round and at most three,
and stop when a round finds nothing that changes what gets built. That is the bar this spec was
held to, and it is a different (deliberately lower) bar than the skill's default.

## ELI10 overview

Your agent talks to other agents. When one of them had something to tell you, the message landed
in whatever Telegram topic that agent's conversation happened to start in — which for `pp` was a
conversation about Claude quota, so you never saw it. This gives each paired agent its own topic,
points that agent's conversation at it, stops the accidental inheritance that caused the
misdelivery, and makes a peer's request for you arrive there with a notification.

## Original vs converged — and then deliberately un-converged

The original draft proposed auto-creating a topic per peer. Review refused that twice on a
destination-policy standard (an agent must not mint notification topics), so it was reframed as
an **offered** topic the operator creates with one tap. Review then drove that version through
eighteen more rounds: a per-peer state machine, acknowledged-before-create replication, signed
topic-ownership markers verified through the provenance layer, duplicate-claim detection with
durable winner/retirement records, adapter capability preconditions, and bounded post rendering.
It reached 72KB and was, by then, a correct and unbuildable document.

The operator stopped it and reversed the central decision: creation is **automatic** again,
because he asked for the topics and one-per-paired-agent is a bounded set he wants. That makes
the destination-policy refusal an `operator-ratified-exception`, recorded with his words.

The result is 87% smaller and specifies four things instead of nine. Everything the long version
protected against is now in a "deliberately left behind" table with its risk stated — which is
the actual deliverable of those eighteen rounds: not the machinery, but knowing precisely what
is being accepted.

## Iteration summary

| Round | Reviewers | Design findings | Outcome |
|---|---|---|---|
| 1–21 (long draft) | Standards gate + codex | ~30 | Abandoned by operator direction; retained as the risk inventory |
| 1 (simplified) | Standards gate (2) + codex (4) | 6 | Legacy operator bindings could be overwritten; escalation bypassed binding precedence; creation never ran when verification happened on a standby; name collision between same-named peers. All fixed. |
| 2 (simplified) | Standards gate (4) + codex (4) | 4 | Stale text in §4/§9 still contradicted the new binding rule; `user-visible` still routed unconditionally to the homebase; fingerprint-map-first ordering added; §6's crash claim corrected. All fixed. |
| 3 (simplified) | codex | 1 build-changing | **MINOR ISSUES** — "the accepted recovery limitations do not justify restoring the discarded state machines". Fixed which-conversation-binds (zero / one / many). Two precision findings noted and left, per operator direction. |

Standards-Conformance Gate: ran every round. Its final simplified-draft state carries two
standing signal-only flags it will not clear — automatic topic creation (the operator-ratified
exception above) and name-based topic identity (an accepted long-tail risk). Both are recorded
in the spec rather than argued away.

## Verdict

**Converged to the operator's 80/20 bar at round 3, not to the skill's default bar.** The last
round found one thing that changed what gets built; it was fixed. Remaining findings are
precision and are listed above rather than resolved. Ready for review with that caveat explicit.
