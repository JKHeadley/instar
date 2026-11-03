# Side-Effects Review — Session handoffs stay out of the user's chat

**Version / slug:** `same-agent-session-handoff`
**Date:** `2026-11-03`
**Author:** `Echo`
**Second-pass reviewer:** `independent reviewer subagent (see below)`

## Summary of the change

Tier 1. 14 files, about 470 lines, most of them tests. Effort: one design pass, no spec rounds.

Live incident (Echo Bugs topic 10000001474): a desk session posted an agent-to-agent task request into the user's "Increasing Throughput" Telegram topic, and the operator saw it. Root cause in instar: `MessageRouter.send` saved a same-agent message to a named session at phase `sent` and never delivered it. `DeliveryRetryManager` only retries `queued`/`undelivered`, and nothing else reads `sent`. So sessions had no working private channel, and the user topic was the one route that arrived.

Three parts:
1. `src/messaging/MessageRouter.ts`: a same-machine, same-agent message whose `to.session` is neither `*` nor `best` is handled in two steps:
   - **Ownership check.** A new `isOwnSession` config hook asks whether the target is a running session of this agent. In production, `src/commands/server.ts` backs it with `SessionManager.listRunningSessions()`. If the target is not one of ours, the message is marked `failed`, never typed and never retried.
   - **Delivery.** Otherwise it goes through the existing `MessageDelivery.deliverToSession`. That function checks the session is alive, the foreground program is on the allowed list, and the context budget. Its human-input check is a stub that returns false in production: agent sessions are treated as having no human typist, the same assumption every Telegram injection already makes. Success sets `delivered`. A failure, or a throw, sets `queued` with `failureReason`, and the existing Layer-2 retry loop picks it up (every 30 s, 10 tries, then dead-letter). The method never throws.
2. `src/messaging/MessageFormatter.ts`: a same-agent message's reply line points to `POST /messages/send` to the sender session, not `threadline_send`.
3. `src/core/MessagingToneGate.ts`: new rule `B22_AGENT_COORDINATION_TO_USER` (class `behavioral-judgment`, disposition `advisory`) in a new "AUDIENCE rule" prompt section.
4. `src/core/PostUpdateMigrator.ts` and `src/scaffold/templates.ts`: a shared `SESSION_HANDOFF_CLAUDEMD_SECTION`, emitted for new agents and content-sniffed into existing CLAUDE.md files.

## Decision-point inventory

- `MessagingToneGate` outbound review: **modify**. Adds one meaning-judged, advisory rule.
- `MessageRouter.send` same-agent routing: **modify**. Was "save and do nothing"; now "deliver or queue". Injection-safety decisions are pass-through to the existing `MessageDelivery.checkInjectionSafety`.
- `DeliveryRetryManager` Layer-2/Layer-3: **pass-through**. It now sees same-agent `queued` and `delivered` rows it never saw before.

---

## 1. Over-block

B22 might hold a legitimate user message that talks about agents: a progress update naming the desk or another session, or a message in a topic the user set up for agent chatter. Mitigations:
- The prompt carves out third-person progress updates, user-requested relays, messages addressed to the user, and agent rooms evident from the recent conversation.
- It says to favour false negatives and to pass when uncertain.
- B22 is advisory everywhere, including fleet agents with the migration off. A wrong hold returns the message to the agent with the reason, and the agent can resend unchanged with `--tone-ack B22_AGENT_COORDINATION_TO_USER --tone-reason "…"`.
- No hard wall is added anywhere.

Router: no block surface. A message that previously sat undelivered is now delivered; it is never refused.

## 2. Under-block

- B22 is an LLM judgment, so a coordination message phrased like a user update can pass.
- Advisory means a determined agent can override it, with a recorded reason.
- Server-held Telegram retries re-run the gate, so a held message can pass on a later review. That retry-until-pass behaviour belongs to the telegram-origin recovery path and is tracked separately (filed to the feedback queue, see Conclusion).
- The agent-awareness section and the working route remove the reason sessions reached for the user topic. That is the main closure; B22 is the backstop.

## 3. Level-of-abstraction fit

- Delivery belongs in `MessageRouter.send`, the same place cross-agent and cross-machine routing already branch. It reuses `MessageDelivery` and the retry manager instead of adding a new injector.
- The audience check belongs in the existing smart outbound gate, which already has the recent conversation and judges every user-channel message. A parallel detector would duplicate it.

## 4. Signal vs authority compliance

- [x] Yes — but the logic is a smart gate with full conversational context (LLM-backed with recent history or equivalent).

B22 lives inside the LLM tone gate and is advisory, so the final decision stays with the agent and is recorded. The router change has no block/allow surface.

## 4b. Judgment-point check

