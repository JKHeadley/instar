# Side-Effects Review — Agent Health quiet by default

**Version / slug:** `agent-health-quiet-default`
**Date:** 2026-11-04
**Author:** Echo
**Second-pass reviewer:** independent reviewer agent

## Summary of the change

`TelegramAdapter` records Agent Health attention observations and holds Telegram delivery unless the producer sets `needsUser: true`. This covers creation, refresh and reopen paths. `sendToTopic` carries its HTML formatting choice through the standby relay to the holder. The server's holder wiring uses that choice. Tests cover the quiet record, later user need, recent WONT_DO suppression, system topic creation, and formatting relay. Tier 1; the PR adds two integration test files on top of the original patch. One focused failing run and one passing run preceded this correction, with one review iteration.

## Decision-point inventory

- `createAttentionItem` — modified — structurally classifies Agent Health as routine unless `needsUser` is explicitly true.
- `createOrReopenAgentHealthAttentionItem` — modified — holds a recurring routine condition.
- `sendToTopic` relay — modified transport metadata, no new delivery decision.

## 1. Over-block

An Agent Health producer that truly needs the person but omits `needsUser` will stay in the attention record. The producer must set that field after a bounded repair attempt. Existing Agent Health sources do not set it. The working-set and commitment expiry notices describe operations the agent can retry after a peer returns, while the tmux refresh is optional and disruptive; none is an immediate, phone-completable decision for the person. The expiry ledgers drop automatic retries, so their source-specific recovery and wording audit remain in #2738 <!-- tracked: 2738 -->.

## 2. Under-block

This is a lane slice, not the full approved selectivity gate. Automated sends outside Agent Health can still push. A producer can self-label `needsUser` without proof of exhausted self-healing. The general provenance gate and source audits remain tracked under #2738 <!-- tracked: 2738 --> (the existing spec also names CMT-1948).

## 3. Level-of-abstraction fit

The lane marker and `needsUser` are structured producer decisions already present in the attention type. The choice occurs after the durable store write and before either Telegram lane or hub routing. The full spec's last-hop gate will be the general authority; this narrow lane decision ships first to stop the observed flood.

## 4. Signal vs authority compliance

**Required reference:** `docs/signal-vs-authority.md`.

This is deterministic routing on typed provenance, not an inference from message text, priority, or a brittle detector. The source owns the semantic `needsUser` decision. The routing layer only applies it. No regex or keyword gets blocking authority.

## 4b. Judgment-point check

No new static heuristic at a competing-signals decision point. The source decides whether human action is needed; the adapter applies the declared classification. A later source audit must verify that producers reserve `needsUser` for exhausted self-heal.

## 5. Interactions

The hold runs before the old lane and hub paths, including `hubOnly` upserts. A held item remains in the attention store and gets a JSONL hold record. Reopening it does not post. A later `needsUser` transition on an open row sends once and clears the held marker; a recent WONT_DO stays closed and silent. A reverse transition updates the stored decision and holds further posts. An explicit Agent Health reopen now replaces a stale needsUser value when the new observation omits it. Real `/telegram/reply` traffic is outside this path. HTML relay forwarding changes presentation of caller-authored HTML, not the send decision.

## 6. External surfaces

Telegram loses routine Agent Health posts while the dashboard and attention API retain their records. Other agents retain their current behavior until this release reaches them; Echo's user instruction authorizes live behavior. No new operator action or URL is introduced. Standby-authored HTML now reaches the holder with its format mode.

## 6b. Operator-surface quality

No dashboard renderer or operator form changed. Existing attention views show the stored rows.

## 7. Multi-machine posture

The decision is applied on each machine before its outbound relay. Attention records remain machine-local observations and are read through the existing pool attention view; the lane topic itself is a unified system topic under the holder's lease. The formatting choice follows a standby send to the holder. User-facing sends still require the existing holder path, so one voice remains. No new URL or durable state store was added.

## 8. Rollback cost

A revert and patch release restores the old posts. Held observations remain in the existing attention store and the added hold audit lines need no migration. Already suppressed Telegram posts are not replayed automatically.

## Conclusion

The first slice is ready to ship on Echo. It stops the observed lane noise without touching replies or discarding records. The approved full selectivity design and source self-healing remain tracked work under #2738 <!-- tracked: 2738 --> (the existing spec also names CMT-1948).

## Second-pass review

**Reviewer:** independent reviewer agent. **Independent read:** The original reviewer found that repeated observations did not update the stored `needsUser` value. In this rebased pass, a reviewer found that held-to-actionable routing could bypass a recent WONT_DO; the route now requires an open row, and a regression test pins that behavior. The reviewer confirmed that this slice covers attention routing only and that direct sends remain for #2738 <!-- tracked: 2738 -->. The rebased review concurs with the WONT_DO fix and the documented producer disposition. Final verdict: concur.

## Evidence pointers

`tests/unit/attention-single-topic-routing.test.ts`, `tests/unit/telegram-tokenless-relay.test.ts`, `tests/unit/system-topic-single-creator.test.ts`, `tests/integration/agent-health-lane.test.ts`, and `tests/integration/notification-flood-burst-invariant.test.ts`. The two integration files reproduced all four local-verify failures before their expectations were updated and pass together (20/20); targeted unit tests pass (58/58), and full lint passed.

## Class-Closure Declaration

No agent-authored-artifact defect — not applicable.
