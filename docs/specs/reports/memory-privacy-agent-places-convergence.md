# Convergence Report — Memory privacy: another agent gets a place of its own instead of a refusal

**Spec:** [docs/specs/memory-privacy-agent-places.md](../memory-privacy-agent-places.md)
**Slug:** `memory-privacy-agent-places`
**Converged at:** 2026-11-08
**Iterations:** 9 cross-model rounds (codex-cli, gpt-6-astra); 4 internal rounds (security, adversarial, integration, scalability, decision-completeness, lessons-aware)
**Final-round design findings:** 0 (codex round 9: MINOR ISSUES, three precision items, all fixed in passing; internal round 4: converged)

---

## ELI10 Overview

When an agent serves several people and its owner turns on memory privacy, every conversation gets its own memory, and other agents were shut out entirely. The phone app says so: "Agents can't start conversations with this one." Justin called that an unnecessary hobbling. This spec lets another agent talk to it again, in a room of its own, like a Slack channel. The room is named after that agent's checked identity. It has only its own memory, runs in the same sandbox every walled conversation uses, and replies through a script that can answer only that one agent.

While mapping how another agent's words reach a conversation, the review found several ways in that the old refusal never covered. On an agent with several people and privacy on, today: a quick one-shot mode and a listener run another agent's message with the owner's full reach, any agent can push text into a running conversation by naming its thread, and crash recovery replays a message under the wrong identity. The spec closes all of these, whether or not the new room is switched on.

The trade-offs are honest ones. Only agents the owner trusted or paired with get a room, not strangers. At most three rooms are open at once, and when they are full a new agent waits rather than knocking someone else out. Same-computer agents stay refused until local message signing is switched on. One path stays open on purpose, and it needs Echo's yes. When the owner's own session asks another agent a question, the answer still comes back into that session, as it does today. That session can see more than a room can, so it is listed as not closed. A single setting (`linkedPeerReplies: post-only`) turns it into a topic post instead.

## Original vs Converged

- **Originally**, inbound A2A was the only path considered: lift the refusal at spawn and run the spawn in a place. **After review**, every path that delivers peer text was mapped (spawn, resume, warm, drain, pipe, listener, live inject, reply waiters, topic linkage, reap recovery, mirrors). Each now has a rule. Why: the refusal sat only on the spawn path, and four other paths delivered peer text with owner reach on today's multi-person agents.
- **Originally**, the thread was trusted to name its peer. **After review**, a thread owns an authenticated fingerprint. The owner is claimed atomically, written once, and never adopted by a different sender, and history is loaded only from messages after the claim. Why: the existing entry stored only a name, so peer A could resume, inject into, or read peer B's thread.
- **Originally**, one-shot spawns would just move to the interactive lane. **After review**, a dedicated registry allows one live session per peer and at most three places. At the cap it refuses and queues, and never ends another peer's session. One session slot is kept free, and the reservation is atomic. Why: interactive sessions live longer, and the warm pool caps by killing other sessions.
- **Originally**, any authenticated peer was accepted. **After review**, the peer needs an explicit trust grant (`user-granted`, `paired-machine-granted`, `mutual-verified`). Why: on the fleet the relay's unknown-sender check is off, so a first-contact key arrives as `verified`. Without the grant, anyone could open places and spend the operator's subscription.
- **Originally**, the resume rule relied on the parent's per-place audience record. **After review**, each thread records the audience that wrote its transcript, and resume requires an exact match. Why: the per-place record lets a second thread's owner-reach transcript resume into the place. That parent-spec gap was filed as feedback.
- **Originally**, peer places inherited the full scoped allow-list. **After review**, `/team/proposals` and `/feedback` are closed to them. Why: a peer could have sent the owner an access request that looked as if it came from a person, or written to the maintainers as this agent.
- **Originally**, the iOS line was fixed text. **After review**, the app picks its line from a new `agentSessions` status field, because the fixed line would be false on one-person agents, with the switch on, or on older servers.

## Iteration Summary