No new static heuristic at a competing-signals decision point. The router branch is enumerable: same agent, same machine, named session. The audience question is a meaning judgment and sits in the existing LLM judge.

## 5. Interactions

- **Retry manager:** sees same-agent `queued` rows and retries them through the same `deliverToSession`, so there is no double delivery. A `delivered` row is never retried. A first-try delivery does not register the 10-second post-injection watchdog; only retry deliveries do, as for every other first-try path that does not hold the retry manager. A typed-in block that the TUI does not submit stays visible at the prompt rather than vanishing. Noted, not changed here.
- **Wrong target:** a same-agent message to a name that is not one of this agent's running sessions (another agent's Claude session, or an operator shell on the same host) is `failed` and never typed. Pinned by a unit test and a wiring test on `server.ts`.
- **Layer-3 escalation:** `request`/`query`/`wellness` messages that are delivered but never acknowledged expire and raise `onEscalate`. That notice could reach the operator. The CLAUDE.md section tells agents to use `handoff`/`info`, which have no acknowledgement timeout. Same-agent messages of those types never reached delivery before, so this is a new reachable path only for agents that choose `request`/`query`.
- **Broadcast `*` and unresolved `best`:** unchanged (stay `sent`).
- **The tone gate's other rules:** B22 sits in its own section with no precedence conflict. A message that is both a self-stop and agent-addressed is cited by whichever rule the judge picks. Both are reviewed by the same gate.
- **The only `router.send` caller** is the `/messages/send` route. No internal system relied on same-agent messages staying `sent`. Verified by grep.

## 6. External surfaces

- Agents gain a working session-to-session path. Sessions may now receive `[AGENT MESSAGE]` blocks typed into their prompt from sibling sessions. This goes through the same safety checks already used for cross-agent delivery.
- Users see fewer internal messages in their topics.
- CLAUDE.md grows by one short section.

## 7. Multi-machine posture (Cross-Machine Coherence)

Machine-local by design: the same-agent branch only fires for `machine: local` (or this machine's id) and types into a tmux session on this host. A target session on another machine still goes through the existing cross-machine route, unchanged. B22 runs wherever the outbound gate runs, which is per-machine and stateless.

## 8. Rollback cost

A plain revert. No stored data format changes: message envelopes already supported `delivered`, `queued` and `failureReason`. The CLAUDE.md section, once migrated, stays as harmless text after a revert.

## Conclusion

Ship. Found problems, triaged:
- Telegram-origin recovery re-runs the outbound LLM gate on every retry and delivers on the first pass. A held message can therefore be laundered by nondeterminism. Seen in this incident: pass, then advisory, advisory, pass. Goes to the feedback queue (not blocking this fix).
- The Echo-local desk-wake line that said "coordinate … with topic 130715" is fixed in the agent home, outside this repo.

## Second-pass review (if required)

**Reviewer:** independent reviewer subagent (general-purpose, fresh context)
**Independent read of the artifact:** concern, then resolved.

The reviewer raised two points:
1. The artifact wrongly claimed a human-input check (in production it is a stub), and nothing stopped typing into another agent's or the operator's tmux session on the same host.
2. A first-try delivery skips the post-injection watchdog.

Resolution:
1. Added the `isOwnSession` ownership guard. A non-owned target is `failed`, never typed. Unit test, plus a wiring test on the production server. The artifact now states the human-input stub accurately.
2. Documented in §5 as existing, shared behaviour, with its consequence (the block stays visible at the prompt). Not changed.

The reviewer also confirmed: no double delivery; B22 is citable and advisory with the migration on or off; the migration is idempotent; the Layer-3 escalation disclosure is accurate.

## Evidence pointers

- Incident: server-stderr tone-gate rows 15:35/15:37/15:57/16:11Z for topic 130715. The desk pane shows `telegram-reply.sh 130715` with the 739-character text.
- Live probe: `POST /messages/send` same-agent → `{"phase":"sent"}`, still `sent` with 0 attempts a minute later.
- Tests: `tests/unit/message-router.test.ts` (3 new cases fail on the old code), `tests/unit/message-formatter.test.ts`, `tests/unit/messaging-tone-gate-b22.test.ts`, `tests/unit/PostUpdateMigrator-sessionHandoff.test.ts`, `tests/integration/messaging-routes.test.ts`, `tests/e2e/messaging-lifecycle.test.ts`, `tests/e2e/messaging-multi-agent.test.ts`.

## Class-Closure Declaration (display-only mirror)

No agent-authored-artifact defect in this repository. The instar defect is a code delivery gap in `MessageRouter`. The agent-authored defect (an Echo-local desk-wake instruction) lives in the agent home and was fixed there. B22 is a new rule, not a repair of an existing prompt.
