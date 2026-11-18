---
title: "Document decisions: Approve and Decline on documents that ask for one"
slug: "document-decisions"
eli16-overview: document-decisions.eli16.md
author: echo
created: 2026-11-17
parent-principle: "The Person Decides; the Agent Does the Rest (STANDARDS-REGISTRY)"
origin: "Justin, 2026-11-17 09:58 PST, topic 141385: 'for documents that presents something that needs approving, they should include an \"approved\" button that sends the approval to the appropriate conversation and marks the document as approved'. Brief: .instar/autonomous-briefs/144190-document-approvals.md (topic 144190)."
builds-on: "docs/specs/instar-document-viewer.md (Instar Documents, PR 3053)"
lessons-engaged: "operator-session-is-not-human-proof (a decision needs the owner's phone with Face ID, §3.2); Verify the state, not its symbol (the message is a signal, the replicated row is the decision, §7); P21 multi-machine (rows replicate; writes wait until every peer reads them, §6); Structure beats willpower (the documents block re-sends on a decision, §3.5; Needs-you lists open asks, §3.7); No silent degradation (an undelivered decision is shown, §3.4); work in other repositories has an owner (§5); Signal vs. Authority (Needs-you and the push are signals; the row is the authority, §3.7)"
review-convergence: "2026-11-17T18:54:23.406Z"
review-iterations: 6
review-completed-at: "2026-11-17T18:54:23.406Z"
review-report: "docs/specs/reports/document-decisions-convergence.md"
cross-model-review: "codex-cli:gpt-6-astra"
single-run-completable: true
frontloaded-decisions: 9
cheap-to-change-tags: 0
contested-then-cleared: 7
approved: true
approved-by: "echo-chief-of-staff (maintainer, not constitution text)"
approved-at: "2026-11-17T19:02:00Z"
approval-source: "agent message d8599a32-55e1-4a70-9181-06c1e4bbe147 from session echo-chief-of-staff, 2026-11-17: 'approved: stamp approved:true and build' with two conditions: one-tap Approve on the web/Mac document that says Confirm on your phone, never a dead end; live proof of web -> phone -> conversation -> document on Echo before Justin is told"
---

# Document decisions

## 1. Problem statement

The agent often writes a document to put a decision in front of the owner: "ship this hardening?". Today the only control on the page is **Send comments to Echo**. On 2026-11-17 Justin approved the Secret Drop hardening document by typing "approved" in a different topic (security, 143457); the session that owned the document found it there by luck. Nothing on the document recorded the answer, nothing tied it to the version he read, and a later version would have looked exactly as approved.

Justin asked (09:58): a document that needs approving should carry an **Approve** button that sends the approval to the right conversation and marks the document approved.

## 2. What exists (read from code, main e97358818)

