# Side-Effects Review — document decisions (Approve / Decline on documents)

**Version / slug:** `document-decisions`
**Date:** `2026-11-17`
**Author:** `echo (session echo-doc-approvals, topic 144190)`
**Second-pass reviewer:** `independent reviewer subagent (see Second-pass reviewer response)`

## Summary of the change

A document can carry one question for the owner. The owner answers Approve or Decline in the Instar iPhone app on a native sheet with biometric Face ID; on a computer the page's Approve/Decline buttons send the question to the phone ("Confirm on your phone"). The answer is a replicated, owner-phone-signed `decision` row bound to the exact version and question; every machine re-verifies it. The app then posts the owner's own message ("Approved version 2 of …") through the existing chat route, and a machine-written `decision-delivered` row records that it arrived. Needs-you lists documents waiting on the owner; the session-start documents block and a fixed `[document decision]` notice tell the session. Writes wait until every recently heard peer can read the new row kinds.

Spec: `docs/specs/document-decisions.md` (Tier 2, converged in 6 rounds, approved by echo-chief-of-staff as maintainer, message d8599a32). Source: `src/documents/{rows,fold,decisions,access,originCheck,docpageAuth,service,sync,store}.ts`, `src/server/{documentRoutes,documentPageRoutes,AgentServer,memorySessionGuard,mobilePairingRoutes,needsRoutes,CapabilityIndex}.ts`, `src/core/{MobilePush,types}.ts`, `src/commands/server.ts`, `dashboard/docs/{doc-page.js,doc-page-model.js,doc-page.css}`, `dashboard/console/needs-model.js`, `src/data/awareness/document-decisions.md`. App part: `apps/instar-ios` branch `echo/doc-decisions`.

## Decision-point inventory

- `mayDoDocument(..., 'decide')`: owner phone with approvedVia telegram-dm / owner-phone / dashboard-pin; everyone else no.
- Accepting machine's approval-root walk (`documentDecisionRoot`): Telegram root; PIN root only when the agent has no Telegram owner; refuses computers, browsers, missing links, agent-introduced and local-install roots.
- `originCheck.checkDecision` on every machine: owner phone, device signature over the exact body, approvedVia not owner-agent/local-install.
- `DocumentService.checkDecision`: open ask, matching question hash, single latest version, supersedes equals the current answer.
- Peer gate (`documentDecisionWritesBlockedBy`): writes refused while a peer heard from in 7 days lacks `documentsDecisionRows`.
- Delivered receipt: only a finished 200 chat record whose stored outcome is delivered.

## 1. Over-block

- An owner with only a PIN-paired phone on an agent that HAS a Telegram owner cannot decide (by design: the PIN is readable by the agent). The page and the app say to pair through Telegram.
- A Mac cannot decide on its own (self-declared computer); it sends the question to the phone.
- A peer heard from in the last 7 days that never updates blocks writes for up to 7 days; the 409 names it.
- The approval-root walk refuses a phone whose approving phone record is missing on this machine.

## 2. Under-block

- A deliberately malicious agent could forge a Telegram approval or a registry entry (it runs the bot and the registry); stated honestly in the spec, as in the viewer spec. Hardware attestation is the real fix.
- `deviceKind: computer` is self-declared, so the Mac exclusion stops honest Mac apps only.
- Biometrics-only is the app's own rule; the presence key accepts a passcode.

## 3. Level-of-abstraction fit

Asks and decisions are rows in the document's own stream (the same layer as comments and the Face ID move), re-verified by the existing origin check. Delivery reuses the chat route through the app (no new server path speaks as the owner). Needs-you is a new source in the existing list. The peer gate uses the existing seamlessness-flag heartbeat.

## 4. Signal vs authority compliance

Required reference: docs/signal-vs-authority.md. Every block here is an authority boundary or an exact fact (who signed, which version, which question, which peer flag). The Needs-you row, the push and the `[document decision]` notice are signals; the agent is told to act only on the record (`GET /docs/:id/decision`). No heuristic or model holds authority.

## 4b. Judgment-point check

