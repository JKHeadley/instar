# Side-Effects Review — A pending invite accept survives a restart as a notice; updates wait for it

**Version / slug:** `pairing-pending-survives-restart`
**Date:** `2026-10-20`
**Author:** `Dawn`
**Second-pass reviewer:** `Echo (approved the design before the build; asked again on the PR)`
**Spec:** `docs/specs/a2a-pairing-invite-link.md` (approved r3), §8 (a pending item survives a reload and a restart).

## Summary of the change

A live walk on 1.3.1362 (pairing enforcing) showed the dashboard reload passes but a server restart silently loses an invite waiting for the recipient operator's approval: threadline-core's `PairingInviteFlow` keeps `pendingAccepts` in an in-memory Map so the invite secret S and the MAC key K never reach disk. The card also kept a stale red "Could not reach the agent: Failed to fetch" box after the server came back. Three parts:

1. `src/threadline/PairingPendingAcceptMarkers.ts` (new): `PairingPendingAcceptMarkers` persists a secret-free marker per pending accept (sha256 of the iid, claimed agent and owner, expiry; file `threadline/pairing-pending-accept-markers.json`, 0600) and `MarkedPairingInviteFlow` (a subclass of the core engine, wired in `ThreadlineBootstrap`) writes it on `receiveInvite`, and reconciles it away after `approveAccept`, `declineAccept` and every `listPendingAccepts` (which is where the engine prunes expired accepts). At startup `convertAfterRestart()` turns unexpired markers into notices and drops expired ones. `routes.ts` adds `restartNotices` to `GET /threadline/pairing/invites` and `DELETE /threadline/pairing/restart-notices/:id`; `PairingInviteTelegram` sends each notice once (`telegramNotified`), retrying every minute until sent or expired, with the expiry in the owner's profile time zone when known. K and S stay exactly where the engine keeps them: the subclass reads only the engine's own secret-free listing.
2. `UpdateGate` gains restart holds (`setRestartHoldProvider`, `getActiveHolds`); `AutoUpdater.gatedRestart` consults them (automatic restarts only) and defers through its existing `recordRestartDeferral` + `scheduleDeferredRestartRetry`, re-checking at min(5 min, soonest hold end + 1 s). `server.ts` registers the engine's `restartHolds()` (one per pending accept, `until` = invite expiry).
3. `dashboard/pairing.js`: restart notices render first in the pending section with a Dismiss button; a "could not reach" / "could not load invites" error is remembered and cleared by the next refresh the agent answers (200 or 503), unless another message has replaced it.

Files: `src/threadline/PairingPendingAcceptMarkers.ts`, `src/threadline/ThreadlineBootstrap.ts`, `src/threadline/PairingInviteTelegram.ts`, `src/server/routes.ts`, `src/core/UpdateGate.ts`, `src/core/AutoUpdater.ts`, `src/commands/server.ts`, `dashboard/pairing.js`, tests.

## Revision after Echo's review (bounded hold)

Echo found the hold was bounded only by the invite's `exp`, which the INVITER writes: core 0.1.0 (pinned from npm, so not changed here) checks only that `exp` parses, and `INVITE_MAX_TTL_MS` (24 h) is applied in `createInvite`, never on receipt. An invite with `exp` in 2099, forwarded and left unapproved, would have held every automatic update until 2099. Three fixes, all on the Instar side:

- **Refused on receipt** (`MarkedPairingInviteFlow.receiveInvite`, the Instar wrapper, chosen because core is pinned): an invite whose `exp` is more than `INVITE_MAX_TTL_MS` + 5 min skew ahead is refused with the named reason `EXP_TOO_FAR_REASON` before the engine sees it. No pending accept, marker, notice or hold is created. This covers the dashboard paste and the Telegram forward, which both call this method.
- **Clamp** (defence in depth): each hold's `until` is `min(exp, firstSeen + INVITE_MAX_TTL_MS)`, where firstSeen is when this engine recorded the accept (or first listed it, if it entered some other way).
- **maxDeferralHours**: the hold path now stops holding once this version's durable deferral (`restartDeferral.firstDeferredAt`, whatever started it) is older than the gate's `maxDeferralHours` (4 h default). It logs that, and the re-check lands at that ceiling. Holds can therefore never exceed the session gate's own ceiling, and a server restart does not reset the clock.

