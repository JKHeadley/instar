# Convergence Report — A2A backup routes

## Cross-model review: codex-cli:gpt-6-astra (RAN — every round) + clean-door-anthropic-review: claude-code:claude-fable-5

This spec went through two campaigns.

**v1 (R1–R9, 2026-10-06).** The original design was a sender-only, exactly-once design built from claims, pre-attempt settlement and supersession checks. It ran nine rounds without converging. Every round, reviewers found races in the machinery the previous round had added. Under the standing "cut to five floors" rule, the work was restructured:
- the receiver-side message-id ledger shipped first (`a2a-inbound-id-ledger.md`, ACT-053, PR #2141);
- this spec was rewritten from scratch on top of it.

**v2–v8 (B1–B6, 2026-10-07).** What ran in each round:
- The Standards-Conformance Gate.
- An external GPT-tier review through the agent's codex CLI (`gpt-6-astra`).
- A clean-door Anthropic second read (`claude-fable-5`), disclosed separately; it never counts as cross-model.
- Internal reviewers, which were subagents of the authoring session on `claude-opus-5-5`:
  - B1 and B2: adversarial plus security, and integration plus scalability plus decision-completeness plus lessons.
  - B3: one combined reviewer.
  - B4 and B5: one adversarial reviewer.

## ELI10 Overview

Some agents run on the same computer. Today, when one of them sends a message to the other by name, it first tries a direct local connection, and uses the shared relay only if that fails.

Two things were wrong with this:
1. **A message could arrive twice with no warning.** When the local attempt timed out after the receiver had already taken the message, the relay copy arrived too. Nothing told the receiver it was a repeat.
2. **Addressing by fingerprint skipped the local route.** A message addressed by the agent's fingerprint, its unique key, always went through the relay. So if the relay was down, same-computer agents addressing each other that way could not talk.

This spec fixes both:
- The relay copy now carries the same message id, on the same conversation thread, marked as a resend. The receiver's ledger labels it "resent copy — check the history before replying".
- A message addressed by fingerprint now tries the local route first. It does so only when the other server proves it is that agent and is the one holding its relay connection. Secrets still go over the relay.

## Original vs Converged

- **Design shape.**
  - v1 / v2: a background loop that resent failed messages over the local route, with scheduling, reservations, probes and attention items.
  - Converged: no new background work. The spec only changes how repeats the system already makes are labelled, plus one new local route for fingerprint addresses.
  - Rounds B1–B3 found most problems inside that loop. Both of its scheduling points were weak: one was almost always a duplicate the receiver had already admitted, and the other was barely reachable and let reap recovery write a second reply.
- **The redelivery sentinel.**
  - v4–v6: it reused the original id.
  - Converged: it is unchanged.
  - Why: a message id cannot tell an original's late relay answer from a resend's, so reusing the id would let a rejected resend fail the original message. Doing this right needs per-attempt ids, tracked as ACT-057 (due 2026-11-17).
- **The name-path refusal fix.**
  - v3–v5: added.
  - Converged: removed.
  - Why: the only explicit refusal the receiver gives is unreachable from the name path, so the change guarded traffic that cannot exist.
- **The local-route trust floor.**
  - v3–v4: added.
  - Converged: removed.
  - Why: no sender in the final design marks local messages. The pre-existing hole, unknown local senders treated as trusted, is ACT-056 (due 2026-10-21), and the fleet flip waits for it.
- **When a fall-through counts as a possible repeat.**
  - Originally: inferred from broad classes of answer.
  - Converged: an enumerated set of answers proves the local copy was not taken; every other answer after the local POST is marked.
  - Why: marking too often only changes a notice's wording, so it is the safe direction.
- **Fingerprint routing.**
  - Originally: a fingerprint match fed the name matcher, where two ports would have hit the "ambiguous target" refusal.
  - Converged: an exclusive branch, classified first, de-duplicated. It requires a live fingerprint match and a connected relay, which excludes standbys and displaced copies. It is skipped for credential sends.
- **Thread of the relay copy.**
  - Originally: it could land on a different thread from the local attempt.
  - Converged: it reuses the local attempt's thread, so the label points at the right history.

## Iteration Summary

| Round | Distinct design findings | Change | Standards-Conformance Gate |
|---|---|---|---|
| R1–R9 (v1) | ~9 per round, not falling | restructured: ledger first | ran each round |
| B1 (v2) | ~16 | v3: revalidation, credential checks, classifier, aggregated escalation | ran (weak, 4 flags) |
| B2 (v3) | ~12 | **structural cut**: background loop removed | ran (weak, 2 flags) |
| B3 (v5) | ~9 | v6: refusal fix cut, verdict isolation, credential skip, de-duplication | ran (weak, 2 flags) |
| B4 (v6) | 4, all in the sentinel change | v7: sentinel change cut (ACT-057) | ran (weak, 2 flags) |
| B5 (v7) | 0 external (both MINOR); 1 internal (thread) | v8: same thread, enumerated unmark set, exclusive fingerprint branch, standby exclusion | ran (weak, 2 flags) |
| B6 (v8) | — | ownership residual stated | ran (weak, 2 flags, both the ownership-at-fire-time point, addressed in Multi-machine posture) |

The gate's two remaining flags are about conversation ownership at the moment of delivery. The spec answers them in its Multi-machine posture:
- Ownership at fire time belongs to the receiver.
- The sender has no authority over another agent's ownership record.
- The fingerprint branch reaches the same receiver path a name address already reaches, under a stricter precondition.

## Accepted, not changed

- **A relay rejection after a local copy may have landed still marks the message failed.** This is pre-existing behaviour, defined by honest delivery's transition table. Changing it belongs to that spec, not this one.
- **Agents with the relay disabled do not get the new fingerprint route.** The route is new, so this is not a regression.
- **Relay independence only reaches a receiver that is still connected to the relay.** The fingerprint route does not survive a relay outage that also disconnects the receiver.

## Evolution items

- **ACT-056:** the local route treats unknown senders as verified. Due 2026-10-21; the fleet flip waits for it.
- **ACT-057:** same-id sentinel resends need per-attempt verdict correlation. Due 2026-11-17.
- **ACT-052:** cross-machine backup route.
