# Side-Effects Review — Work cards from the owner's phone

**Version / slug:** `phone-work-cards`
**Date:** `2026-11-17`
**Author:** `echo`
**Second-pass reviewer:** `independent reviewer subagent (concur, see below)`

## Summary of the change

Two owner-phone routes for the Work Board (spec `docs/specs/phone-work-cards.md`, commitments CMT-1931 and CMT-1930 under stage 2b, CMT-1841). `GET /mobile/work-board/cards/:id` runs the console's own single-card handler (one function with a path flag in `workBoardRoutes.ts`, `readOneCard`), so the phone gets exactly the board's card JSON with the console's visibility. `POST /mobile/work-board/cards` makes a card from a message: it is mounted in `mobilePermissionsRoutes.ts` behind the existing phone permission write gate, proven by a single-use challenge and a presence (Face ID) signature over the new action line `work-card-create <requestId> <draftHash>`, and stores `source { conversationKey, messageId }` exactly as the console's "Make a card" does. The create needs the write gate's existing preconditions (phone permission actions on, a console PIN set, an enrolled presence key). Before the proof it checks the board, the owner, an existing card for the request (removed / different draft refused; a true replay goes on), the source conversation (the shared `telegramTopicKnown` rule or a live app conversation, plus `deviceMayUse`), and the write's own checks as a dry run (`WorkBoardService.createCard(..., { dryRun: true })`). The card id is derived from the owner and the client request id, so a retry returns the same card (`replayed: true`) and writes nothing. A `preflight: true` mode answers the server-rebuilt draft, its hash and the line to sign, writing nothing. Files: `src/server/phoneWorkCards.ts` (new), `mobilePermissionsRoutes.ts`, `workBoardRoutes.ts` (`readOneCard`, exported `afterCardCreate` shared with the console create), `WorkBoardService.ts` (named card id for an owner person; `dryRun`; `shapeRefusal` shared by write and dry run), `routes.ts` (wiring), `mobilePairingRoutes.ts` (two owner-only allowlist rows), `CapabilityIndex.ts`, awareness entry, release note, tests. Tier 2 (owner write authority on a phone route). Size: ~8 source files changed + 1 new, ~330 LOC source, ~450 LOC tests. Effort: spec converged in 6 rounds (cap 6); see the convergence report.

## Decision-point inventory

- Phone permission write gate (`mobilePermissionsRoutes.ts` `writeGate` / `proven`) — pass-through, one new action kind `work-card-create` on the signed line set.
- `work-card-create` action line — add — exact-equality binding of request id and draft hash.
- Source conversation exists and is readable — add — refusal only, the same rule the app's write paths use.
- Idempotent replay / `request-id-reused` / `card-removed` — add — hash equality on the stored `created` record.
- `createCard` named id — modify — also accepted for an owner person (was agent only).
- Device allowlist — add — two owner-only rows; not in `TEAM_ROUTE_TIERS` (closed to team phones by default).

---

## 1. Over-block

- A conversation the serving machine does not know (a Telegram topic with no mapping, session or history here) is refused `404 source-conversation-not-found`, though the console on another machine could make the card. This is the same rule every phone send/upload/pin path uses, so the phone can make a card from exactly the conversations it can write to. App conversations replicate, so they are known on every machine.
- Slack messages are not accepted (`bad-source`), as on the console today.
- A retry after a lost answer asks Face ID again (Frontloaded Decision 2): a cost, not a refusal.

## 2. Under-block

- Two separate pairings of one phone to two machines of one agent, with the app sending one request id to both before replication, could write the same `created` key twice (newest wins in the fold). The app holds one pairing per agent and the device record and presence key are machine-local, so this is out of reach; recorded in the spec's multi-machine posture.
- The source message id is shape-checked, not looked up (the console does not look it up either).

## 3. Level-of-abstraction fit

Right layer. The proof is the existing phone write gate (not a new gate); the card write is the existing `WorkBoardService.createCard` (not a new store path); the read is the console's handler. The new module only holds the phone-specific parts (draft shape, hash, derived id, idempotency). The dry run reuses `createCard`'s checks and the write's shape function, so the preflight cannot drift from the write.

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [x] No — this change has no block/allow surface over agent behaviour, messaging or dispatch.

The refusals added are structural authentication and validation (signature/challenge equality, a hash equality, an existence check, shape checks), which the principle explicitly exempts. No brittle detector gains authority over agent behaviour.

