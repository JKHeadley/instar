# Side-effects review: messages reach the session that holds the role now (PR-A, same machine)

## Summary

Spec `docs/specs/messages-reach-renamed-sessions.md` (converged after 6 rounds, approved by the Chief of Staff on 2026-11-18). This PR builds §A, §B, §C (local), §E and §F. Cross-machine delivery (§D) is PR-B, built on this one.

| Part | What this PR does | Where |
|---|---|---|
| §A | New pure resolver: given a session name, finds the one running session that holds that role now | `src/messaging/sessionAddressResolver.ts` |
| §B | Same-agent delivery calls the resolver, pins the chosen session before typing, and refuses with a reason | `MessageRouter.deliverSameAgentLocal` |
| §B | Retries, the watchdog and the ACK timeout act only on envelopes for this machine. Retries go to the pinned session and fail with `resolved-session-ended` when its id changed | `DeliveryRetryManager` |
| §C | `SenderNotifier`: one notice per sender per minute, fixed template, exact-name senders on this machine only, a counter for everyone else | new module |
| §C | `/messages/send` forces `from.agent`/`from.machine` and refuses a caller-made `delivery-notice` | route |
| §C | New `delivery-notice` message type | types |
| §E | `chooseTmuxName`/`tmuxNameFor` stops the doubled prefix at the three naming sites | `SessionManager` |
| §F | Awareness entry | `src/data/awareness/` |

Tier 2. About 700 LOC including tests. Effort: spec review 6 rounds (at the cap; the scope was cut in round 5). Build: first commit attempt.

## 1. Over-block

- **Respawn handoff.** A message written before the only holder of its role started is refused (`role-respawned-after-message`). That includes a handoff where the old session already stood down. This is a deliberate trade, frontloaded in the spec: the sender gets a notice and can resend.
- **Ambiguity.** When two sessions could hold the role, the message is refused instead of guessed. Today such a message would have failed anyway, as a non-running exact name.
- **Topic held elsewhere.** A topic held on another machine is refused here (`topic-not-held-here`), the same outcome as today.

Nothing that is delivered today is refused by this change, with one deliberate exception: a message to the exact name of a session whose conversation is standing down (it moved to another machine) is now refused, because a standing-down session must not take new work (the spec's stand-down exclusion). Any other exact-name delivery to a running session that started before the message was written behaves exactly as before.

## 2. Under-block

- The `from.session` an HTTP caller writes is still its own text. A bearer-token holder can aim a notice at any exact-name local session. They can already type anything into any local session through `/messages/send`, so this adds nothing.
- Envelopes for another machine are left untouched by local retries. Until PR-B they keep today's behaviour: queued to an outbound folder that nothing drains. PR-B fixes that.

## 3. Level-of-abstraction fit

The resolver sits where the existing ownership gate decides whether to type, so it is the one place same-agent delivery picks a session. Notices go through the same `MessageDelivery.deliverToSession` that types every message. Naming is fixed at the single helper all three spawn paths now use.

## 4. Signal vs authority

No new blocking authority. The only authority involved, refusing to type into a session that isn't this agent's own, already exists (`isOwnSession`). The resolver only picks among this agent's own running sessions, and on two candidates it refuses rather than guesses. The freshness refusal is a deterministic floor, classified invariant in the spec because typed text cannot be recalled. Notices and counters are signals. Reference: `docs/signal-vs-authority.md`.

## 5. Interactions

- **Retry manager.** It used to retry every same-agent envelope, including the sending machine's copy of a cross-machine message, which it typed into a local session of the same name. It is now scoped to this machine's envelopes. Its TTL sweep is unchanged except for the new `holdForRemoteNotice` hook, which PR-B uses.
- **Watchdog.** It reads the pinned session, so a redirected message is never re-typed into the dead old name.
- **`onDeadLetter`.** It fires only for messages that were never typed. Typed messages that are never acknowledged (types whose `ACK_TIMEOUT` is null) used to be dead-lettered by TTL, and that stays silent.
- **Stand-down registry.** Read through `isEnforcing(getByTopic())`, a read-only lookup. It does not call the release path that the Slack muzzle arm uses.
- **The existing wiring test.** It asserts the exact `isOwnSession` line, which is unchanged.

## 6. External surfaces

- **`/messages/send`.** `from.agent`/`from.machine` are now forced, and a caller's other values are kept in `from.requested`. Type `delivery-notice` returns 400.
- **`GET /messages/stats`.** Gains `undelivered`.
- **`GET /messages/:id`.** Gains `delivery.resolvedSession`, `resolvedSessionId`, `resolvedVia`, `typingStartedAt`, `noticePending` and `noticeSentAt`.
- **New tmux names.** A name that already starts with the project prefix is no longer doubled. `echo-echo-x` sessions keep their names while they run, and the resolver treats the two forms as one role.
- **The awareness entry.** It tells agents what a delivery notice is.

## 7. Multi-machine posture

- **Resolver (§A) and delivery (§B): proxied.** Each machine resolves against its own running sessions, which is where the target lives.
- **Notices (§C local): proxied.** Only a sender on this machine is ever typed into; the remote notice leg is PR-B.
- **Naming (§E): machine-local.** `machine-local-justification: hardware-bound-resource` (a tmux name is a process on that machine's own tmux server).

No new replicated state.

## 8. Rollback cost

A revert restores today's behaviour:

- **Data.** The new optional delivery fields and the `requested` field are ignored by older code.
- **Notices.** A `delivery-notice` envelope already stored is read as an unknown type and expires.
- **Session names.** Sessions started under a plain (non-doubled) name keep it until they end, and old code addresses them by exact name.

No migration.

## Second-pass review

(appended below)

Second pass (independent reviewer, 2026-11-18 06:30 PT). First answer: "Concern raised: chooseTmuxName only guards one direction". A bare name could land on a tmux name another role held. That is fixed: both directions are checked, with a numbered fallback, and a test covers it. Minor notes were also fixed: `provenSender` requires `from.agent` to be this agent, and this artifact now names the standing-down refusal. Re-check: "Concur with the review."
