# Convergence Report — A2A cross-machine route (forward to my relay-holding machine)

## Cross-model review: codex-cli:gpt-6-astra (RAN — every round) + clean-door-anthropic-review: claude-code:claude-fable-5

The spec went through five review rounds on 2026-10-08 (X1–X5), followed by a final gate check on v7.

What ran in each round:
- The Standards-Conformance Gate, on the spec's markdown.
- An external GPT-tier review through the agent's codex CLI (`gpt-6-astra`).
- A clean-door Anthropic second read (`claude-fable-5`). It is disclosed separately and never counts as cross-model.
- One combined internal reviewer, a subagent of the authoring session on `claude-opus-5-5`. It covered the adversarial, security, integration, decision-completeness and lessons lenses.

Exceptions and additions:
- In round X1 the external passes were stopped before completion. The internal review and the relay event log had already shown the first design solved the wrong case.
- After round X3 one read-only feasibility study ran. It compared three shapes for the reply path.

## ELI10 Overview

I run on several computers. Only one of them at a time holds my connection to the relay, the post office that agents use to message each other. A session on one of my other computers, a standby, cannot send an agent-to-agent message today. The send just fails.

This change lets a standby hand the send to the computer that holds the connection. It uses the signed link my computers already use to talk to each other. The holding computer sends the message in the ordinary way and keeps the records.

When the other agent replies, the reply arrives at the holding computer. The holding computer types it into the conversation's live session on whichever computer has it. If it cannot do that, it posts the reply into the Telegram topic. For a reply tied to a topic, it never starts a new session that knows nothing about the conversation.

## Original vs Converged

- **The route itself.**
  - Originally: a direct, encrypted route to a different agent's machine. It used signed "address cards" exchanged over the relay and a new public endpoint.
  - After review: cut. The relay event log, covering seven weeks, shows 29 displacements, 11 own restarts, 11 unexplained drops and 1 relay server shutdown. The direct route helped only the rarest of these. It also refused to work during a displacement, which was the motivating incident. It is parked as ACT-065.
- **Who forwards.**
  - Originally: any machine whose relay client was not connected.
  - After review: only a relay standby forwards. A displaced machine reclaims the connection after 15 minutes, so two owners trade it back and forth. That would leave replies pointing at a machine that no longer holds the connection. The displacement evidence is also stale: the last one was 2026-09-05.
- **Who owns the conversation.**
  - Originally: the sender kept the conversation and the holder was "only a pipe". That needed a tracker column, a second inbound verb, fallback rules and an ownership rule.
  - After review: the holder runs the complete ordinary send and owns the records. Three rounds had kept finding races in the reply protocol the first design needed: a fast reply arriving before the routing row existed, a holder change orphaning threads, and both machines handling one message.
- **Where a reply goes.**
  - Originally: handed back by a rule ("the newest tracker row decides").
  - After review: the holder stamps the sending machine at origin capture. It asks that machine first, then at most one more. Each ask is one bounded call that never starts a session. Any failure becomes the existing visible Telegram post.
- **A pre-existing bug found on the way.** A name-addressed send stored the typed name while the reply carried the fingerprint. The reply failed the sender check and fell through to a context-less session. The fix is one comparison against the thread's resolved fingerprint. It ships ungated.
- **The handler.**
  - Originally: lift a thousand-line route body into a shared function.
  - After review: the holder's handler calls its own route on loopback with a boot-time secret. The lift is tracked as ACT-068.
- **A local dedup on the receiving machine.** It was added in one round and removed in the next. It would have swallowed a deliberately resent, labelled copy.

## Iteration Summary

| Round | Version | Distinct design findings | Change | Standards-Conformance Gate |
|---|---|---|---|---|
| X1 | address-card draft | 9 (internal; externals stopped) | **cut**: mesh forward to my own relay holder | ran (fit, 3 flags) |
| X2 | v3 mesh-forward | ~9 | v4: holder is a pipe; replies routed back | ran (fit, 3 flags) |
| X3 | v4 | ~8, all in the new reply protocol | **cut** after feasibility study: holder owns records; reply injected into the topic's session | ran (fit, 2 flags) |
| X4 | v5 | 5, mostly cuts | v6: standby-only trigger; `machineOrigin`; sender-check fix; dedup deleted | ran (fit, 3 flags) |
| X5 (narrow) | v6 | 0 internal; 3 edge cases (codex) | v7: wrapped dependency, no holder-local delivery for a forward, one reply budget, structural loop stop | ran (fit, 3 flags) |
| final | v7 | — | ACT-070 cited for the rate-limited reply residual | ran (fit, 3 flags) |

Three gate flags stand at the end. Each is an acknowledged, pre-existing posture named in the spec:
1. **Records live on the holder.** A2A conversation records stay on the holder. Replication is ACT-054.
2. **Inject is authorised by a live session.** The reply inject is authorised by the receiver's own live session for the topic. A stale duplicate session is the duplicate-session reconciler's concern.
3. **A rate-limited reply is not resurfaced.** It stays in the hub with its commitment open and nothing brings it back. Tracked as ACT-070, due 2026-10-12.

## Accepted, not changed

- **Sends with no topic.** A send from a job or an unbound session gets its reply on the holder. The sending session does not see it in-band. This is the same as a holder-originated parentless thread today.
- **`waitForReply`.** It is not honoured across machines. The sender is answered at once with `reply: null`.
- **Duplicate note.** An inject that timed out but landed, plus the Telegram post, gives one visible duplicate note. A second session never processes the reply.
- **Negotiator single-voice.** It is not enforced across machines. The gate is dry-run today.

## Evolution items

- **ACT-052:** this route.
- **ACT-065:** direct route to a different agent's machine. Evidence-gated, due 2026-10-22.
- **ACT-068:** lift the relay-send route body. Due 2026-10-20.
- **ACT-070:** resurface rate-limited topic replies. Due 2026-10-12.
- **ACT-054:** replicate A2A records across machines.
