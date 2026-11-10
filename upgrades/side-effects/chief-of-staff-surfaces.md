# Side-effects review — Chief of Staff PR 4: the pinned conversation and the surfaces (dev-gated)

**Spec:** docs/specs/chief-of-staff-topic.md §1.4, §3, §4, §6, Migration and rollout (converged, approved 2026-11-09). Builds on PR 3 (#3005).
**Tier:** 2 (user-visible: a new Telegram topic with an external pin, app and dashboard fields, an owner-only inbound drop, a PIN-gated route, a CLAUDE.md template line).
**Change size:** new `src/messaging/ChiefOfStaffTopic.ts` (~150 LOC); `StateManager` system-topic key; `TelegramAdapter` (`TOPIC_STYLE.CHIEF`, `pinTopicMessage`, `unpinTopicMessages`, `cos:` tap dispatch + `onChiefOfStaffTap`); server (`ensureChiefOfStaffTopicFor` at both boot sites + both adoption closures, owner-only drop in the inbound handler, tap wiring, note buttons, loop signer); `ChiefOfStaffStore.foldTreeState`; loop `tree()`, `checkIn()`, fresh lease in `status()`, `sendNote(text, actions)`; `mobileConversationRoutes` (`pinned` + `parentConversationKey`, owner-only); `AgentServer` provider; routes (`conversationKey`/`displayName` on `GET /chief-of-staff`, `POST /chief-of-staff/check-in`); console (`chats-model` `listPinned`/`orderWithTree`, `needs-model` entry + `chiefOfStaffNeedRows`, `chats.js` need card + tree render, CSS); CLAUDE.md template line + registry row; site page section. Tests: unit (topic 10, tree 5, console models 8, surfaces wiring 8, needs first-screen fixture), integration (app surface 4, check-in 2), e2e (alive + system-topic listing).
**Effort:** build attempts 1.

## Summary
The Chief of Staff gets a place to live and the owner gets ways to see and answer it. The topic is created once by the lease holder while the feature is on, its greeting pinned inside it (the Bot API cannot pin a topic in the forum list), renamed with `displayName`, unpinned (kept) on rollback; standbys adopt it through the existing system-topic adoption. Only the owner's messages in it are routed; everything else is dropped and logged. The app list carries the pin and the tree for owner-role callers; the dashboard leads its conversations page with what the Chief of Staff needs, draws the tree, and offers the PIN-gated check-in; the note's Needs-you items carry one-tap buttons that the adapter owner-checks before the loop acts; a tap also renews the lease. The CLAUDE.md template tells every agent what to do when the owner starts an effort in that conversation.

## 1. Over-block
- **Owner-only inbound drop.** Any non-owner input in the CoS topic is dropped (members, guests, bots, relays, unverified senders). This is the spec's rule (§6). The one real cost: an agent with NO owner id configured drops every message in that topic — and the lease can never be renewed there either (spec §4 says the loop stays paused and the note says so). The drop is logged with the sender and the owner state so the cause is visible.
- **One-reader rule** (unchanged from PR 3) fails closed to DM; with buttons the DM path uses `sendOwnerDMWithButton`.
- **`cos:` taps** refuse anyone but the configured owner, including when no owner is configured.
No issue identified.

## 2. Under-block
- The check-in route trusts the dashboard PIN as the owner principal (spec §4: "a dashboard tap in an owner-authenticated console session"); a Bearer caller without the PIN gets 4xx. The PIN check is the shared `createMandatePinCheck` (sha256 + timingSafeEqual + per-IP attempts).
- The app-list fields are served to `person === null || person.role === 'owner'`; a Bearer read with no device person is the operator's own dashboard and is treated as owner. A team or MSP phone gets neither field.
- The topic greeting is sent through `sendToTopic`; if the notification gate holds it, the pin is deferred to the next boot and the outcome says so (never a silent unpinned topic).

## 3. Level-of-abstraction fit
The topic rides the existing system-topic machinery (state key + adoption loop + `findOrCreateForumTopic`), the taps ride the adapter's existing callback dispatch with the same owner-principal rule as tunnel consent, the app fields ride the existing paginated list (added after the peer merge so old builds are unaffected), the console entry rides `needs-model.js` so Home's count and the page cannot disagree, and the CLAUDE.md line rides the core-marker template regeneration (no new migration code).

## 4. Signal vs authority compliance
No judgment logic is added. The gates here are identity mechanics (owner principal, PIN) — the principle's carve-outs. The need rows are a read of the loop's folds.

## 5. Interactions
- **System-topic adoption:** a new kind means every standby's adoption read now carries it; `readSystemTopicIds` derives kinds from the key table, so no second list to update.
- **Inbound handler:** the drop runs after the principal is resolved and before memory-privacy and routing; it is a no-op until the loop is wired (`_cosOwnerOnlyTopicId` null).
- **Loop status:** `status()` now derives the lease from the records every call (a check-in reads live at once); the per-tick health fields are unchanged.
- **Note buttons:** `sendOfferList` (topic) / `sendOwnerDMWithButton` (DM) bypass the automation-reply path only when buttons exist — the same precedent as the offer list.
- **Console first-screen floor:** the chats page now loads `/chief-of-staff` before painting; a 503/500 yields no card (the page is unchanged for agents without the feature).

## 6. External surfaces
A Telegram forum topic + pin (external writes, gated on the dev-gate; nothing while dark). `pinned`/`parentConversationKey` on `GET /mobile/conversations` (owner-role only). `conversationKey`/`displayName` on `GET /chief-of-staff`. `POST /chief-of-staff/check-in`. A `cos:` callback family. A CLAUDE.md template line with the `<!-- instar:chief-of-staff -->` marker.

## 6b. Operator-surface quality
Console: the conversations page leads with the need card (title + sub + "+N more" + "Open Chief of Staff"), the pinned row is bold and first, sub-topics indent up to three levels. Verified by the first-screen test (`data-operator-need="chief-of-staff"` with an action, nothing before it). App: fields only; the app build that renders them is outside this repo.

## 7. Multi-machine posture (Cross-Machine Coherence)
Unified: the topic id is a system-topic key (holder creates, standbys adopt); the tree is a replicated record fold; the check-in writes a machine-signed renewal record every machine verifies; the app list's pinned/tree fields are computed on the answering machine from the same fold; the console reads the lease holder's status. Machine-local by design: `chief-of-staff-topic-name` / `-pinned` (holder-only bookkeeping for rename/pin idempotency; harmless to recompute).

## 8. Rollback cost
`chiefOfStaff.enabled: false` ⇒ the next boot unpins and keeps the topic, the app/console fields disappear (no loop ⇒ no provider ⇒ 503 on `/chief-of-staff`), the drop is a no-op, taps answer "not available", the template line is inert. Re-enable re-pins the same topic.

## Found problems (triage)
- Spec §1.2 "per-tick initiative reconcile" and §3 "go-to routing / binding drafts from a CoS message" are not in this PR → the maturation plan's next step (PR 5 with the pilot); the CLAUDE.md line already instructs the agent to draft bindings conversationally.
- CMT-1416 (durable note queue) and CMT-1417 (settle after failover) remain open (due 2026-11-16).

## Proportion
Tier 2, ~900 LOC incl. tests, 1 attempt. In line with a surfaces release.

## Second-pass review (Phase 5) and what changed because of it

Independent reviewer, 2026-11-09 14:52 PT: **"Concern raised: the conversations page is broken by an undefined `cursor` in `applyList`, and the Telegram pin can never land on a gate-live agent."** Both fixed before commit, with the should-fixes that were small enough; the rest are tracked.

MUST-FIX (fixed):
1. **`applyList` read an out-of-scope `cursor`** — a `ReferenceError` on every list load (feature on or off); `console-chats-page.test.ts` was failing 3/8 on it. Now `if (!more)`; that suite is green and the page keeps `pinnedKey` across "Show more".
2. **The greeting could never be pinned on a gate-live agent** — it was sent unstamped (held by the selectivity gate ⇒ no message id ⇒ "deferred" forever, one held copy per boot). Now the server passes a STAMPED send (`withNotificationEnvelope(stampNotification(), …)`, like the Attention intro), the delivered greeting's message id is persisted (`chief-of-staff-topic-greeting`) and a retry pins THAT id instead of sending again, and a held greeting is not re-sent for 24 hours. Tests: held once ⇒ no second send within 24h ⇒ sent and pinned after; pin failure ⇒ next boot pins the stored id with no send.

SHOULD-FIX closed here: (3) owner id normalised (`resolveApprovalOwner`) in the inbound drop, the renewal hook and the adapter's tap check — a string `ownerUserId` no longer drops the owner; (4) a forwarded `cos:` tap without the lifeline proof is refused 403 in the callback route (like the pairing buttons) — a Bearer holder cannot forge an owner tap; (5) the drop is no longer silent toward the sender: one plain line per sender per day ("only the owner can talk here" / "could not verify who sent this" / "no owner is configured"), and the note carries a Needs-you line while no owner id resolves; (6) the dashboard check-in now EXISTS: the need card has a Check-in button (PIN prompt → `POST /chief-of-staff/check-in`); (7) the page paints first and the need card fills in when `/chief-of-staff` answers (no blank page on a slow holder); (8) `tree()` and the status lease read a 2-second memo of the union instead of folding per request — the durable fix is store compaction, CMT-1415; (9c) the needs-row "off" branch now matches the shape production produces (`reason: 'switched off…'`), tested both ways; (11) the loop writes the CoS root `tree` record once its conversation exists (tested), so the tree has its root; (15) `_cosTopicId` requires id > 1 like every other reader.

Tracked / corrected, not in this PR:
- **(9a) behavioural test of the owner-only drop through `wireTelegramRouting`** and **(9b) a team/MSP device case on the app-surface test** — the drop is covered by a string assertion and the adapter's tap check behaviourally; both behavioural cases go with PR 5's test-agent-live proof, which drives the real Telegram surface (spec: Live-User-Channel Proof).
- **(6, app) no check-in path from the app** — device principals cannot reach `/chief-of-staff/check-in`; on a no-Telegram agent the dashboard is the only renewal surface until PR 5 adds the app route (spec §1.4 "lease renewal is by app or dashboard"). The fragment and the site page now say "dashboard".
- **(10) "pinned in the forum"** — the Bot API pins a message INSIDE the topic; it cannot float a topic in the forum list. The pin is the greeting pinned in the Chief of Staff topic; the top-of-list placement is the app's and the dashboard's. Wording corrected in the fragment and the site page; the spec's D-D is met by the app and dashboard.
- **(13) `ownerTap` confirm-done** closes without re-checking the deterministic items at tap time and without an `intent` record → PR 5 with the binding UI (where the checklist is editable).
- **(14) boot race** between the boot-site ensure and the adoption loop's `ensureOwn` on the holder (a 429 backoff on the first create could mint two topics) — the same exposure Attention/Updates carry today; find-or-create by name bounds it; tracked with the system-topic machinery, not this feature.
- **(17) `claudeMd.layout: "full"` agents** do not get the template line (no `migrateClaudeMd` entry) → noted for the CLAUDE.md layout migration; the default layout regenerates the core block.
- **(12)** button data stays under Telegram's 64 bytes for every key kind (worst case 57); the DM path lays buttons in one row via `sendOwnerDMWithButton` — acceptable for ≤3 buttons, PR 5 may switch to one-per-row.

## Class-Closure Declaration

- **defectClass:** `unbounded-self-action` — **closure:** `n/a` — **reason:** the only self-triggered sends this change adds are bounded one-shots with explicit brakes, not controllers: the owner-only drop notice is one line per sender per 24h (in-memory memo, event-driven by an inbound message, never retried); the topic greeting is sent at most once per 24h while held and never again once its message id is persisted (a retry pins the stored id); the note buttons ride the existing once-per-cadence note (ChiefOfStaffLoop, PR 3, capped by `noteCadenceHours` and `immediateMessagesPerDay`). No restart / respawn / kill / retry path is added.

## Second-pass verdict
Concern raised and resolved: the two MUST-FIX items are fixed with tests; seven SHOULD-FIX items are closed in this PR; the remaining items are corrected in the documents or carried to PR 5 / CMT-1415 as named above. The reviewer's "checked and found no issue" list (PIN gate semantics and ordering, Bearer-less 401, device allowlist on the CoS routes, peer rows sanitised so a non-owner pool read cannot inherit `parentConversationKey`, `pinned` computed locally, app key convention, rename edits the existing topic, read-only rollback writes nothing, DM and topic taps dispatched identically, `cos:` branch first) stands.

## Post-rebase addendum (2026-11-09): the lock-held spawn option
The executor spawns inside `withConversationLock`, which is not re-entrant, so this PR had switched the topic spawn between the locked and unlocked SessionManager entry by binding one or the other — which also moved the spawn call out of the literal shape the topic-profile wiring ratchet pins (`spawnInteractiveSession(bootstrapMessage, sessionName, {` followed by the per-topic effort spread). The switch is now an option: `conversationLockHeld: true` on the spawn options makes `spawnInteractiveSession` skip taking the lock it would otherwise take, the call keeps its literal shape, and the unlocked entry remains the only place that spawns. Same behaviour, one fewer bound-method indirection.

## Post-rebase addendum 2: write-domain declaration
Main's write-domain ratchet requires every mutating route to declare where its write converges. `POST /chief-of-staff/*` (the check-in here; bind, tap and triage in PR 5) is classified `machine-local` with a `ws2x-replicated` story: each call writes to this machine's own chief-of-staff journal stream, single writer by origin, replicated by journal sync and folded from the union everywhere; the journal is not on a git-synced path. Declaration only; no behaviour change.
