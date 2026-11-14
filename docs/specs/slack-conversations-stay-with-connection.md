---
title: "Slack conversations stay with their Slack connection (part 3a)"
slug: "slack-conversations-stay-with-connection"
author: "echo"
parent-principle: "Cross-Machine Coherence — One Agent, Robust Under Degraded Conditions"
eli16-overview: "slack-conversations-stay-with-connection.eli16.md"
status: "draft"
approved: true
review-convergence: "2026-11-07T00:58:00.000Z"
review-iterations: 2
review-completed-at: "2026-11-07T00:58:00.000Z"
review-report: "docs/specs/reports/slack-conversations-stay-with-connection-convergence.md"
approved-by: "echo, under its standing grant: part 3 of Justin's ask in Telegram topic 134088, 2026-11-06 14:11 PST (\"…swap machines and engines just like any other conversation\"), which for Slack is bounded by the Slack reply spec's named machine-local exception"
---

# Slack conversations stay with their Slack connection (part 3a)

## 1. Problem

Moving a Slack conversation's session to another machine leaves two live sessions on one conversation. The cause is that `POST /pool/transfer` takes any key as a string and drains through seams that read `Number(key)`. In `src/commands/server.ts`, around the drain wiring, a Slack routing key turns into `NaN`, and from there:

1. the session lookup finds nothing;
2. the idle read says quiet;
3. `terminateSession` answers `no-local-session`;
4. `SessionDrainRunner` treats that as nothing to close (`isNothingToClose`);
5. the target's claim lands while the old Slack session keeps running.

The same drain runs for every mover: `/pool/transfer`, the mesh `drain` from a router, and the overload shed's `drainMove`, which already picks owned Slack keys today.

A Slack conversation can't move anyway. Its replies need the Slack connection, a credential that lives on one machine (`docs/specs/slack-session-reply-relay.md`, "Multi-machine authority", `machine-local-justification: physical-credential-locality`). That spec planned a transfer-side refusal that was never built; only the reply route checks.

## 2. Design

1. **The drain refuses a Slack key, before anything happens.** `SessionDrainRunner.run` checks the key first: no fence, no transfer CAS, no suspend, no ledger hand-off, no close. A Slack key is a raw routing key (`SLACK_CHANNEL_ID_RE`, optionally `:<thread ts>`) or the `slack:` profile form (`isSlackConversationKey`). The drain answers a new status, `refused-slack-stays`, and audits `drain-refused` with reason `slack-stays-with-connection`. This covers every mover that drains: `/pool/transfer`, the mesh `drain`, and the overload shed. `/pool/transfer` stops on this status and never falls through to the pin.
2. **The pin reconciler never acts on a Slack pin.** `OwnershipReconciler` moves by pin without draining (Case A cooperative transfer, Case B claim, Case D adopt), so it would split a Slack conversation that still carries a pin, whether left from a move tried before this fix or replicated from an older machine. It skips Slack keys and counts them (`skippedSlackPins`). `pinStateOf` reports such a pin as pending with the reason "this pin is ignored".
   - **Caught mid-transfer.** A Slack record already in `transferring` (an older owner's move, or one in flight at upgrade) is driven by neither the pin loop nor the flag-gated unpinned pass. The owner aborts it back at once, whatever the flags. No machine ever claims a Slack key, so the conversation is neither split nor left queuing in `transferring`.
3. **The transfer route refuses it first, in words.** `POST /pool/transfer` checks the key before it proxies to the lease holder or plans anything, in both raw and `slack:` forms. A Slack key gets 409 `slack-stays-with-connection`: "This Slack conversation stays on the machine that holds your Slack connection." Where the ownership record names a machine, the sentence names it: "… stays on <nickname>, which holds …".
4. **The overload shed skips Slack keys** when picking what to move, so it never asks for a drain it will be refused (`ownedTopics` → candidates). A refused drain already counts as nothing moved, so this is only so the shed doesn't keep picking them.
5. **The phone says it.** The phone's controls answer, `summarizeControls`, gives a Slack conversation's Move row `state: 'stays'` and the sentence from point 3, without a machine name (the controls answer doesn't read the ownership record). App conversations keep part 1's "get it next" sentence until part 3b.
6. **Deliberately unchanged non-drain paths.**
   - **Stale-owner release.** When the owner machine has gone dark, there is no live session to split, and the next authenticated inbound re-homes the conversation.
   - **WS4 inbound placement.** A Slack event authenticated on another machine connected to the same workspace re-homes the conversation there.

   So operator and automatic moves of a Slack conversation are refused, and it re-homes only through those two paths.

## Constitution check

- **Cross-Machine Coherence (parent).** One conversation, one live session. The refusal removes a path that produced two.
- **An Instar Agent Is Always a Multi-Machine Entity.** Slack's exception is the named physical-credential exception in its own spec. This change enforces it where it was missing.
- **No Silent Degradation / A Refusal Stays a Refusal.** The drain answers a refusal, never "nothing to close", and the route says why.
- **Occam's Razor.** One check at the drain chokepoint covers all movers. The route check exists only for the words.

## Decision points touched

| Decision | Classification | Justification |
|---|---|---|
| Slack key recognition | invariant | Exact grammar, raw and `slack:` forms |
| Drain refusal for Slack | invariant | Fixed rule at one chokepoint |

## Verify the state, not its symbol

A refused move leaves the ownership record untouched (no CAS ran) and the session running. Tests read both.

## Maturation plan

- **test-agent-live:** unit and integration tests below.
- **fleet:** ships to all. Before this, a Slack move split the conversation. After it, the move is refused.
- **ladder:** not applicable: a refusal of an unsafe path.

## Open questions

*(none)*

## Frontloaded decisions

1. The refusal lives in the drain runner, so every mover that drains is covered (review of part 3, finding D6). The pin reconciler, the one mover that doesn't drain, gets its own skip.
2. The inbound queue's Slack delivery gap (`_drainLocalDeliver` refusing non-numeric keys) is left out. It is a separate acked-then-lost fix, tracked in part 3b's spec.

## 4. Security

The change only adds refusals.

## 5. Multi-machine posture

Mixed versions:
- **An older owner** still splits on a mesh drain until it updates.
- **An older lease holder** that gets `refused-slack-stays` from a newer owner still writes the pin, because its route predates the status. A newer owner's reconciler then ignores that pin, so nothing moves. The route-side refusal on a newer lease holder stops the operator path.

## 6. Tests

- **Unit:**
  - The drain runner refuses raw and `slack:` keys with no CAS, suspend or close. A Telegram key is unchanged.
  - Slack key recognition.
  - The reconciler skips Slack pins (no transfer or adoption); a Telegram pin still moves.
  - A Slack record mid-transfer is aborted back by its owner and never claimed by its target.
  - The controls answer's Slack Move row.
- **Integration:**
  - `POST /pool/transfer` with a Slack key, in every form, answers 409 with the sentence, without planning, proxying or writing.
  - A Telegram or app key passes the Slack check.

## 7. Agent awareness and migration parity

Part 1's awareness sentence "Moving to another machine is still Telegram-only" stays true. The capability entry adds: "A Slack conversation stays with the machine that holds the Slack connection; moves are refused."

## 8. Rollback

Revert. Slack moves split again.
