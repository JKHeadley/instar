---
title: "A stand-in owner chat for throwaway agents, so approver screens can be driven live"
slug: throwaway-owner-chat
author: Echo
tier: 2
status: draft
eli16-overview: throwaway-owner-chat.eli16.md
parent-principle: "Live-User-Channel Proof Before Done"
sibling-principles: "Know Your Principal — An Unverified Identity Is a Guess; Phones Belong to People; Test Identity Never Enters Production State"
parent-spec: "identity-security-piece3a-approver-in-owner-record.md and identity-security-piece3d-approver-recovery.md (their live proof)"
decision-source: "Chief of Staff, 2026-11-21 12:13 PST (agent message 1d8498bd): build a test-only code channel for throwaway agents, safe by construction: on only for an agent created as a throwaway, never on a real agent, refusing when it finds a real owner; 3a and 3d stay do-not-merge until the Apple session drives the approver screens end to end against a throwaway built from 3d"
approved: true
approved-by: "Echo (identity session, topic 144636), on the Chief of Staff's decision 2026-11-21 12:13 PST (agent message 1d8498bd) to build a test-only code channel for throwaway agents"
review-convergence: "2026-11-21T20:48:09.516Z"
review-iterations: 6
review-completed-at: "2026-11-21T20:48:09.516Z"
review-report: "docs/specs/reports/throwaway-owner-chat-convergence.md"
cross-model-review: "codex-cli:gpt-6.2-astra"
single-run-completable: true
frontloaded-decisions: 7
cheap-to-change-tags: 0
contested-then-cleared: 0
---
# A stand-in owner chat for throwaway agents

## Problem statement

The approver flows of pieces 3a and 3d talk to the owner only through the owner's private Telegram chat:

- the phone pairing request that makes a device `approvedVia: 'telegram-dm'` (Approve / Decline buttons, `ownerDM` in `MobilePairingDeps`; on main today);
- the first-approver word code (`mobileApproverClaim.ts`, through `ownerDM`; piece 3a);
- approver removal by the agent token alone (Approve / Decline, `takeApproverRevokeTap`; piece 3a);
- recovery: the owner's `/approver_reset <code>` command, the Start / Never mind card, the three wait notices and the finish code (`mobileApproverRecovery.ts`, `setRecoveryChat`, `approverResetHandler`; piece 3d).

The app screens for these flows (piece 3c, in the iPhone and Mac apps since build 118) have never run against a live server. Every Telegram owner we have is Justin's real account: the demo bot in the fixtures list is owned by him, so a throwaway on the demo bot makes his real Telegram identity the owner of the throwaway's owner record and approver state, and every drill (including repeated removals and recoveries) lands in his real private chat. The agent can read and tap that chat through the dedicated Playwright Telegram profile, so this is not about needing him to relay codes; it is about running many destructive identity drills without binding them to the real owner's account. A feature is not done until it is driven live through its real surface, so 3a and 3d cannot merge until the app-and-server half of this gap is closed (see "What a run proves" for the half this does not close).

## Proposed design

### 1. What it is

`src/server/throwawayOwnerChat.ts`: a stand-in for the owner's private chat, kept in memory and appended to one log file, `.instar/state/throwaway-owner-chat.jsonl` (mode 0600), with a small state file beside it, `.instar/state/throwaway-owner-chat.json` (first build time, owner-record genesis it adopted, and `off` once shut off). It implements exactly the owner-chat surface the flows use and nothing else.

**One owner-chat seam.** A new interface, `OwnerChatSurface` (`src/messaging/ownerChatTap.ts`), names what the approval flows need from an owner chat:

- `sendOwnerDMWithButton(text, buttons, opts?)` → a positive message id, `null` (not delivered), or (Telegram only, with `reportHeld`) `TelegramAdapter.OWNER_DM_HELD`; `buttons` may be one button, a list, an empty list or `null`;
- the handler slots `mobileApproveHandler`, `mobileDeclineHandler` (same signatures as on `TelegramAdapter` today).