| Iteration | Reviewers who flagged design issues | Design findings | Precision findings | Spec sections changed |
|---|---|---|---|---|
| 1 | codex, security, adversarial, integration, decision+lessons | ~22 | ~20 | full rewrite: §1-§9, P20, decisions, posture, tests |
| 2 | codex, security+adversarial, integration, decision+lessons | ~10 | ~14 | §1 grant column, §2 history/ownership, §3 waiters, §4 registry, posture |
| 3 | codex, combined internal | 5 | ~10 | §1 delivery check, §2 nickname ownership and order, §3 warm, §4 lock and admission |
| 4 | codex | 3 | 1 | §1 admitPeerDelivery, §2 claimOwner, decision 4 wording |
| 5 | codex | 1 | 2 | §2 legacy adoption, inReplyTo, rollback wording |
| 6 | codex | 2 | 1 | §5 hook identity as prerequisite, post-only for waiters |
| 7 | codex (MINOR) | 1 | 1 | §4 reservation accounting, post-only on topic paths |
| 8 | codex | 2 | 0 | §2 legacy history excluded |
| 9 | none (codex MINOR, internal round 4 converged) | 0 | 3 | revocation timing, E2E fixture, status predicate |

Standards-Conformance Gate: ran each round; `degraded: no-intelligence` (97 standards checked, 0 findings, fail-open). Unavailable in substance: the gate had no intelligence provider on this machine.

## Full Findings Catalog

Summarised by theme; the reviewer outputs are in the session transcript.

- **Paths not covered by the refusal** (integration explorer, security R1): pipe, listener, live inject, topic linkage, reap recovery, waiters. Resolved in §3.
- **Identity** (security R1-R2, codex R1, R5, R8): relay `msg.from` minus probe, local `provenSenderFp` only, direct HTTP verified fp, recovery flag, no canonical merging, nickname-resolved sends count, legacy adoption gives the id only. Resolved in §1 and §2.
- **Thread ownership and history** (adversarial R1, security R1-R2, codex R3-R4, R8): `peerFingerprint` written once, atomic `claimOwner`, fresh id for foreign or unowned threads, history after the claim only. Resolved in §2.
- **Capacity** (adversarial R1, integration R1-R2, decision R2, codex R2-R3, R7): place registry, refusal at cap, atomic reservation, one free slot, `automatic` admission, priority never bypasses. Resolved in §4.
- **Owner-facing routes** (adversarial R1): `/team/proposals` and `/feedback` excluded. Resolved in §6.
- **Strangers** (security R2): explicit grant column. Resolved in §1.
- **Migration Parity** (integration R1, decision R1): a dedicated relay installer, template and awareness line, status field, release fragment. Resolved in §7.
- **Topic linkage and waiters into owner sessions** (security R1, codex R1-R7): narrowed to the addressed peer. `post-only` is enforced on every path. Kept as Not closed for Echo's sign-off.
- **Hook identity** (adversarial R1, codex R6): made a shipping prerequisite in §5.

## Proportion

Tier 2 spec, about 320 lines, plus an ELI16. Nine cross-model rounds against a cap of 6. This is **out of line**. The cause was the spec's own scope: the path inventory turned up live owner-reach leaks on today's multi-person agents, and each fix exposed the next adjacent path. From round 4 on, codex findings narrowed to one or two per round. Signal only.

## Left behind

- Parent-spec gap: `audienceChanged` is keyed per place, which also affects Slack places. Filed as fb-a3dcd280-99c. Closed for A2A by `audienceKey`.
- `memorySessionGuard` allows POST `/telegram/origins/operations/:id/outcome`, but the route is GET. Filed as fb-14e8113a-dde.
- Hook identity gap: filed as fb-ad79dc04-455. It is now also a shipping prerequisite of this spec (§5).
- **Needs Echo's explicit yes at approval:** (1) decision 4, keeping linked peer replies delivered to `owner`/`system` sessions, with `post-only` one setting away; (2) the `operator-ratified-exception` markers for machine-local place folders and the per-machine switch. The approval commit is the artifact cited.

## Convergence Verdict

Converged. The final cross-model round raised no design finding, and the final internal round confirmed every earlier fix against the code. The cross-model posture is codex-cli:gpt-6-astra in all nine rounds. Gemini is not installed on this machine, so it was not run. Two items are explicitly left for the approver, as listed above.