## Decision-point inventory

- `AutoUpdater.gatedRestart` restart-hold check — **add** — automatic update restart deferred while a hold is in force (bounded by the hold's `until`).
- `UpdateGate.getActiveHolds` — **add** — which holds are in force (until > now; a throwing provider holds nothing).
- `PairingPendingAcceptMarkers.convertAfterRestart` / `reconcile` — **add** — which markers become notices, which are deleted.
- `PairingInviteTelegram.deliverRestartNotices` — **add** — send a notice once.
- Dashboard `clearStaleConnectionError` — **add** — clear only a connection error still on screen.
- The invite engine's own decisions (accept, decline, expiry) — **pass-through**, unchanged.

---

## 1. Over-block

The only blocking surfaces are the restart hold and the receipt check. An automatic update restart is delayed while an invite waits, at most until the soonest of: the invite's expiry, 24 h after it was first seen, and the gate's maxDeferralHours (4 h) from the version's first deferral. The receipt check refuses an invite claiming more than 24 h + 5 min of life; a genuine invite made by `createInvite` can never exceed 24 h, so only a recipient clock more than 5 min behind could see a real 24 h invite refused. An operator who wants the update right away can use the manual apply (`POST /updates/apply`, dashboard Update button), which is not held. An invite the operator has forgotten holds updates for up to its lifetime; that is the trade the design accepted (losing the invite is worse than a delay of at most its own lifetime).

## 2. Under-block

- A restart not driven by the auto-updater (a crash, the lifeline's health restart, a manual `instar server restart`, a machine reboot) is not held. Those are exactly the cases the notice exists for: the invite is lost, and the operator is told.
- The hold is consulted only on the recipient machine running the engine. Another machine of the same agent restarting is irrelevant (it does not hold the invite).
- A manual apply proceeds through a waiting invite by design; the notice then covers it.

## 3. Level-of-abstraction fit

The marker lives in Instar, not in threadline-core: Instar pins core 0.1.0 from npm, and the brief and Echo's design keep K strictly in the engine's memory, unchanged, so the engine is subclassed rather than edited. The hold plugs into the AutoUpdater's existing deferral path (the durable `restartDeferral` row, the retry timer, the status field) instead of adding a parallel restart controller; `UpdateGate` already owns "is a restart safe now", so the hold registry sits beside its session classification.

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [ ] No — this change produces a signal consumed by an existing smart gate.
- [ ] No — this change has no block/allow surface.
- [x] Yes — but the logic is a structural invariant, not a judgment call: "an invite waiting for approval exists in memory and expires at T". The engine is the authority on whether one waits; the updater only delays, never cancels, and the delay ends at T by construction.
- [ ] ⚠️ Yes, with brittle logic.

No content is inspected and nothing is refused to a user or peer. The hold reads a fact the engine already holds.

## 4b. Judgment-point check (Judgment Within Floors standard)

No new static heuristic at a competing-signals decision point. The hold condition is enumerable (a pending accept exists and has not expired), and its bound is the invite's own expiry.

---

## 5. Interactions

- **Shadowing:** the hold check runs after the same-version cooldown and the cascade dampener and before the restart-window and session gates. A dampener batch re-enters `gatedRestart` later and meets the hold then. The session gate is unchanged; when both a hold and sessions block, the hold's reason is recorded first and the session gate is consulted on the next retry.
- **Double-fire:** the hold reuses the single `deferralTimer`; `scheduleDeferredRestartRetry` clears any previous timer, so there is never a second retry loop. Restart notices on Telegram: a single-flight flag stops two concurrent deliveries (found by a test: the constructor's delivery and a second call both sent it), and `telegramNotified` stops a second server start from re-sending.
- **Races:** the marker file is written with tmp + rename. The engine prunes expired accepts in `listPendingAccepts`; the subclass reconciles markers right after, so the marker never outlives the accept by more than one listing (the dashboard polls every 10 s and the hold re-check lists too). At startup `convertAfterRestart` runs before the engine exists, so no live accept can be mistaken for a cleared one.
- **Feedback loops:** none. The notice never creates an accept; re-pasting is a person's act.

## 6. External surfaces

- Telegram: one new message per cleared, unexpired invite, to the operator topic (the same topic as finish prompts). Sent once.
- Dashboard: a notice at the top of the pairing card; `GET /threadline/pairing/invites` gains `restartNotices` (an additive field); new Bearer route `DELETE /threadline/pairing/restart-notices/:id` (dismissing grants nothing).
- Persistent state: `threadline/pairing-pending-accept-markers.json` (0600), holding only a hash id, claimed names (self-described, max 120 chars each) and the expiry. Deleted when empty.
- AutoUpdater: `restartDeferral.reason` / `currentBlockers` may now name `pairing-invite:<8 hex>` holds.
- **Operator surface (Mobile-Complete):** the only new operator action, Dismiss, is a dashboard button; re-pasting uses the existing paste box or Telegram forward.

## 6b. Operator-surface quality

1. **Leads with the primary action?** Yes: the notice is the first card in the pending section and says what to do (paste it again below, or forward it on Telegram) and by when. The paste box it points to is already on the card.
2. **Zero raw internals as primary content?** Yes: the notice shows the claimed agent and owner names and "N min left". The hash id appears only as a data attribute for the Dismiss button, never as text.
3. **Destructive actions de-emphasized?** Dismiss is a quiet button (`mnd-btn-quiet`) and only removes a reminder.
4. **Plain language + phone width?** The sentence reads "An invite from the agent that calls itself Scout, which says it belongs to Justin, was waiting for your approval and was cleared when the agent restarted." It reuses the existing `pair-card` styles, which already stack at phone width.

## 7. Multi-machine posture (Cross-Machine Coherence)

**Machine-local by design.** A pending accept exists only in the memory of the machine whose engine received it (the one holding the Threadline identity and relay), and its marker describes that machine's restart, so it is not replicated. The restart hold applies to that machine's updater only, which is the machine that would lose the invite. The Telegram notice is sent by that machine only, once per invite, so no other machine can duplicate it. No URLs are generated.

## 8. Rollback cost

Pure code revert. The marker file is ignored by older code (it can be deleted; it holds reminders only). A held restart resumes at the invite's expiry in the worst case. No migration.

## Conclusion

The review produced one design change: a single-flight guard on Telegram notice delivery, after a test showed two overlapping deliveries both sent the message. The hold is bounded by each invite's expiry, uses the existing deferral path, and does not apply to manual applies. Clear to ship.

---

## Evidence pointers

- `tests/unit/threadline/pairing-pending-accept-markers.test.ts` — marker lifecycle, no secret on disk, restart → notice with expiry, Telegram once, expiry → no notice, re-paste, dismiss, corrupt file, restart holds.
- `tests/unit/AutoUpdater-restart-holds.test.ts` — held while pending (durable record, log line), released when the accept finishes, bounded by expiry (retry fires at the end), manual apply not held, the real engine end to end; `UpdateGate.getActiveHolds`.
- `tests/unit/dashboard-pairing-panel.test.ts` — notice first, not counted as a decision, Dismiss, the connection error clears itself, other messages stay.
- `tests/e2e/threadline/pairing-invite-production-path.test.ts` — a real restart of the recipient's server and Threadline on the same state dir, over a real relay.
- Mutation results: see the PR body.

---

## Class-Closure Declaration (display-only mirror)

- **`defectClass`:** `unbounded-self-action` — **`closure: n/a`**. No new self-triggered controller: the hold only DELAYS the AutoUpdater's existing restart through its existing single retry timer, each delay ending at the hold's `until` (≤ the invite's expiry, ≤ 24 h). The Telegram notice is sent at most once per invite (`telegramNotified` latch + single-flight), with a one-minute retry that stops when it is sent or the invite expires.