`TelegramAdapter` satisfies it structurally on main. The stand-in implements it too, plus the optional slot `approverResetHandler`, which 3d adds to `TelegramAdapter` and then to the interface. In `AgentServer`, `const ownerChat = options.telegram ?? (standIn && !standIn.isOff() ? standIn : null)`; the stand-in is **never** assigned to `options.telegram`, so notices, attention items, topics, sentinels and every other `options.telegram` user never see it.

Changes in `AgentServer`:

- `ownerDM` sends through `ownerChat` (Telegram path unchanged: same call, same `reportHeld`).
- `telegramOwnerPresent` is `options.telegram ? !!getOwnerUserId() : standIn?.ownerChatPresent() === true`, where `ownerChatPresent()` is true while the stand-in is live **or unsure** and false only once it is definitely off. So `approvalPath()` answers `'telegram'`, exactly as with a real owner chat, and a failed read never flips the agent to dashboard approval for a moment: an unsure send returns `null`, which the pairing code treats as "not delivered".
- `telegramOwnerId` stays Telegram-only: `null` with the stand-in. The stand-in has **no owner user id at all**: nothing it does writes an id into the people registry, team log or owner record (a device with no role already resolves to the owner without an id).
- The Approve/Decline handler closures are assigned to every owner-chat surface present (the adapter, and the stand-in whenever it exists, live or shut off, so a shut-off sweep can press Decline through them). `mobileInboundScan` and `onHubPost` stay Telegram-only.

The Telegram path is unchanged in behaviour; a wiring test pins that a Telegram-configured server assigns the handlers to the adapter and has no live stand-in.

**Every other caller of `ownerDM` sees the stand-in too, by design.** The courtesy notices in `mobilePairingRoutes.ts` (activation records, a code seen in a conversation, refused taps, introducer records, browser notices) and the PIN-reveal notice in `mobileOwnerPresenceRoutes.ts` land in the stand-in log as messages without buttons, as they would land in a real owner chat. Phone setup at the computer is refused while `approvalPath()` answers `'telegram'`, as on an agent with a Telegram owner, and the app shows no bot name (`approvalChat` is null without a bot identity); both are part of the claim boundary below.

**What the stand-in reproduces of the adapter, and what it does not.** `TelegramAdapter.handleMobileApprove/Decline` do work outside the handler: they verify the tap (lifeline-verified, from the owner id, in the owner's private chat, data `^md:[ad]:[0-9a-f]{24}$`), show a toast, and then, following the outcome exactly: on `approved`, remove the buttons and send a confirmation message; on `declined`, replace the message's text (which also removes its buttons); on any other outcome, leave the message and its buttons as they are. The stand-in applies the same data pattern check, calls the same handler slot, and records the same visible results in its log. The words and the outcome rules live in one shared module, `ownerChatTap.ts`, which the adapter now calls too, so the two cannot drift; it already carries the optional handler-supplied text that 3a's removal Decline uses. A button whose data is neither pattern is not handled by Telegram's approval path either: the stand-in answers 409 `button-not-handled` and logs it, and does nothing else. It does not reproduce Telegram's sender verification (there is no Telegram sender; the route's own gate replaces it, §3) or Telegram delivery, rendering and editing. A run therefore proves the flow from handler dispatch onward, not the Telegram transport.

**Message bounds** (basis: external-constraint; a message Telegram would refuse is refused here too): text at most 4096 UTF-16 code units (Telegram's documented `sendMessage` limit, measured the same way), button data at most 64 bytes (documented `callback_data` limit), at most 100 buttons (Telegram's observed inline-keyboard limit), and one stored message at most 24 KiB serialized (labels included), so any single action's writes stay below the 64 KiB action reserve. A send over a bound returns `null`. Message ids start at 1 and are never 0 or negative (`-1` means "held" to the pairing code path).