- **Documents** (`src/documents/`) are an append-only replicated row stream. Every row is machine-signed. Rows for the owner or a person carry the device's signed request (`signedOrigin`); every machine re-verifies it (`originCheck.ts`). The strongest existing owner action, **moving** a document, needs the owner's phone with a Face ID presence signature (`checkMove`, `documentPageRoutes.ts` moveGate). Peers verify the device signature and that the device is the owner's phone; the presence signature is checked by the machine that took the request (presence keys are not replicated).
- The trust root under "this key is the owner's" is machine-written: the phone binding and the key-ledger activation with its `approvedVia` (`telegram-dm | owner-phone | dashboard-pin | owner-agent | person-phone | local-install`). `dashboard-pin`, `owner-agent` and `local-install` approvals rest on material the agent can read (the PIN in config; another agent; a ticket in the agent's own state folder).
- The document page's code is served by the agent's own server, so in a browser any action signed by the page's key is as trustworthy as the agent itself. In the app, the page asks the app to sign thread actions; comments and Send are composed **natively** so a tampered page cannot get them signed.
- **Native Send** posts a template message through the owner's device-signed chat route (`POST /mobile/chat/:topicId` or `/mobile/chat/app/:key`), which applies every inbound check (authority tokens, credential policy, rate limit, request-id idempotency, pool routing, signed origin), then writes the `send` row.

## 3. Proposed design

### 3.1 The ask is data on the document

A document asks for a decision when it carries an open **ask**: one question in plain words ("Ship the Secret Drop hardening?").

- Only the agent sets or withdraws an ask: `POST /docs` and `POST /docs/:id/versions` accept `decision: { question }`; `POST /docs/:id/decision-ask { question }`; `POST /docs/:id/decision-ask/close`. The caller needs `revise` standing on the document. Setting an ask is the agent asking the owner; people answer, they don't ask (a person who wants a decision from the owner writes it as a comment).
- Rows: `decision-ask { askId, questionHash }` and `decision-ask-close { askId }`, writer `agent` only. The server mints `askId` (a UUID); the fold ignores a second `decision-ask` with an `askId` already seen.
- At most one ask is open: a new ask closes the open one in the same request. The ask in force is the **newest `decision-ask` in fold order** (the same on every machine); if it is closed there is no open ask. An older ask never comes back, even if the newest is withdrawn: replaced is permanent. If two machines open asks concurrently, the one later in fold order wins; the other shows as "replaced by a newer question", cannot be answered, and any answer already on it stays on record. Product meaning, from Justin's words "marks the document as approved": a document has one state. Several independent decisions are several documents, or one question that lists them.
- The question is stored as a blob like any text. Write default 2,000 characters (`WRITE_DEFAULTS.questionChars`, a judgment-candidate default the owner may tighten, like `titleChars`); a longer question is refused with "Put the detail in the document" (never cut). The sheet shows it in full and scrolls.
- **Lifecycle.** The ask stays until the agent withdraws it or opens a new one. Whether the owner is being asked is derived: no answer yet, answers that crossed (3.2), or the current answer is a Decline on an older version. An **Approve** ends the asking (a later revision shows "Approved version 2", no new prompt; the agent opens a new ask to ask again). A **Decline** keeps it: the agent revises and the owner decides on the new version. The owner may change an answer at any time while the ask stands (Approve → Decline asks again; Decline → Approve ends it).

### 3.2 Only the owner's phone, with Face ID, decides; on the exact version and question

- A decision is made in the **Instar app on the owner's phone**, on a **native confirmation sheet**, never by the page. Not on a Mac in v1: a Mac device record is phone-class (`deviceKind: computer`, `client: phone`), and a Mac that hosts or is driven by the agent could satisfy a password fallback; the Mac app shows the browser path ("on your phone"). The sheet shows what the app itself fetched with its device key (`GET /mobile/docs/:id/decision`): document title, version label, the question, the verdict, and the note box for Decline. Face ID, then the app signs.
- Route pair, the same pattern as the move: `POST /mobile/docs/:id/decision/challenge { askId, onVersion, verdict, questionHash, noteHash, supersedes }` → a single-use 60 s challenge bound to that exact line; then `POST /mobile/docs/:id/decision` with the same body plus `challenge` and `presenceSig` (and the note as a salted blob when there is one). Device-signed (`instar-device-v1`), in `DEVICE_ALLOWLIST`, over local TLS or the tunnel.
- Who may: an active owner device with `client: 'phone'`, not `deviceKind: computer`, with a presence key enrolled, whose **approval root** qualifies. The root is found by the accepting machine by following `approvedBy` through its own device records to the first device not approved by another phone; the walk refuses if any device on it is a computer (`deviceKind: computer`, which is self-declared at pairing, so this stops honest Mac apps, not a forged record), a browser, or missing from the records ("pair this phone again through Telegram") (a record with no `approvedVia` predates the field and was approved in Telegram, as the key ledger's backfill already says). The root must be `telegram-dm`. An agent with **no Telegram owner configured** (read from the accepting machine's own Telegram configuration) also accepts a `dashboard-pin` root (no stronger root exists there; refusing would remove the feature and add no protection); such a decision is labelled "decided on a phone paired with the dashboard PIN". `owner-agent` and `local-install` roots never decide. The app's Face ID uses biometrics only (`.deviceOwnerAuthenticationWithBiometrics`, no passcode fallback). That is the app's own rule: the presence key itself is created with `.userPresence`, and the server cannot see which was used.
- Refused: browsers (the page code is the agent's), Macs, team people of every tier, the bearer token and every agent session. `mayDoDocument` gains op `decide` (owner phone with `approvedVia` ∈ {telegram-dm, owner-phone, dashboard-pin}); the route adds the root and presence checks; `originCheck` repeats on every machine what peers can verify: owner device that is not a browser, signature over the exact body, `approvedVia` in the set above (peers cannot see `deviceKind`; the Mac and chain checks are the accepting machine's). Peers cannot follow `approvedBy` (it is not in the replicated key ledger); the root check is the accepting machine's, like the presence check. The row records which root it rested on: `proof: 'telegram' | 'pin'`, stamped by the accepting machine.
- Only the machine the phone is paired with holds its presence key, so the decision goes to that machine (the app's route for that agent), whichever machine holds the lease.
- The server accepts only when: the ask is open; `questionHash` is that ask's; `onVersion` is the document's single latest version as this machine holds it (more than one head → `409 concurrent-edits`, "Echo is merging two edits; decide once it has"); `supersedes` is the current latest decision on that ask (or null when there is none); the challenge and presence signature verify.
- Row `decision { askId, onVersion, verdict, questionHash, noteHash?, supersedes?, proof }`, actor `owner-phone`, `signedOrigin` = the phone's whole device-signed request (domain `instar-device-v1`), like `primary-set`. `originCheck.checkDecision`: the device is the owner's phone with an allowed `approvedVia`; the signature verifies over `POST /mobile/docs/<id>/decision` and the body; the body names exactly the row's fields, a `challenge` equal to `requestId`, and a `presenceSig`. A missing `noteHash` in the row equals 64 zeros in the body.
- **Changing an answer** writes a new row naming the one it replaces (`supersedes`), checked by the accepting machine so nothing is overwritten blind. The current answer is the ask's **last decision row in fold order** (topological over docDeps, ties by origin then seq: the same on every machine). Answers crossed when another answer on the ask exists that the current answer's row had not seen (by its docDeps) and that nothing supersedes; the page and `GET /docs/:id/decision` say `crossed: true` ("Two answers crossed. One is shown; confirm again."), and the agent asks before acting. Answering again from a machine that holds both clears it everywhere (the new row has seen them); a later-arriving unseen answer reopens it.
- **Staleness.** A decision counts for its `onVersion` only. A version the decision row had not seen whose label is not past the answered one (a concurrent sibling, not a later revision) makes the page say "version M was written at the same time". After a later revision the page says "Version M is not approved (approved: version N)".
- Replays: the challenge is single-use; a replayed request carries the same request id and is read at the lowest row key on every machine (the existing rule); the row's version and question are signed.

### 3.3 What the page shows (web and in-app)

- **Open ask, latest version:** a decision panel at the top, under the title (the question and the controls), so the action is visible on arrival.
  - In the app: **Approve** / **Decline** post a bridge message `{type:'decide', docId, verdict, versionId}` naming the version the page is showing; the app fetches the decision state itself, and if the latest version is not that one it says "This document changed since you opened it" and reloads the page instead of opening the sheet. Otherwise it opens its native sheet (3.2). The app announces support on load with `{type:'hello', ops:[…,'decide']}`; with no `hello` (an older app) the panel says "Update the Instar app to decide here."
  - In a browser (and in the Mac app): **Approve** and **Decline** stay on the document, one tap each, labelled "You confirm on your phone with Face ID". A tap sends a signed docpage request `decide-on-phone {docId, askId, verdict}` that pushes "A document asks for your decision" to the owner's phones with the chosen verdict, so the app opens its Face ID sheet already set to it (3.7). The panel says what happened: "Confirm on your phone: your approval is waiting there for Face ID", "sent a moment ago", "No phone can confirm decisions yet — pair your phone from Telegram, then tap again" (no deciding phone on this agent), or "Your phone could not be reached — open this document in the Instar app, or tap again" (never a dead end). A browser that cannot ask the phone (PIN-only) shows "Open in the Instar app to decide" with the app link. Maintainer condition (echo-chief-of-staff, 2026-11-17): the button lives on the document, never "go find it in the app". then re-reads page data at 5 s, doubling to 60 s, for 10 minutes or until three reads fail in a row; then "Reload to see your answer".
- **Answered on the latest version:** "Approved by Justin · 10:42 · version 2" or "Declined · version 2 — <note>", plus "Sent to <conversation>" / "Not sent to the conversation yet" (3.4). In the app: **Change answer**.
- **Answered on an older version (Decline, or an approval superseded by a new ask):** "You declined version 2. Version 3 has changes — decide on version 3." The buttons show again.
- **Viewing an older version:** "Open the latest version to decide."
- **Anyone else** (team members, guests, a PIN-only browser): read-only status: "Waiting for Justin's decision", "Approved by Justin · …".
- The footer bar shows the decision state as a chip next to Send comments; at 390 px the panel stacks and the chip moves above the bar.
- Errors use the existing words: `409 not-serving` → "Messages aren't being received right now. Try again shortly."; `409 version-changed` → "Version 3 arrived while you were reading. Read it, then decide."; `409 concurrent-edits` as in 3.2.

### 3.4 Delivery: the owner's own message, sent by the app

The message is sent by the app, through the owner's existing device-signed chat route, like native Send. No server path speaks as the owner.

1. After the decision row is written, the decision route answers `{ rowKey, sendPath }`.
2. The app composes and **freezes** the message at that moment, from the fields its sheet showed: `Approved version N of "<title>": <link>` / `Declined version N of "<title>": <link> Note: <note>`. The title is cut to one line of 80 characters and quoted (it is document text, not the owner's words); the question is not repeated (the session reads it from the record). A note longer than the chat limit (4,000 characters minus the template) is cut with "(full note on the document)"; the row's note is never cut. The first request id is **derived from the decision row** (`messageRequestId` in the decision answers: the row's time plus a v4-shaped id from sha256 of the row key, the only form both chat routes accept), so any retry, a reinstalled app or a lost answer re-derives the same id and the chat route's record makes it exactly-once. The app stores text, id and destination with the decision.
3. The app sends it **the way native Send already sends its message** (the same client and route for that conversation). A Telegram topic's chat route answers `not-serving` on a machine without the messaging lease; the app then tries the agent's other machines it knows from `GET /mobile/routes` (each route verified as the same agent, as the app already does for routing), so a decision taken on a standby is delivered through the serving machine. The page's "Sent to your phone" reflects the push from the machine serving the page. Every chat-route check applies (authority tokens removed, credential policy, rate limit, topic known, signed origin: the history shows it as the owner's signed message). If no machine is serving, the app shows "Not sent yet — try again shortly" and keeps Send now.
4. When the chat route answers delivered (status 200 with outcome `delivered`, or an app conversation's `forwarded`/`delivered`; never `refused`, `intercepted`, `sentinel-pause`/`sentinel-kill` or a 202 `waiting`), the app posts `POST /mobile/docs/:id/decision/delivered { rowKey, requestId, text, sendPath }` to **the machine that took the chat message** (it may differ from the paired machine that took the decision; both hold the replicated document). That machine looks up its own chat request record for (this device, requestId, the text's payload hash under `sendPath`, which must be the document's current or a former primary: the app stores the destination with the frozen message, so a move between decision and send never leaves a delivered message marked unsent); only a finished 200 record whose stored outcome is `delivered`/`forwarded` counts (a sentinel interception, e.g. a note read as "stop", is shown as "Not sent: held by the stop check" and the owner can rephrase and Send again). The request store is a file on that machine, so Send now retries on the machine that took the first attempt. It then writes a machine row `decision-delivered { decisionRow, messageRequestId }`, replicated, so every machine shows "Sent to …".
5. If the app has no stored message for a decision (it crashed or lost the answer right after the row was written), it finds the decision on reopening (`GET /mobile/docs/:id/decision` shows the owner's current answer with no delivery) and composes the message from the record by the same template, then continues from step 3.
6. If the app is closed or offline between steps, the document shows "Not sent to the conversation yet" and, on the phone that decided, **Send now** repeats steps 3–4 with the frozen text and id (the request store makes it exactly-once). After 24 hours the derived id can no longer be accepted; Send now becomes **Send again** with a fresh id, offered only while there is no `decision-delivered` row and labelled "may already have arrived" when the first attempt's outcome is unknown. A chat-route `outcome-unknown` is shown as "may already have arrived — check the conversation".

The agent does not depend on the message: the decision is in its documents block (3.5) either way.

### 3.5 What the agent gets

- The message, as the owner's own signed message in the document's conversation.
- `GET /docs/:id/decision` (bearer or a session with read access): `{ ask: { askId, question, questionHash } | null, decision: { askId, verdict, versionId, versionLabel, latest, at, note, delivered, rowKey, proof } | null, crossed, waitingOnOwner, concurrentVersionLabel, concurrentEdits }`.
- **The session-start documents block** (server-rendered, `renderSessionContext`) adds the decision state per document ("Waiting for Justin's decision", "Approved version 2 by Justin", "Declined version 2: <note>"); its change key includes the decision state.
- **A mid-session notice:** whichever machine takes in a verified decision row (written there or synced in) and runs a live session for the document's Telegram topic injects one fixed line (a system notice, never the owner's voice): `[document decision] <verdict> version N of doc <id> by the owner's phone; confirm with GET /docs/<id>/decision`, once per row and only for fresh rows (a restart never replays old ones). So the session hears even if the owner closed the app before their message went out. App-conversation sessions get the decision in the documents block on their next message.
- Awareness entry (`src/data/awareness/document-decisions.md`): put a decision in a document with `decision: {question}`; when an "Approved:" or "Declined:" message or the documents block shows one, confirm with `GET /docs/:id/decision` and act on the version and question it names; on Decline, revise and the owner decides again; open a new ask for a new decision. `CapabilityIndex` documents entry gains the routes.

### 3.6 The iPhone and Mac app

App work (`apps/instar-ios`, built and shipped by me, §5):
- `GET /mobile/docs/:id/decision`, the challenge and decision routes, the delivered route (`DocsData` paths and body builders, unit-tested like the move's).
- Native confirmation sheet reusing the move's Face ID presence flow (`PermissionActionFlow.enrol`, `PresenceKey.sign`).
- Bridge: handle `{type:'decide'}`; post `{type:'hello', ops}` on load; after a decision, dispatch `refresh` to the page.
- Message composition and send through the existing chat send path; **Send now** for an undelivered decision.
- Push: the `document` kind with `decide: true` opens the document (the existing handling opens it already; the flag only changes the alert words).

### 3.7 Needs-you, push and the Work Board

- **Needs-you:** a new source `documentDecisions` in `NEED_SOURCES`, read from `GET /docs/decisions/waiting` (owner reach; an agent session gets ids only for shared documents, never their titles or questions, as the viewer's owner-reach rule says): every document where the owner is being asked (3.1, derived, not "ask open"), row "Decide: <title>" opening the document. A signal only (the row is the authority). It clears on Approve, on a Decline until the next version, and on withdrawal.
- **Push:** `PushTrigger` kind `document` gains `decide: true` with its own recipient check (owner phones whose root may decide; no `commentKey` needed) and its own fixed alert ("A document asks for your decision", under the agent's name), with `decide` in the payload so the app opens the document. Whenever the owner starts being asked (an ask opens, or a version lands after a Decline): dedupe `doc-decide:<docId>:<askId>:<versionId>`. On `decide-on-phone`: dedupe per press (`doc-decide-press:<docId>:<requestId>`), so the button always reaches the phone; MobilePush's fold and hourly bounds still apply and their answer is shown on the page. The alert carries no document text (the existing push rule).
- **Work Board:** not used. A Work Board card is a unit of work with done-items and its own conversation; a document ask is a question about a text. The decision row is the document's own record with the same proof the Work Board requires for an owner decision (presence), and no card is created for an ask, so there is no second record to keep coherent. If an agent separately made a card for the same work, it updates that card with its existing routes after reading the decision.
- **Approval-as-Data (`ApprovalLedger`): not appended.** The ledger computes auto-approval eligibility from approved-as-is ratios. Approves could be written, but Declines cannot (the ledger needs an operator-sourced divergence category, and choosing one for the owner breaks its authority rule), so an approve-only feed would show 100% agreement by construction: a counter that reports success without measuring it. The document rows are the record; joining them to the ledger needs the owner to classify declines, which belongs with the ledger's own surfaces.
- **PR 3297** (`owner-decision` notification category) is about outbound buttons the owner must answer; nothing here sends such a button.

## 4. Decision points touched

| Decision point | Classification | Basis |
|---|---|---|
| Who may decide (`decide`: owner phone, presence, approvedVia ∈ {telegram-dm, owner-phone, dashboard-pin} everywhere; the accepting machine requires a Telegram root, or a PIN root on an agent with no Telegram owner) | invariant | basis: irreversible-consequence; evidence: an approval lets the agent ship or act; a wrong yes cannot be taken back, and devices approved via the PIN, another agent or a local ticket rest on material the agent can read |
| Decision row writer and origin re-check | invariant | basis: irreversible-consequence; evidence: same boundary, held on every machine from signatures |
| Version and question binding | invariant | basis: enumerable-domain; evidence: the version DAG and the open ask are exact facts in the rows |
| One open ask per document | invariant | basis: enumerable-domain; evidence: a frontloaded product decision from Justin's words "marks the document as approved": one document, one state; several decisions are several documents or one question that lists them |
| Who may set an ask (agent with revise standing) | invariant | basis: enumerable-domain; evidence: the ask is the agent's request to the owner |
| Whether the owner is being asked (derived: no answer, or a Decline on an older version); an answer is accepted while the ask is not withdrawn or replaced | invariant | basis: enumerable-domain; evidence: the states of one ask, folded from its rows |
| Delivery (app sends; owner-initiated retry only) | invariant | basis: external-constraint; evidence: the chat route's request store makes a retry exactly-once; no background loop |
| Writes wait while a recently heard peer cannot read the new rows | invariant | basis: external-constraint; evidence: an older build ignores the kinds and holds every later row from the writer (store.ts ingest), for every document, until it updates |
| Question length default (2,000) | judgment-candidate | floor: refuse with words, never cut; arbiter: the owner may tighten it (WRITE_DEFAULTS pattern) |
| Push dedupe (per ask and version; per browser press) | invariant | basis: external-constraint; evidence: MobilePush fold and hourly bounds; one prompt per thing to decide |


## 5. Work in other repositories

The app part (3.6) lives in `apps/instar-ios` (local repository in the agent home). I build it, cut from the branch the last shipped build came from (memory: ios-build-must-contain-last-build), and announce the build number in topic 144190. On this run's completion bar.

## 6. Multi-machine posture

- **Visibility follows the question:** a decision is shown only to readers who see its ask (the fold's withholding cascade, like replies under a comment), and a delivery receipt only with its decision, so nothing about a question withheld across a move reaches a reader through its answer.
- **Asks, decisions, deliveries: unified** — rows in the document's replicated stream (vector pull and push), re-verified by `originCheck` on every machine. Any machine's page and documents block show the same state.
- **The machine that takes the tap** is the one the phone is paired with (it alone holds the presence key); it need not hold the lease. If it is asleep the app says so and the owner decides when it is back. Delivery goes through the chat route (3.4). A machine missing the newest version answers `409 version-changed` once it has it; before that, the decision is shown stale by the docDeps rule (3.2).
- **Transition (reader first).** An older machine ignores an unknown row kind and then holds every later row from that writer, for every document, until it updates (recoverable: the next sync re-sends them). So this release teaches every machine to read the four new kinds, and writing any of them (`decision-ask`, `decision-ask-close`, `decision`, `decision-delivered`) is refused with `409 peers-updating` ("<machine> needs the update first") while a peer heard from in the last 7 days has not advertised the `documentsDecisionRows` seamlessness flag (last-known flags count). The flag is advertised by every build that reads the rows, whatever the documents switch says. A peer silent for 7 days does not block; when it returns it holds that writer's rows until it updates (its auto-update), stated in `/docs/health`. A one-machine agent writes immediately. Rollback of the writer is a plain revert; rolling a machine below the reader release once decision rows exist reintroduces the stall (stated in the upgrade note).
- **Challenges:** machine-local, 60 s, single-use (like the move's).
- **Interim, until SEC-088 (peer-verifiable owner standing).** Replicated activation fields (`approvedVia`, keys from the activation ledger) can be written by any machine, so they never count as proof that the owner decided. A decision row is applied only on the machine holding the phone's own enrollment: an active owner phone whose key matches, not revoked, and whose own Face ID key re-verifies the row's presence signature (`localPresenceKey`, `originCheck` `checkDecision`). There the document shows Approved/Declined, Needs-you clears and the conversation's session is told. Every other machine first checks the phone's device signature and that the row says exactly what was signed (an unsigned or altered row is refused), then holds it (`held`, hidden as `origin-held`): its page keeps the owner's Approve and Decline and adds a note that an answer from the phone is waiting for confirmation, its Needs-you item stays, and it tells no session. The note is advisory only: a machine that can write activation and binding rows can still mint a device that produces a held row, so a held row never removes the owner's buttons (that residual stays tracked under SEC-088). Design concurrence: echo-instar-security, message ce420fed-bb9c-4812-b7cc-70c47eaed3b4 (design, not a code audit; the peer-verifiable proof stays tracked under SEC-088).

## 7. Verify the state, not its symbol

| Symbol | State it claims | Corroboration | Unmeasurable |
|---|---|---|---|
| "Approved: …" message | The owner approved that version and question | The owner-signed, presence-checked `decision` row (`GET /docs/:id/decision`) | No row → not approved |
| Page banner / documents block | Same | Folded from verified rows only (held and pending rows hidden; only a device-verified `origin-held` row adds the advisory note; no held row hides buttons) | Rows pending → "waiting" |
| "Sent to <conversation>" | The session received the message | `decision-delivered`, written only after the chat request store says delivered | No row → "Not sent yet"; outcome unknown → "may already have arrived" |
| Needs-you row | An ask is open | The fold of the rows | Source unreadable → "could not check" (the Needs-you contract) |

## 8. Security

- **The agent, a hijacked session, the bearer token, a PIN-reading session:** cannot decide by any normal path. A decision needs a biometric Face ID presence signature from an owner phone whose approval chain ends in Telegram; the agent holds neither the device key nor the presence key, and the page it serves cannot get the app to sign a decision (the app signs only from its own sheet, from fields it fetched itself). Honest limit, as in the viewer spec: the agent runs the Telegram bot and the device registry, so a deliberately malicious agent could forge a Telegram approval or a registry entry; such a forgery is a deliberate act visible in signed rows, not an accident. The real fix is hardware attestation (App Attest) and passkeys, tracked by those projects.
- **A laundered phone:** a phone approved by a PIN-approved phone records `owner-phone`; the accepting machine follows `approvedBy` to the root and refuses it on an agent with a Telegram owner.
- **No Telegram:** on an agent with no Telegram owner, a PIN root is accepted and labelled, because nothing stronger exists there.
- **Revoked phone:** a machine that receives a revoked phone's decision rows after the revocation refuses them (as for moves), while machines that took them earlier keep them; the agent acts on its own machine's record.
- **Machine key:** a holder of a machine key could forge a binding, an activation or the `proof` stamp. That is the foundation's existing limit (stated in the viewer spec).
- **Replay onto a newer version or another question:** version and question are in the signed body; the challenge is single-use and bound to the exact line.
- **Members in a shared conversation:** cannot decide (no op, no writer); they see the status. They cannot set asks (agent-only).
- **Offline phone:** nothing queued. The tap fails visibly; the owner decides again online, on whatever version is then latest.
- **Text:** the delivered text is the verdict, version, quoted one-line title, link and the owner's own note, frozen by the app and passed through every chat-route check. Agent-written text (the question) is never sent in the owner's voice; the session reads it from the record.

## 9. Tests

- Unit: row validation and writers for the four kinds; `mayDoDocument('decide')` for every principal and approvedVia; fold (one open ask, duplicate askId ignored, approve closes, supersedes chain and crossed answers, docDeps staleness, delivered); peer `checkDecision` accepts a valid owner phone request (Telegram, owner-phone or PIN approval) and refuses a person device, a browser, an agent-introduced or local-install approval, a body/row mismatch, a missing presenceSig; the accepting machine's root walk accepts a Telegram root, a PIN root only with no Telegram owner, and refuses a laundered PIN chain, a Mac or a missing link; service decide (latest only, concurrent heads, question mismatch, supersedes mismatch); the peers-updating gate; messageRequestId derivation; renderSessionContext lines and change key; Needs-you source rows; page model status words and which controls show.
- Integration: challenge + decision routes with a real device key and presence key (as the move tests do); refusals (browser, PIN phone, member, wrong version, stale challenge); delivered route against the chat request store; agent ask routes; `GET /docs/:id/decision`; `decide-on-phone` push trigger.
- E2E: the production `AgentServer` wiring: decision routes alive (not 503) with documents on; the chat request store dep is the real store; Needs-you source answers.
- App: `DocsData` unit tests for paths, bodies, the presence line and the message template.

## 10. Live proof (before "done")

Throwaway agent with documents on: the document page at 390×844 and 1280×728 shows the panel and "Approve or decline on your phone"; a decision made from an owner phone (the iOS simulator with a real device key and presence key) appears on both web sizes; the topic's session receives the owner's message; Needs-you shows and clears; Decline then a revision prompts again. Then on Echo, before Justin is told it is ready (maintainer condition): the full path web Approve → phone Face ID sheet → owner's message in the conversation → document marked, on the real iPhone build announced by number. Justin's first real decision on Echo is a tracked commitment (a Needs-you item from a real decision document, not sent 23:00–07:30 PT), because only his own Face ID can make it.

## Open questions

*(none)*

## 11. Frontloaded Decisions

1. Replicated rows, not a side store.
2. The decision is native, phone-only, with Face ID; browsers route to the phone.
3. The app sends the message through the chat route; no server path speaks as the owner.
4. The accepting machine checks the approval root (Telegram; PIN only on an agent with no Telegram owner); agent-introduced and local-install roots never; phones only, biometrics only.
5. Asks are agent-only; one open ask (concurrent asks: the newest in fold order); an Approve ends the asking, a Decline keeps it; answers can change while the ask stands.
6. Work Board not used (§3.7); Needs-you lists open asks.
7. Reader-first transition behind the `documentsDecisionRows` peer flag.
8. No new feature switch: rides the Documents dev gate.
9. ApprovalLedger not appended (an approve-only feed would fake agreement, §3.7).

## 12. Rollback

Revert the writer: no new rows are written; existing ones stay readable on every machine at or above the reader release. The upgrade note says not to roll a machine below the reader release once a decision row exists.

## Maturation plan

Rides the Documents dark gate (`DEV_GATED_FEATURES: documents`): on wherever documents are on.

- **test-agent-live:** the §10 scenario on a throwaway agent: web at 390×844 and 1280×728, the iOS simulator with a real device key and presence key, the session receiving the owner's message, Needs-you showing and clearing.
- **dev-agent-live:** Echo, with Justin deciding on real decision documents from his queue for a week.
- **fleet:** with Documents (instar-document-viewer's maturation plan); decisions add no switch of their own.
- **graduation criterion:** on Echo, at least five real decisions made from the phone, every one recorded on the document with the right version, delivered to the right conversation (or shown "Not sent" and then sent), and zero decisions accepted from anything but the owner's phone.
- **ladder:** documents
- **dark-window:** if decisions are not used on Echo within 14 days of merge, record why on the Maturation board with a new date.

## Left behind

- A glossary of the viewer spec's terms (fold order, docDeps, place) for readers without it (round 6, precision).
- The peer gate's worst case (a peer heard from within 7 days that never updates blocks writes for up to 7 days) shown only in the `409` and `/docs/health`; a Needs-you line naming the machine is a later refinement (round 6, precision).
- Crossed answers need two phones on two machines; kept because the rule is cheap and deterministic (round 6, precision).

- PIN-approved phones still write comments and Send (the foundation's rule refuses only PIN-approved browsers): sent to the feedback queue as its own instar defect.
- Delivery to a second session when the asking session's place differs from the primary: asks are set by the agent with revise standing; a confined session's revise standing is its own place, so the asker is the primary's session. An owner-reach session asking on an owner-only document gets the decision through the documents block and `GET /docs/:id/decision`.