## 4b. Judgment-point check (Judgment Within Floors standard)

No new static heuristic at a competing-signals decision point. Every check is an invariant: exact equality (signed line, hash), existence (card, conversation) or a shape. Limits are inherited: text limits are the board's owner-set limits; the read shares the board read's bucket; the create shares the taps' bucket; the 200-character message id is the console's stored bound.

## 5. Interactions

- **Shadowing:** the console's `GET /work-board/cards/:id` now runs the shared `readOneCard(false)`; same checks and body (no behaviour change). The console create now calls `afterCardCreate` (same two steps; the poke now runs before the card view is read, which reads nothing the poke changes).
- **Double-fire:** none; a replay runs the idempotent after-create steps again (conversation key derived from the card id; a poke only wakes the controller).
- **Races:** existence check and write in `createPhoneCard` are synchronous with no await between them; challenges are single-use and consumed before judgement.
- **Feedback loops:** none.
- PR #3364 edits `listBoard` in `workBoardRoutes.ts` (different lines). PR #3353 adds members to the same unions in `mobilePermissionsRoutes.ts` (one-line rebase for whichever lands second).

## 6. External surfaces

- Two new device routes for the Instar apps (contract in the spec). No change for other agents or the console's visible behaviour.
- Persistent state: ordinary work-card `created` records (`by.proof: 'presence'`, a value the store already accepts) and metadata-only audit rows (`work-card-created`, `work-card-replayed`, `refused`) in `state/mobile-permission-actions.jsonl`.
- **Operator surface (Mobile-Complete):** this IS the phone-completable surface for "Make a card" (the console already has it). The app button and sheet are the app builders' part under CMT-1841, with the route contract handed over in the PR.

## 6b. Operator-surface quality

No operator surface in this change (no dashboard file touched) — not applicable. Refusal bodies carry plain `message` text for the app to show.

## 7. Multi-machine posture (Cross-Machine Coherence)

- **Phone writes: machine-local BY DESIGN** (physical-credential locality): the device record and presence key the write gate reads live only on the paired machine, as for every phone write (`docs/specs/mobile-native-permissions.md` §5).
- **Cards: replicated** through the work board's existing journal kind (unchanged).
- **Source check:** app conversations from the replicated app conversation store; Telegram topics by the shared `telegramTopicKnown` rule.
- No user-facing notices, no URLs generated. No status surface changed (the CapabilityIndex endpoint list gains two lines).

## 8. Rollback cost

Revert and ship a patch. Cards made from a phone remain ordinary owner-written cards readable by the old code (`proof: 'presence'` is in the store's `By` type and validator for every record kind). No migration, no config, no agent state repair. The apps would see the two routes refused (404 route / allowlist), which the app shows as unavailable.

## Conclusion

The review and six spec rounds changed the design: done items are rebuilt as exactly `{id,text}` so an unsigned `certify` cannot reach the store; every refusal knowable from the request (owner, source, limits, credential, record shape, removed card, reused id) happens before Face ID through a dry run of the write and a preflight; a replay re-runs the idempotent after-create steps and skips the source check (recoverable after the conversation is deleted); a proposed fold change for cross-machine retries was dropped once the write was confirmed machine-local by credential locality. Clear to ship pending the second-pass concurrence below.

---

## Second-pass review (if required)

**Reviewer:** independent second-pass reviewer subagent (fresh context, read the artifact and the code)
**Independent read of the artifact: concur**

Concur with the review: every create goes through the existing owner-phone write gate and a single-use challenge bound to the exact `work-card-create` line, the stored card is built only from the signed projection, the console paths are unchanged in effect, the eight answers hold, and there is no signal-vs-authority violation. One small note, applied: Telegram source ids are now capped at 15 digits so `Number()` is exact (a longer id could only have been wrongly refused, never made a wrong card). The artifact also now names that the create needs phone permission actions on and a console PIN set (the write gate's existing preconditions).

---

## Evidence pointers

- `tests/unit/phone-work-cards.test.ts`, `tests/integration/phone-work-cards.test.ts`, `tests/e2e/phone-work-cards-alive.test.ts`, `tests/unit/work-board-wiring.test.ts`, `tests/integration/team-access-status-table.test.ts`.
- Spec convergence report: `docs/specs/reports/phone-work-cards-convergence.md`.

---

## Class-Closure Declaration (display-only mirror)

No agent-authored-artifact defect — not applicable. No self-triggered controller added.