**Size of the log.** Nothing is ever evicted: an evicted message could be a live Approve, and Telegram never evicts. Instead the stand-in keeps a byte budget of 16 MiB of serialized log entries (messages, taps, commands and shut-off records all count). A tap or command is refused with 507 `stand-in-full` before it reaches any handler unless 64 KiB of the budget remains (room for its result, the confirmation and an edit at the bounds; the Approve, Decline and reset handlers are synchronous, so nothing else can append while one runs), and an intent entry is appended before the handler runs and the result after it, so a crash between the two leaves an unmatched intent that `GET` reports as `indeterminate` (the run's report then checks the device state directly instead of counting it as a pass); sends over the budget return `null` (the flows behave as if no owner chat exists); shut-off records are always written. The number is a resource budget chosen with wide margin, not derived: a full run of every flow writes well under 1 MiB. `GET` pages hold at most 200 entries.

### 2. When it switches on: four conditions, all required

The conditions are read at boot, before `MobilePairingService` is built, and again on every use: every send, every route call including `GET` (fresh reads of the files named below). The separation they protect is between the bearer token, which the agent and its sessions hold and which can edit any agent file, and owner authority, which this stand-in imitates. So condition 1 alone is worth nothing, and conditions 2 to 4 rely on facts that one config edit cannot produce on a real agent. What the conditions stop is accidental and single-edit paths to a stand-in owner on a real agent. They do not stop a determined process running as the same user, which can already read the machine's signing keys and the bearer token from disk; the stand-in adds no power such a process lacks.

1. **Asked for:** `liveTest.throwawayOwnerChat.enabled === true` in `.instar/config.json`, read from disk. No default and no dev-gate: absent means off on every agent, development agents included.
2. **Created as a throwaway in a temporary folder:** the real path (symlinks resolved) of the project folder is under a fixed OS temp root, and the real path of the state directory is inside the real project folder. This is where the folder really is, not a field anyone wrote. It is deliberately stricter than `isUnderTempRoot`, which also accepts the unresolved path, so a temp-folder symlink pointing at a real agent home would pass it; and `readThrowawayRecord(projectDir)` returns a record with an `expiresAt`, not `keep`, with `createdAt` not in the future, and not expired (`isThrowawayExpired`). A sandboxed `$HOME` does **not** count: whoever starts the process sets `$HOME`, and the guard already treats a sandboxed HOME alone as no proof of a throwaway. The record's own `reasons` field is never read.
3. **No real owner.** Refused if any of these holds:
   - `messaging` in config has any entry, enabled or not;
   - the server was started with any messaging adapter (Telegram, Slack, WhatsApp, iMessage);
   - `monitoring.promptGate.ownerId` is set;
   - `mobilePairing.ownerIntroducers` has any entry (an introducer vouches for the owner, which is a real owner's word);
   - at first build, the device registry (`state/mobile-devices.json`) holds any device: an existing owner phone could approve pairings and enrol owner keys without the stand-in, so every device on the home must come after the first build (through the stand-in, or through a phone that did);
   - `state/topic-operators.json` holds any binding or any ever-verified operator id;
   - the owner record is enrolled (the marker `.instar/machine/owner-record-enrolled.json` exists, or `state/owner-record/entries.jsonl` holds an `add-owner-key` entry) and the enrolment is not the stand-in's own: an enrolment counts as the stand-in's own only when the stand-in's state file (`state/throwaway-owner-chat.json`, written at first build and only when neither the marker nor an owner-key entry existed then) records a first build earlier than the marker's `at`, and the marker's genesis is the one the stand-in adopted the first time it saw an enrolment (a different genesis later refuses). So an owner key the test itself enrols survives a restart; one that existed before the first build refuses the stand-in for good. Why ordering is enough here: on this home, with no adapter and no operator, the only way an owner key can be enrolled after the first build is through a device the stand-in approved, because while it is live `approvalPath()` answers `'telegram'` and the dashboard PIN does not approve phones.
   - this home's machine id (`.instar/machine/identity.json`) appears in the identity file of any other agent home on this computer (every home in the account-wide agent registry, read from the account's real home as well as `$HOME`, and every folder under `~/.instar/agents/`). This refuses a copy of a real agent moved into a temporary folder: its owner record, approver state and signatures would be valid for the original and could be copied back. A listed path that is not an agent home (no identity file, or not a folder) has no id to match; another home whose identity file exists but cannot be read makes the use unsure, never a non-match.
4. **Only this machine:** the machine registry lists no machine other than this one, in any status. And machine pairing is refused in both directions: `POST /api/pair` on this server answers 409 `stand-in-owner-chat-used` from boot whenever the stand-in is not definitely off (so also while a first build waits on an unsure read) and for the life of the home once it has built; `instar pair` / `instar join` refuse before they start once the home has built (the state file exists). Before a first build the command line cannot see the server, which is safe: joining another machine first registers a peer, so condition 4 is false and the stand-in never builds. A second machine therefore never receives the throwaway's owner record, team log or stand-in-approved devices, even after the stand-in has shut off.

**Unsure is not off.** A file that does not exist is an ordinary answer (no registry means no other machine; no identity means no id to match). A read or parse failure of a file that exists (a file mid-write, a permission error) makes that use refuse: sends return `null`, routes answer 503 `stand-in-unsure`, and owner presence stays true so the approval channel never changes. Nothing is shut off and nothing is cancelled; the next use reads again. Only a condition that is definitely false shuts the stand-in off. An unsure read at boot still mounts the routes (they gate per use); the first build is recorded at the first use whose conditions all hold, whenever that is.

**Shutting off, for good.** When a condition is definitely false, at boot or during a use, and the home has run the stand-in before (the state file exists), the stand-in:

1. records `off` with the condition in its state file first, so any message a decline path sends while it shuts off returns `null` and nothing re-enters it, and every later boot refuses on that alone;
2. presses Decline on every stored message whose buttons are still live and carry `md:d:` data, through the same handler slot a tap uses, so every request still pending in this process ends through its production decline path. Per flow that is the outcome a person's Decline would give: a pairing is declined, an approver removal keeps the device (3a), and a recovery card's Never mind cancels the recovery (3d); every other live button is only marked removed. (A pairing's nonce and code live only in memory, so after a restart its Telegram buttons and code already answer "ended" and the pending row expires on its own; pressing Decline then is harmless.);
3. runs the shut-off hooks pieces register with `standIn.onShutOff(name, fn)` (a named, synchronous, idempotent callback; a failing hook is logged, the others still run, and the sweep is not marked done, so the next boot runs it again). 3a registers one that drops a live first-approver claim the stand-in carried and any pending removal; 3d registers one that cancels a recovery started through it;
4. from then on every route answers 410 `stand-in-off` and every send returns `null`.

At boot the sweep runs once the handlers and hooks are wired (the end of `AgentServer`'s mobile wiring), from the stored log, and is recorded as done so it runs once. A home that never built the stand-in has nothing to sweep. At boot with any condition failing, the routes are not mounted (404) and the server logs one line naming the failed condition (never a config value).

### 3. How the test drives it

Three routes, mounted only when the stand-in is built. Each requires **all** of: the agent's master bearer token exactly (`bearerMatches`, not merely any credential `authMiddleware` accepts, so a dashboard session or a paired device token cannot use it); no `X-Instar-Device` header and no `Origin` header (a paired phone or a browser page is refused); and `ownLoopbackHost` (Host is `localhost:<port>`/`127.0.0.1:<port>`, a loopback peer, no forwarding headers). Any failure is 404.

- `GET /throwaway/owner-chat/messages?after=<id>`: the stored entries, oldest first. Every entry (message, tap intent and result, command intent and result, edit, shut-off) carries one monotonic sequence id, which is the cursor; a message's id is also what a tap names.
- `POST /throwaway/owner-chat/tap` `{ messageId, button }` (button index): presses one live button of one stored message. Data `md:a:<24 hex>` goes to the approve slot, `md:d:<24 hex>` to the decline slot, anything else answers 409 `button-not-handled`. A message or button never sent is 404; a button already removed is 409 `buttons-removed`. The answer and the log carry the toast and outcome.
- `POST /throwaway/owner-chat/command` `{ text }` (at most 4096 UTF-16 units, the same bound as a message): only `/approver_reset` and `/approver_reset <code>`, handed to `approverResetHandler` exactly as the adapter hands it (the text after the command, trimmed); the reply and its buttons are stored as a new message through the same send, so the same bounds apply, and a reply over a bound answers 500 `reply-over-bounds` (logged) rather than vanishing. Any other text is 400; no handler wired (main without 3d) is 409 `not-wired`.

What loopback does and does not show: it limits callers to this computer. A raw port-forward set up on this computer that rewrites Host and adds no headers would also pass, but only a process on this computer can set one up, and such a process can already read the bearer token from disk; the bearer is the real gate, loopback narrows it. A tunnel that serves the phone (named tunnel or the same-network listener, which phone pairing needs) cannot reach these routes: its Host is the tunnel or `.local` name and the tunnel adds forwarding headers.

### 4. What it never does

- It never reaches Telegram or any network; it has no token and opens no socket.
- It is not a messaging adapter: sessions, jobs, notices, topic messages and the outbound gate never see it, and no conversation is routed to it.
- It never runs on a real agent: a real agent's folder is not under a temporary root, and a real owner, adapter or peer refuses it on every use.
- It answers nothing to the phone that is not answered today: the phone sees only the codes a person would type.

## What a run proves (claim boundary)

A run with the stand-in proves that the app screens and the server's approver logic agree end to end, from the phone's request through the server's handler to the resulting device and approver state. It does **not** prove Telegram delivery, button rendering, callback verification, message edits or confirmation messages in real Telegram, the bot name the app shows beside a Telegram approval, real-device key storage (the simulator has no Secure Enclave), or push notifications. Device records on the throwaway say `approvedVia: 'telegram-dm'` because the flow under test is the Telegram one; that is a deliberate fidelity choice, contained to a home that is never paired with another machine and is deleted after the run, and the stand-in log names every approval that went through it. Every report of a run names both stand-ins (owner chat and simulator) in the same sentence as its result. Two residual passes stay required before 3a and 3d merge and are tracked as commitments by the identity session, each on its own separate throwaway (a real owner refuses the stand-in for good on any home it touches): (a) a real-Telegram pass on the demo bot, driven through the Playwright Telegram profile, covering phone pairing approval, the first-approver code, an approver removal by Approve, and a recovery from `/approver_reset` through Start to its finish code; (b) a real-device pass of the first-approver and removal screens.

## Decision points touched

| Decision point | Classification | Basis |
|---|---|---|
| The four switch-on conditions | invariant | basis: irreversible-consequence; evidence: on a real agent a stand-in owner would let a holder of the bearer token (the agent itself or any session) approve pairings and grant approver rights, which are owner authority the bearer is deliberately denied. Each condition is a fact read from the agent's own folder, config and machine registry, so there is nothing to judge. |
| Shut off for good when a condition stops holding | invariant | basis: irreversible-consequence; evidence: a request carried by the stand-in and finished later by a newly added real owner chat would act on a request nobody made there. |
| Master bearer + no device/Origin + loopback for the routes | invariant | basis: enumerable-domain; evidence: the only legitimate caller is a test process on this computer holding the agent token; every other credential class `authMiddleware` accepts belongs to a phone, browser or session that the test is about. |
| Command allowlist (`/approver_reset` only) | invariant | basis: enumerable-domain; evidence: the only owner-chat command any flow reads is `/approver_reset`. |
| Message bounds (4096 UTF-16 units, 64-byte data, 100 buttons) | invariant | basis: external-constraint; evidence: Telegram Bot API documented limits for sendMessage text and callback_data; 100 buttons is Telegram's observed inline-keyboard limit. |
| Refuse rather than evict at the log budget | invariant | basis: irreversible-consequence; evidence: evicting could drop a live Approve message, and refusing leaves the flows on their existing "no owner chat" path. The 16 MiB figure itself is a resource budget with wide margin (a full run writes under 1 MiB), not a derived floor. |
| Unsure suspends, definitely-false shuts off | invariant | basis: irreversible-consequence; evidence: shutting off cancels every request in flight and cannot be undone, so it needs a definite fact; a failed read only withholds the stand-in for that use. |
| Machine pairing refused for the life of a home that ran the stand-in | invariant | basis: irreversible-consequence; evidence: pairing replicates the owner record and devices to another machine, which cannot be taken back. |

## Multi-machine posture

There is never a second machine to keep in step: the stand-in exists only while the pool has exactly this one machine (condition 4), machine pairing in either direction is refused for the life of a home that ever ran it, and it shuts off for good if another machine appears anyway. Its only input is this computer's own loopback interface. `/health` is unchanged; there is no status surface to merge.

machine-local-justification: hardware-bound-resource

(the stand-in's only input is this physical machine's loopback interface, and its log is that machine's record of what was pressed there; the file is never replicated, synced or backed up; `state-coherence-registry.json` gains one `throwaway-owner-chat` row naming both files, scope `machine-local`, transport `none`.)

## Frontloaded Decisions

- **Shape:** a stand-in for the owner chat behind one owner-chat seam shared with Telegram, not a second code path in the flows (decision source above).
- **Gate:** four conditions, all required, no default-on anywhere; `project-under-temp` only, not a sandboxed HOME.
- **Scope:** phone pairing approval on main; the approver flows of 3a and 3d plug into the same seam (§1) when they land.
- **Where the run happens:** on a computer with Xcode and the simulator (the Apple session's machine), against a throwaway built from 3d; the run records a PASS/FAIL row per flow screen in its report.
- **Residual passes:** real Telegram and real device, each on its own throwaway, tracked as commitments (claim boundary above).
- **Throwaway lifetime for a run:** the run's throwaway is created with an expiry that covers the whole session (`--expires-in` long enough); an expiry during the run shuts the stand-in off for good, and extending the record afterwards cannot revive it.
- **What 3a and 3d wire** (listed so they plug in without a design change): 3d moves `approverResetHandler` and `setRecoveryChat` from `options.telegram` to `ownerChat` (adding the optional `approverResetHandler` to `OwnerChatSurface`), keeps `mobileInboundScan` and `onHubPost` on `options.telegram`, and registers the recovery-cancel shut-off hook; 3a's removal branches already sit inside the handlers, so it registers the claim-drop shut-off hook and moves its handler-supplied Decline text onto the shared `declineTapResult`. 3a's first-approver message carries an `approver-first-ignore:` button that Telegram's approval path does not handle (labelled Decline by `ownerDM`); that is a 3a defect, reported to 3a, and the stand-in shows it faithfully as `button-not-handled`.

## Migration

None. One optional config key, `liveTest.throwawayOwnerChat.enabled`, absent everywhere; the type gains it as optional.

## Observability

The conditions are re-read on every use, including each owner-presence read and each `GET` poll, and include a scan of the other agent homes' machine identities. That cost is paid only on a throwaway that asked for the stand-in; every other agent never builds it and reads nothing.

Each boot logs whether the stand-in was built, or which condition refused it. Every send, tap (with the handler's outcome and toast) and command (with its reply) is an entry in the log, readable through `GET`; the log is the record of a run. `/health` is unchanged.

## Maturation plan

This is a test fixture, not a user feature: it ships off and stays off on every agent, and its live proof is its purpose (claim boundary above). The test fixtures list gains an entry naming the switch, the routes and the conditions.

- **test-agent-live:** the Apple session drives the first-approver, add-approver, list, removal and recovery screens end to end in the simulator against a throwaway built from 3d with the switch on, recording a PASS/FAIL row per screen; every mismatch found is fixed in the app or the server before 3a and 3d leave do-not-merge.
- **dev-agent-live:** not applicable: condition 2 refuses the development agent (its folder is not in a temporary folder), by design.
- **fleet:** not applicable: no fleet agent can switch it on; there is nothing to roll out.
- **graduation criterion:** the fixture has done its job when one recorded run shows every 3a and 3d screen reaching its expected server state through the stand-in (no `indeterminate` intent counted as a pass), and the two residual real passes (real Telegram, real device) are recorded on their commitments. A run with zero screens exercised is not a pass.
- **dark-window:** none for the fixture itself (it is permanently off outside throwaways); the residual passes are tracked by the identity session until 3a and 3d merge.
- **ladder:** not applicable: a test-only fixture with no default-on state to climb (every other agent refuses it at boot)

## Rollback

Revert the commit, after tearing down every throwaway home that ran the stand-in (they are temporary test homes, and older code ignores the state file that keeps machine pairing refused). Older code ignores the config key and both state files. The shared tap-wording module returns to inline strings in the adapter with the same words.

## Tests

- **Unit, refusals:** not built when any one condition fails, each logging its condition: no switch; a project outside temp roots with a sandboxed `$HOME` and a forged throwaway record; a temp-folder symlink to a project outside temp roots; a device already paired at first build; state directory outside the project; no record; `keep`; expired; `createdAt` in the future; a disabled messaging entry; a started adapter; `promptGate.ownerId`; a topic-operator binding; an owner-record enrolment from before the first build; a machine id shared with another agent home; a recorded earlier shut-off; another machine in the registry.
- **Unit, unsure:** an unparseable config suspends one use (503, send `null`) without shutting off; the next good read works.
- **Unit, accepted:** an enrolment made after the first build keeps the stand-in on across a rebuild (restart).
- **Unit, while running:** adding a messaging entry, expiring the record, or a registry peer shuts it off: `off` recorded first, routes (including `GET`) 410, sends `null`, live `md:d:` buttons pressed through the decline slot, other live buttons only removed, shut-off hooks run, nothing more stored. A boot with a condition failing after an earlier build runs the same sweep once.
- **Unit, budget:** with under 64 KiB left a tap is refused before its handler runs (the pairing stays pending, buttons live).
- **Unit, tap results:** approved removes buttons and logs the confirmation; declined replaces the text; any other outcome leaves the buttons live; the adapter and the stand-in give the same words (shared module).
- **Unit, routes:** non-loopback, forwarded, tunnel-Host, device-signed, dashboard-session and Origin-carrying requests get 404; a tap on an unknown message or button is 404, on removed buttons 409; a command other than `/approver_reset` is 400; bounds refuse oversize sends; ids are positive.
- **Unit, machine pairing:** `/api/pair` answers 409 for a home that ran the stand-in, also after it shut off; `instar pair` and `instar join` refuse.
- **Integration:** through the HTTP pipeline of a throwaway server: a pending pairing carried by the stand-in is declined by the shut-off sweep when a messaging entry is added mid-run (the phone does not become active, the routes answer 410 and the approval path leaves `'telegram'`); a request with the right token but a tunnel Host is refused.
- **E2E:** the real `AgentServer` boot of a temp-folder throwaway with the switch on reports the stand-in built, and a phone goes through redeem, the Approve tap and a signed device read showing `active` with `approvedVia: 'telegram-dm'`, then a second phone is declined by tap; the same boot with a Telegram adapter configured reports it refused and answers 404; a wiring check that the handlers sit on the adapter, not a stand-in.
- 3a and 3d add their own integration cases (first-approver claim with the code read from `GET`, removal by Approve, recovery to Start through the command) when they wire into the seam.

## Left behind

Recorded in the convergence report.

## Open questions

None.