One judgment-candidate value: the 2,000-character question default (WRITE_DEFAULTS pattern; refused with words, never cut; the owner may tighten it).

## 5. Interactions

- New row kinds: older builds ignore them and hold later rows from that writer; the peer gate prevents writing until peers read them.
- `store.onApplied` is a new listener hook; it is wrapped so a listener can never refuse a row.
- The documents block's change key now includes decision words, so a decision re-sends the block to app conversations.
- `approvedVia` defaults for phone records with no field changed from `'phone'` to `'telegram-dm'` (matching `MobileDeviceKeys` and the key-ledger backfill); nothing compared against `'phone'`.

## 6. External surfaces

New routes (documents-gated): agent `POST /docs/:id/decision-ask`, `POST /docs/:id/decision-ask/close`, `GET /docs/:id/decision`, `GET /docs/decisions/waiting`; phone `GET /mobile/docs/:id/decision`, `POST /mobile/docs/:id/decision/challenge`, `POST /mobile/docs/:id/decision`, `POST /mobile/docs/:id/decision/delivered`; page op `decide-on-phone`. Push kind `document` gains `decide`. Needs-you gains `document-decisions`. App needs build with the native sheet (announced by number).

## 6b. Operator-surface quality

Surfaces: the document page's decision panel (`dashboard/docs/doc-page.js`, `doc-page-model.js`, `doc-page.css`), the Needs-you row (`dashboard/console/needs-model.js`), and the app's native sheet.
1. **Leads with its primary action:** the panel sits at the top under the title (not after the document), with the question and Approve as the primary button, Decline beside it; on a phone width the buttons go full width. The Needs-you row reads "Decide: <title>" with the question beneath and opens the document.
2. **No raw internals as primary content:** no row keys, hashes, ask ids or request ids are shown; status reads "Approved by you · 10:42 · version 2", "Sent to Security", "Not sent to the conversation yet".
3. **Destructive actions de-emphasized:** there is nothing destructive; Decline is the secondary style and asks for an optional reason; "Change your answer" appears only after an answer.
4. **Plain language at phone width:** every state has a plain sentence with the next step ("Confirm on your phone: your approval is waiting there for Face ID", "No phone can confirm decisions yet. Pair your phone…", "Open in the Instar app to decide"); never a dead end (maintainer condition). Checked at 390×844 and 1280×728 in the live proof.

## 7. Multi-machine posture

Asks, decisions and receipts are unified (replicated rows, re-verified). The decision is taken by the machine the phone is paired with (it holds the presence key). The notice comes from whichever machine applies the row and runs the session. Challenges and held notes are machine-local and short-lived.

## 8. Rollback cost

Revert the commit: no new rows are written. Rows already written are unknown to the reverted build and hold that writer's later rows until a forward build; the upgrade note says not to roll below this release once decisions exist.

## Second-pass reviewer response

Independent reviewer subagent, 2026-11-17: **CONCUR**. No path writes or shows a `decision` row without the owner's phone and a valid presence signature; the `'phone'` → `'telegram-dm'` default widens nothing but the `decide` rule, which stays gated by the root walk and presence; page JS uses textContent only.

Its non-blocking findings and what was done:
1. Delivered receipt not tied to the decision → fixed: the receipt must name the current decision and either its derived request id or a message linking the document; malformed request ids answer 400.
2. Peers trusted the row's `proof` → fixed: peers refuse `proof: telegram` from a PIN-approved device and `proof: pin` from a Telegram-approved one.
3. A revoked phone's decision rows are refused by a machine that catches up after the revocation (as moves are) → stated in the spec's limits.
4. Browser `approvedVia` default inconsistency → fixed (a browser with none stays unknown).
5. Unguarded pool read → fixed (an unreadable pool refuses with a reason).
6. Push volume → accepted: one push per ask, per version after a Decline, per press; MobilePush's fold and hourly bounds apply.
7. Session notice prefix → now `[system:document-decision telegram:N]`, never the inbound user prefix.
8. Wording in the shared gate refusal → left (cosmetic).
The delivered-outcome check it flagged mid-review is now a pure function (`chatRecordDelivered`) with a unit test over every recorded outcome.
