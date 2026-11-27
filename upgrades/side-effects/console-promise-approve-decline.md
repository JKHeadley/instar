# Side effects: Approve / Decline on a promise waiting for the operator

## Change
- `POST /commitments/:id/decide` `{decision: approve|decline, note?}` (Bearer, like the other
  commitment writes). Only a pending promise with `blockedOn` user-authorization or user-input
  is accepted (409 otherwise). Approve: `transitionState` to owner agent, blockedOn none.
  Decline: `withdraw` with "Declined by the operator in the dashboard[: note]". A replica
  forwards the same transition/withdraw to the owning machine (existing owner routing).
  The decision is posted in the promise's topic and handed to that topic's session as an
  inbound message marked `senderUnverified` (it binds no operator and carries no command
  authority) so the agent acts without the operator re-typing it.
- Console promise sheet: when a pending promise waits on the operator's authorization it
  shows Approve (primary) and Decline (quiet), each with one confirm; "Reply in the
  conversation" stays, as the quiet option for talking it through first.

1. **Over-block** — none; a promise not waiting on the operator is refused with a plain reason.
2. **Under-block** — the Bearer token can call the route, as it can already call /transition
   and /withdraw on the same record. The dashboard is PIN-unlocked; this adds no new power.
3. **Level fit** — reuses the tracker's own transition and withdraw.
4. **Signal vs authority** — the injected message is explicitly unverified; it informs the
   session, it does not bind an operator.
5. **Interactions** — the topic gets one visible line per decision. If no session is live,
   the normal inbound path starts one.
6. **External surfaces** — one Telegram line in the promise's topic.
7. **Multi-machine** — cluster-shared (owner-routed commitment mutation, registered in the
   write-domain registry); the Telegram line and the session hand-off run on this machine.
8. **Rollback** — revert; decisions already made stay as ordinary transitions/withdrawals.

## 6b. Operator-surface quality
1. Leads with the primary action: Approve is first and primary on a waiting promise.
2. No raw internals: the buttons and answers are plain words.
3. Destructive de-emphasized: Decline is the quiet button and asks once.
4. Phone width: the buttons sit in the existing sheet action row and wrap.

## Class-Closure Declaration
- `unbounded-self-action`: closure `n/a` — one-shot user-driven action, not a self-triggered loop: the operator's dashboard Approve/Decline tap posts one line and hands one message to the topic session.
