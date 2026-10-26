# Native rebuild plan — People & agents, and Settings

Part of the console makeover (`docs/specs/console-makeover.md`, "Native rebuilds … after
MVP, one at a time"). One section per legacy tab, in the shape of `TEMPLATE.md`. Every
legacy control and write action is listed in each inventory; nothing is dropped
without saying so.

## Overview

**People & agents** answers "who is talking to whom, and with what permission?".
**Settings** answers "how is it set up, and what has it learned?". Today these are seven
tabs that mostly show machinery (fingerprints, hash chains, raw JSON, "harness",
"logical operations"). The rebuild turns each into the question Justin actually has,
leads with what needs him, and keeps every action within one or two taps.

Shared rules for all seven (from the makeover spec and the research synthesis):

- **One headline sentence, at most four facts, then the list.** Healthy state recedes;
  what needs Justin is amber and first.
- **Honest states everywhere:** *can't tell* (dashed slate, with the reason), *partial*
  (names the machines that did not answer), *stale* (shows its age). A zero is "none"
  only when the source proved it looked.
- **Deterministic UI for approvals and credentials** (Muse): approve, decline, issue,
  revoke, grant and secret links are fixed cards with server-authored text, never
  free-form chat or agent-written headlines.
- **PIN only where the server demands operator proof, through the shared PIN sheet with
  the adapter each route actually checks** (`00-patterns.md` §4a):

  | Adapter | Routes in these two groups |
  |---|---|
  | (a) Bearer only | Pairing: make an invite, check an invite, decline, cancel an invite, dismiss a restart notice, turn pairing on (`POST /threadline/pairing/invites`, `…/invites/inspect`, `…/:iid/decline`, `DELETE …/invites/:iid`, `DELETE …/restart-notices/:id`, `POST /threadline/pairing/enable`); Telegram mirroring `PATCH /threadline/telegram-bridge/config`; secrets `POST /secrets/request`, `DELETE /secrets/pending/:token`; autonomy profile `POST /autonomy/profile`; feature switches `POST /features/:id/transition`; rubber-stamp dismiss; files `POST /api/files/save`, `PATCH /api/files/config` (with `X-Instar-Request: 1`); preference conflicts `POST /state/resolve-conflict` |
  | (b) Operator session (held for its server lifetime) | Message origins: `GET /telegram/origins*`, `GET /telegram/origins/status` and `POST /telegram/origin-display` (header only, `src/server/telegramOriginRoutes.ts:24`, `src/server/originDisplayPreferences.ts:18`) |
  | (c) Body PIN, cleared after the one action | Pairing approve / finish / not them / it's one of my agents (`checkMandatePin`, `src/server/routes.ts:19403`–`:19446`); mandate issue, revoke, grants (`:13804`, `:13926`, `:13995`); authorization approve and deny (`:14125`, `:14171`); accepting a dark-but-load-bearing guard's fallback, and revoking that (`:10622`, `:10643`) |

  Adapter (c) actions ask every time. That is a deliberate change from the legacy pairing
  card, which kept the raw PIN for the whole page (`dashboard/pairing.js:14`, `:225`); the
  legacy mandates card already clears it after each use (`dashboard/mandates.js:451`), and
  the native pages follow that.
- **Background refresh never clobbers an open sheet or a typed field** (UX standard F9).
- **Phone first at 390 px**, bottom-sheet detail views, 44 px targets, no sideways scroll.

### Merges and renames (decisions)

| Legacy tab | New page | Group | Why |
|---|---|---|---|
| Threadline | **Other agents** | People | The operator thinks in agents, not threads. Pairing, health ("is it there?") and conversations are one agent's record. |
| Message origins | **Messages to you** | People | Its useful half is delivery ("were my replies held?"), which is the Home "Can I reach you" card's detail. Display settings become a sheet on that page, also linked from Settings. |
| Mandates | **Permission slips** | People | Stays its own page: it is where agent-proposed approvals land, and the slips are what agent-to-agent work runs under. |
| Secrets | **Passwords & keys** | People | Adds "ask someone for one" and "what I already hold (names only)". |
| Features | **What I'm allowed to do** | Settings | Autonomy profile first, then the safety checks (the one home of the guard list), then the switches (fixed so they actually work), then earned suggestions. Home's "What I'm allowed to do" card links here. |
| Preferences | **What I've learned about you** | Settings | A structured read first. Editing and forgetting are a separate, later backend change. The two developer sections (class reviews, claim verification) move to *How I'm doing inside*, as their own section. |
| Files | **Files** | Settings | Same name; a simpler phone editor, plus search. |

Nothing merges across groups except the display-settings link. Message origins was
considered for living inside each conversation instead; there is no native conversation
view yet, so the per-conversation override is reachable from the "Messages to you" sheet
now and moves to the conversation page when Sessions is rebuilt.

### Build order

These pages follow the one order in `README.md`. The shared primitives (PIN sheet,
bottom-sheet detail, row/list, "can't tell" block, confirm-with-consequence sheet) are
proved by Promises at step 1, not built separately here.

- **Messages to you** (M) — step 3, with Accounts: a missing reply is an operator
  intervention. First real use of the adapter-(b) operator session.
- **What I'm allowed to do** (M) — step 4: fixes a broken legacy write path (see its
  section) and is the one home of the guard list.
- Then, after Plans, Schedule and read-only costs (step 5), in this order:
  **Permission slips** (M, first adapter-(c) page), **Passwords & keys** (S),
  **Other agents** (L), **What I've learned about you** as a structured read (S/M),
  **Files** with the simple editor and search (M).
- Later: preference editing, forgetting and "Tell me directly" (a backend change first,
  see that section); Files editor upgrades (diff review).

Each ships behind its tile (the tile flips from legacy link to native page); the legacy
tab stays reachable from the page footer until the inventory check for that tab passes.

---

## Other agents (legacy tab id: `threadline`)

**Who comes here, and the one question on arrival.** Justin, when another agent (PP, his
own agents on other machines) is involved. *"Is anyone waiting on me, and is each agent I
work with actually there?"*

**What it does today (inventory).** `dashboard/index.html:4248`, `dashboard/pairing.js`,
inline JS `index.html:7107–7352`.
- Pairing card (`pairing.js`): restart notices with **Dismiss** (`DELETE /threadline/pairing/restart-notices/:id`); leak alarm (read-only); pending accepts with **Approve** (PIN, `POST …/invites/:iid/approve`) and **Decline** (`POST …/decline`); finish prompts with **Finish** (PIN, `…/finish`) and **Not them** (PIN, `…/not-them`); **Make an invite** with "Who is it for?" (known peers → `bindFp`) and TTL 1 h / 24 h (`POST /threadline/pairing/invites`), then **Copy** / **Done**; paste-an-invite **Check it** (`POST …/invites/inspect`); open invites with **It's one of my agents** (PIN, `…/own-agent`) and **Cancel it** (`DELETE …/invites/:iid`); paired-agents list (`GET /threadline/pairing`). PIN once per page, memory only. Badge count on tab and header button. Polls 10 s.
- Telegram bridge card: master switch, auto-create topics, mirror into existing topics (each `PATCH /threadline/telegram-bridge/config`); allow-list and deny-list add/remove by typed fingerprint or name.
- Conversations: thread list filtered by "has Telegram topic" and typed agent name (`GET /threadline/observability/threads`), thread view (`…/threads/:id`), message search (`GET /threadline/observability/search`), Refresh buttons.

**What is wrong with it today.**
- The question "is that agent there?" has no answer on the page, although `/threadline/peers/health` (dark, queued, last heard, `connectedNow`) and `/threadline/health` (my own relay state) exist.
- Thread rows lead with a raw thread id and "msgs · in / out" (`index.html:7237`); messages carry `trust:verified` and an 8-char id as metadata (`:7298`).
- The conversation view is a fixed `280px 1fr` two-pane grid (`index.html:4335`) — unusable at 390 px.
- Allow/deny lists ask Justin to type a fingerprint, though the agent already knows its peers (`knownPeers` from `/threadline/pairing/invites`).
- "Pairing is turned off" is a dead end (`pairing.js:209`) while `POST /threadline/pairing/enable` exists.
- Three sections, three Refresh buttons, ~1,993 words loaded (UX standard baseline).

**The new design.**
- *Arrival:* headline — "PP is waiting for you to finish pairing." / "2 agents, both reachable." / "1 agent hasn't answered in 6 h." Facts: agents paired · waiting on you · not answering · my relay (only shown when not connected: "I'm not connected to the agent network — checking again").
- *Layout:* (1) **Waiting on you** cards, only when any (restart notice, leak alarm, approve, finish). (2) **Agents** — one row per known agent (union of pairings and peer health): name, plain state ("Paired · answered 4 min ago", "Messages waiting since 09:12 — may be offline", "Pairing not finished"), chevron. (3) **Connect another agent** button. (4) collapsed **Mirroring to Telegram**.
- *Agent detail (sheet → full page on desktop):* status line with evidence and age; its conversations newest first, each opening a chat-bubble view (in left, out right, out-of-turn arrival is normal — Muse); per-message footer only on tap (time, delivery outcome); "Mirror this agent to Telegram: always / never / default" (writes allow/deny list — no typing); short fingerprint under "For support".
- *Primary actions:* Approve / Finish are one tap on the waiting card, then the PIN sheet (adapter c: asked for this action, cleared after it). "Connect another agent" opens a sheet: who it's for (Someone new / known agents), valid 1 h or 24 h, **Make invite** → the invite text with **Copy** and **Share** (Web Share API on phone) and the plain instruction "Send this privately to their person." A second tab in the same sheet: **I was sent one** → paste → **Check** → the approve card.
- *Secondary / destructive:* Decline (bearer), Not them (red, confirm sheet: "That invite is used up", then PIN), Cancel invite (bearer), "It's one of my agents" (PIN), Dismiss notice (bearer) — in a "…" menu on each card or row. Search lives behind a search icon in the Agents header and searches all messages. Bridge switches stay in the collapsed section; turning the master switch off shows the consequence ("No agent conversations will reach Telegram").
- *Honest states:* pairing 503 "turned off" → card with **Turn on pairing** (`POST /threadline/pairing/enable`; shows the returned `sayToPerson`, polls `GET …/enable`; states "This restarts my server; this page reconnects"); 503 "runs on another machine" → names that machine from `GET /pool/placement` if known; peer health 503 → agent rows show "Can't tell if it's reachable"; thread read failure → can't-tell block in the detail, list kept; stale peer row past 15 min → age shown.
- *Multi-machine:* `GET /threadline/peers/health?scope=pool` and `/threadline/conversations?scope=mesh` — each conversation names its holder machine when not this one ("This conversation lives on Mac Studio"). Unreachable peers named in a partial note.
- *Rough sketch:*
```
┌ Other agents ───────────────────┐
│ PP is waiting for you to finish │
│ pairing.                        │
│ 2 paired · 1 waiting · relay ok │
├─────────────────────────────────┤
│ ▌PP accepted your invite.       │
│ ▌Finish only if that's who you  │
│ ▌sent it to.  [Finish] [Not them]│
├ Agents ─────────────────── ⌕ ───┤
│ ● PP    Paired · 4 min ago    › │
│ ● Codey Paired · 2 h ago      › │
│ ◌ Scout Messages waiting 6 h  › │
│ [ + Connect another agent ]     │
│ ▸ Mirroring to Telegram         │
└─────────────────────────────────┘
```

**Merge / split / cut.** Pairing, peer health and conversations merge into per-agent
records. Bridge allow/deny lists become a per-agent choice (the lists remain the storage).
Free-text "agent filter" and "has Telegram topic" filter are cut in favour of search plus
per-agent grouping; nothing they returned is lost.

**Data.** Existing: `/threadline/pairing*`, `/threadline/peers/health?scope=pool`,
`/threadline/health`, `/threadline/conversations?scope=mesh`,
`/threadline/observability/{threads,threads/:id,search}`, `/threadline/telegram-bridge/config`,
`/threadline/pairing/enable`, `/pool/placement`. None new.

**Effort and order.** L. README step 5 (after Permission slips and Passwords & keys); needs the
PIN sheet and the sheet pattern from step 1.

**Open questions for the operator.** None.

---

## Messages to you (legacy tab id: `origins`)

**Who comes here, and the one question on arrival.** Justin, when a reply seems missing
or a message looks wrong. *"Did my replies reach me, and who wrote each one?"*

**What it does today (inventory).** `dashboard/origin.js`, mounted at `index.html:10594`
with the operator session (`X-Instar-Operator-Session`), **Unlock with PIN** on 403.
- Glance: Display settings / Recording status / Recent messages tiles.
- Display settings: conversation picker (agent defaults or one conversation), "Use agent defaults", four checkboxes (show details, machine name, session app, model name), **Save display settings** (`POST /telegram/origin-display`, revision-checked, 409 on conflict).
- Recording status (`GET /telegram/origins/status`, 30 s poll): enrollment complete/incomplete, prepared/held/accepted counts, freshness, outage-notice outcome.
- Recent messages (`GET /telegram/origins?scope=pool&limit=25`, falls back to local): per message machine · harness · model with evidence status, operation, state, time, display-at-preparation, attestation validity, revision link, receipt count; **Load more**; **Refresh**.

**What is wrong with it today.**
- The headline is an instruction, not a state: "Choose message details or inspect saved origins." (`origin.js:8`).
- Held replies — the thing that matters (Home found 26 expired undelivered) — appear only as an unlabeled "Held: N" inside "Recorded logical operations" (`origin.js:107`).
- Insider words as primary text: harness, logical operations, enrollment, attestation, evidence status.
- Settings are a drill-down tile, so the most common change takes three taps.

**The new design.**
- *Arrival:* headline from `/health` `telegramOrigin.heldForward` plus status — "3 replies to you are held; the oldest since 09:40." / "No replies held." / "Can't tell whether replies are held." Facts: held now · expired undelivered (from `expiredUnreported`) · recording (on / not fully set up) · footer on messages (shown / hidden).
- *Layout:* (1) **Held replies** list when any — conversation name, how long held, why in plain words (`hold_reason` mapped: "routed through Mac Studio", "outside the allowed chat"), tap for detail. (2) **Recent messages** — one line each: conversation, time, "Mac Studio · Claude Code · Opus 5.5", delivered/held/failed dot; tap opens the full record with plain labels ("Signature checks out", "Machine name came from this machine's settings"). (3) **Footer on messages** row → settings sheet.
- *Primary action:* reading. The settings sheet: "Show who wrote each message" master switch, then machine / app / model switches, a "For one conversation" picker with "Same as everywhere" — one Save, conflict shown as "Changed elsewhere — reload to see it".
- *Secondary:* Load more at the list end; a "Recording details" disclosure holds enrollment, counts and freshness verbatim for support.
- *Honest states:* operator session missing → one unlock card ("Message records need your PIN") using the shared PIN sheet with adapter (b): `POST /dashboard/unlock`, the session token held in page memory only until its server expiry (15 minutes by default, `src/server/DashboardOperatorSessionStore.ts:18`), then asked again; the raw PIN is not kept; status unavailable → can't tell, held count never shown as zero; pool audit failing → local list with "Only this machine's messages — the others didn't answer"; `topicsMayBeIncomplete` → "Some conversations aren't listed".
- *Multi-machine:* recent messages use `scope=pool`; coverage line always present ("All 3 machines" / "This machine only"). Held replies are per machine; each row names its machine.
- *Rough sketch:*
```
┌ Messages to you ────────────────┐
│ 3 replies to you are held.      │
│ Oldest since 09:40.             │
│ held 3 · expired 0 · recording on│
├ Held ───────────────────────────┤
│ ▌Instar 2.0 · 42 min            │
│ ▌routed through Mac Studio    › │
├ Recent · all 3 machines ────────┤
│ ● Echo desk 10:14 Studio·Opus › │
│ ● Lifeline  10:02 Mini·Codex  › │
│ ○ Bugs      09:40 held        › │
│ Footer on messages: shown     › │
└─────────────────────────────────┘
```

**Merge / split / cut.** Becomes the detail page of Home's "Can I reach you" card (which
today links to this legacy tab). Display settings also linked from the Settings page.
Nothing cut; the support fields move under "Recording details".

**Data.** Existing: `/health` (`telegramOrigin.heldForward`), `/telegram/origins/status`,
`/telegram/origins?scope=pool`, `/telegram/origins/:id`, `/telegram/origin-display`,
`/dashboard/unlock`. A held-replies **list** (not just the count) is needed: the smallest
form is an optional `held[]` already present in `/telegram/origins/status` (per CLAUDE.md
`held[].hold_reason`); confirm at build, else add it there.

**Effort and order.** M. README step 3; introduces the adapter-(b) operator session in the console.

**Open questions for the operator.** None.

---

## Permission slips (legacy tab id: `mandates`)

**Who comes here, and the one question on arrival.** Justin, when an agent asks to act
with another agent or a person needs a floor action. *"Is anything waiting for my
approval, and what have I already allowed?"*

**What it does today (inventory).** `index.html:4066`, `dashboard/mandates.js`, 30 s poll.
- Approvals waiting (`GET /authorization-requests?status=pending`): server-authored headline, agent's reason, **Approve** and **Decline** each with PIN (`POST /authorization-requests/:id/approve|deny`); requests held on another machine show "open that machine's dashboard".
- Issued mandates (`GET /mandate`): scope, active/revoked/expired, authorship verified/invalid, plain summary, existing grants, support line (id, fingerprints, scope, action slugs, author).
- **Grant a person an action** on each active slip: person (from `GET /permissions/users`, else Slack id), floor action (6), duration (15 min–24 h), PIN, **Grant** (`POST /mandate/:id/grants`, clamped to expiry).
- **Revoke** (collapsed): PIN, optional reason (`POST /mandate/:id/revoke`).
- **Advanced — author a mandate by hand**: scope, Agent A (prefilled from `/threadline/health`), Agent B fingerprint, authorities JSON, expiry, PIN, **Issue** (`POST /mandate/issue`, or `/mandate/issue-for-machine` for account-follow-me, with 502 delivery-failure handling).
- Decision audit (`GET /mandate/audit?limit=200`): chain verified/broken, table of when/decision/action/agent/reason.

**What is wrong with it today.**
- Approvals, slips, a hand-authoring form and a 200-row audit table share one long page.
- The audit table leads with `code` action slugs and short fingerprints (`mandates.js:279`).
- PIN typed per button (three PIN fields can be on screen at once), unlike pairing's once-per-page.
- "Decline" requires a PIN; that is the server's rule (`routes.ts:14171` body includes `pin`), so it stays, but nothing explains why.
- Hand-authoring needs raw fingerprints and JSON (`index.html:4086`), acknowledged as power-user in its own comment.

**The new design.**
- *Arrival:* "Echo is asking you to approve 1 thing." / "2 slips active; nothing waiting." / "No slips — every agent-to-agent action is refused until you sign one." Facts: waiting · active slips · people with grants · audit chain ("intact" / red "broken — possible tampering").
- *Layout:* (1) **Waiting for you** approval cards: the server headline large, "Echo's reason" small and secondary, Approve / Decline. (2) **Active slips** — one card each: plain summary ("Echo and PP may hand over read-only credentials and sign code reviews, until Nov 1"), who else it lets act, chevron. (3) **Ended** collapsed. (4) **Decision history** row with a 24 h count ("31 allowed, 2 refused today").
- *Slip detail:* summary, grants as sentences, **Let a person act** (person · action · for how long → Grant), "For support" (ids, fingerprints, scope, action slugs, authorities JSON read-only), **Revoke** at the bottom in red.
- *Primary action:* Approve: one tap → PIN sheet (adapter c, asked for each approval and cleared after it) → done, card leaves with "Approved". The PIN sheet says: "Approvals need your PIN so an agent can never approve for you." One sheet replaces the three PIN fields the legacy page can show at once.
- *Secondary / destructive:* Revoke → confirm sheet naming consequences ("Ends this slip and the 1 grant it carries, now. Can't be undone.") + optional reason + PIN. Decline → sheet with optional reason. **Advanced: write a slip by hand** stays, at the bottom of the page, behind a disclosure, with Agent A prefilled and Agent B a picker of known agents (from `/threadline/pairing/invites` `knownPeers`) with a "paste fingerprint" fallback; authorities keep the JSON template.
- *Decision history:* a list grouped by day, refusals first; each row "Refused · PP tried to sign a review outside the slip"; slug and fingerprint in the row detail.
- *Honest states:* `/mandate` fails → can't tell, no "No slips" claim; authorization requests fail → "Can't tell if anything is waiting" in amber-dashed, slips still shown; `authorshipValid:false` → red row "This slip's signature doesn't check out"; chain broken → red banner at top with "Treat as an incident"; held-on-another-machine approvals show that machine's name and a link to its console when known.
- *Multi-machine:* slips and approvals are per machine today; approvals already carry `heldOnThisMachine`/`createdOnMachine`. No pool read is invented.
- *Rough sketch:*
```
┌ Permission slips ───────────────┐
│ Echo is asking you to approve   │
│ 1 thing.                        │
│ 1 waiting · 2 active · chain ok │
├─────────────────────────────────┤
│ ▌Let Mia deploy to production   │
│ ▌for 1 hour.                    │
│ ▌Echo's reason: hotfix #2412    │
│ ▌        [Approve] [Decline]    │
├ Active ─────────────────────────┤
│ Echo + PP · reviews, read keys  │
│ until Nov 1 · 1 person        › │
│ ▸ Ended (4)                     │
│ History · 31 allowed, 2 refused›│
└─────────────────────────────────┘
```

**Merge / split / cut.** Stays in People. Its active-slip count already feeds Home's
"What I'm allowed to do" card. Approvals waiting should also count on Home's "What needs
you" when the attention item exists; no new Home field.

**Data.** Existing routes only. The 24 h allowed/refused count is computed client-side
from `/mandate/audit`.

**Effort and order.** M. README step 5 (first of the remaining People pages); first
adapter-(c) page in production use.

**Open questions for the operator.** None.

---

## Passwords & keys (legacy tab id: `secrets`)

**Who comes here, and the one question on arrival.** Justin, after the agent says it
needs a credential, or to hand one over. *"Is the agent waiting on a password from
someone, and how do I give it one safely?"*

**What it does today (inventory).** `index.html:3639`, `loadSecrets` `:10205`,
`glance.js:1578`.
- Glance: "N secret requests are waiting", Waiting / Expired tiles from `GET /secrets/pending`; badge count.
- Each request's record: label, conversation (raw topic id), asked, expires; **Open the secure drop**, **Copy link**, **Cancel request** (`DELETE /secrets/pending/:token`).
- **Create test request** (`POST /secrets/request`, 5 min, silently copies the URL to the clipboard, `:10231`); **Refresh**.

**What is wrong with it today.**
- The only create action is a test; there is no way to make a real request from the dashboard.
- "Create test request" copies a link without telling Justin; failures use `alert()` (`index.html:10196`, `:10250`).
- The conversation is shown as a number.
- Nothing says what the agent already holds, so Justin cannot answer "do you already have my GitHub token?" (the CLAUDE.md rule is agent-retrieves-first).

**The new design.**
- *Arrival:* "The agent is waiting on 1 password." / "Nothing is waiting." Facts: waiting · expiring within 5 min · keys I hold (count of names) · synced to other machines (only when sync is on).
- *Layout:* (1) **Waiting** cards: label large ("OpenAI API key"), conversation name, "expires in 11 min" live countdown, **Open** and **Share link**. (2) **Ask someone for one** button. (3) **Keys I already hold** — names only, never values or lengths, collapsed by default, with a line "I fetch these myself; you never need to resend one listed here." (4) Expired, collapsed.
- *Primary action:* **Open** (the drop page, new tab) — the common case is Justin filling it himself on his phone. **Share link** uses the Web Share API, falling back to Copy with a visible "Copied".
- *Ask someone for one:* sheet with "What is it?" (label), optional note, which conversation should hear when it arrives (picker of conversations), valid for 15 min / 1 h → **Create link**, then the share card. The test request stays as a small "Try it with a test link" text button inside the sheet.
- *Secondary / destructive:* Cancel request in the card's "…" menu with a one-line confirm ("The link stops working").
- *Honest states:* `/secrets/pending` failure → can't tell (legacy rendered an empty glance as "No requests", `index.html:10215`); key-names source failure → that section says can't tell, requests still shown; vault `decrypt-failed` (from `/secrets/sync-status` `vault`) → red line "I can't open my saved keys on this machine — don't change anything; tell me" (per CLAUDE.md: never repair or rotate).
- *Multi-machine:* requests are per machine (in-memory store). Sync status shows mode ("receives from Mac Studio" / "sends to 2 machines") and names offline targets.
- *Rough sketch:*
```
┌ Passwords & keys ───────────────┐
│ The agent is waiting on 1       │
│ password.                       │
│ 1 waiting · 14 keys held        │
├─────────────────────────────────┤
│ ▌OpenAI API key                 │
│ ▌for "Instar 2.0" · 11 min left │
│ ▌         [Open] [Share link] … │
├─────────────────────────────────┤
│ [ + Ask someone for one ]       │
│ ▸ Keys I already hold (14)      │
│ ▸ Expired (2)                   │
└─────────────────────────────────┘
```

**Merge / split / cut.** Stays its own page in People. "Create test request" is kept,
demoted inside the create sheet.

**Data.** Existing: `/secrets/pending`, `/secrets/request`, `DELETE /secrets/pending/:token`,
`/secrets/sync-status`, key names from `GET /self-knowledge/session-context?full=1`
(names only). To verify at build whether a submitted drop leaves the pending list with no
"received, not yet collected" read; if so, show that honestly ("Once someone submits, it
moves to the agent; it doesn't stay listed here").

**Effort and order.** S. README step 5, after Permission slips.

**Open questions for the operator.** None.

---

## What I'm allowed to do (legacy tab id: `features`)

**Who comes here, and the one question on arrival.** Justin, deciding how much the agent
may do alone. *"How independent is the agent right now, and what is switched on?"*

**What it does today (inventory).** `index.html:4382`, JS `:9079–9360`.
- Autonomy card: current profile name + description, **Change** → profile selector (cautious / supervised / collaborative / autonomous, "Recommended" on supervised) → **Apply Profile** (`POST /autonomy/profile`) / Cancel; profile history (`GET /autonomy/history`).
- Feature catalogue (`GET /features`) grouped Safety & Trust / Communication / Infrastructure / Intelligence: name, one-liner, on/off switch (`POST /features/:id/transition {to}`), card → detail with full description, Data & Privacy (data implications), How to Undo, the same switch; **Refresh**.

**What is wrong with it today.**
- **The switch cannot turn most features on.** It sends only `{to:'enabled'}` (`index.html:9197`). The registry refuses an `undiscovered` → `enabled` jump (only `interested → enabled` is valid, `src/core/FeatureRegistry.ts:177`), requires a consent record for `network` and `self-governing` tiers (`:468`) — 10 of the 13 definitions in `FeatureDefinitions.ts` — and an activation challenge for `self-governing` (`:480`). The toggle errors and snaps back with a toast.
- Profile history never renders: the code reads `history.length` (`index.html:9339`) but the route returns `{ history: [...] }` (`src/server/routes.ts:31649`).
- Apply sends no reason, so history reads "User request".
- The card shows the profile name only; what it actually means (`/autonomy` `resolved`: auto-apply updates, auto-restart, trust auto-elevation) and the agent's own summary are fetched and ignored.
- Earned trust suggestions (`/autonomy/elevation/opportunities`) and the rubber-stamp signal have no face.

**The new design.**
- *Arrival:* the profile as a sentence, large: "I handle routine work on my own and ask you before important decisions." (Supervised). Facts: profile · safety checks ("2 off where they should be on", amber; hidden when all are on) · features on (n of 13) · suggestions waiting.
- *Layout:* (1) **Profile** — four-step segmented control (Cautious … Autonomous) under the sentence, each step a one-line description; below it "What that means right now": updates install themselves (yes/no), I restart after updates (yes/no), I ask before raising my own trust (yes/no) from `resolved`. (2) **Safety checks** — the one home of the guard list (from `GET /guards`, and `?scope=pool` on a multi-machine install, with a machine chip per row): checks that are off where they should be on, or on but unverified, are listed first as rows, each saying which machine and what the check protects; "all 38 others on" is collapsed below. Home's "What I'm allowed to do" card opens this page, so a deviant check is one tap from Home; Machines shows only a count that links here. A dark-but-load-bearing check offers **Accept the risk** and **Stop accepting it** (`POST`/`DELETE /guards/:key/accept-fallback`, adapter c, with the reason and owner the route requires). (3) **Suggestions** — only when any (see below). (4) **Features** — grouped lists, each row name + one-liner + state word and a switch. (5) **History** collapsed.
- *Turning a feature on or off is driven by the server's own state machine.* The sheet reads the feature's current state and its `validTransitions` from `GET /features/:id` (`src/server/routes.ts:40029`, `:40044`) and offers only those, in words; it never assumes a path. The graph applies to every tier (`src/core/FeatureRegistry.ts:177`): a feature not yet discovered can only become *aware*; *aware* can become *interested*, *deferred* or *declined*; only *interested* can become *enabled*; *deferred* and *declined* go back through *aware*; *enabled* can become *disabled* and *disabled* can become *enabled* again directly. So "Turn on" for a feature that is not yet interested sends the steps one at a time (`POST /features/:id/transition`, `:40069`), re-reading `validTransitions` after each, and stops with the server's reason at the first refusal. For network and self-governing tiers the last step carries a consent record built from the data implications the sheet showed, with mechanism `explicit-written` (refused without one, `src/core/FeatureRegistry.ts:468`); for self-governing, the server answers the first enable with a challenge, which the sheet presents and completes ("Confirm: let the agent act without asking for this", `:480`). Turning off is one tap with an undo toast; re-enabling a disabled feature is one step.
- *Suggestions:* earned trust opportunities (`/autonomy/elevation/opportunities`) are shown as information with **Not now** (`/autonomy/elevation/dismiss`). There is **no accept button**: `POST /autonomy/elevation/record` only records a decision event for tracking (`src/server/routes.ts:31674`) and changes no permission, so a "Yes" button would pretend to grant something. The suggestion instead says how to act on it today ("To allow this, move the profile to Collaborative, or tell me in chat"). An accept button arrives only with a real apply route.
- *Profile change:* tapping a step opens a confirm sheet listing what changes ("Updates will install without asking. You'll get a summary instead of approvals."), an optional "why" line (sent as `reason`), **Switch**.
- *Rubber stamp:* when the tracker reports approve-without-reading, one muted line in Suggestions: "You've approved 19 of the last 20 within a minute. If that's on purpose, I can stop asking for these." with Dismiss (`/autonomy/elevation/dismiss-rubber-stamp`).
- *Honest states:* `/autonomy` 404 → "Autonomy isn't set up on this agent" (legacy silently pretended `supervised`, `index.html:9099`); `/features` 501/failure → can't tell; a transition refused → the server's reason in plain words beside the row, switch shows real state; elevation 404 → section hidden with no claim.
- *Multi-machine:* profile and features are per machine; the page names the machine in its header when the pool has more than one.
- *Rough sketch:*
```
┌ What I'm allowed to do ─────────┐
│ I handle routine work on my own │
│ and ask you before important    │
│ decisions.                      │
│ [Caut][Super●][Collab][Auton]   │
│ updates self-install · yes      │
│ restart after update · yes      │
├ Safety checks · 2 need a look ──┤
│ ▲ Watchdog off · Mac Mini     › │
│ ▲ Reaper unverified · Studio  › │
│   36 others on                ▾ │
├ Suggestion ─────────────────────┤
│ ▌You approved my last 12 config │
│ ▌changes without edits.         │
│ ▌              [Not now]        │
├ Features · 6 of 13 on ──────────┤
│ Telegram replies   On      (●)  │
│ Slack              Not tried( ) │
│ ▸ History                       │
└─────────────────────────────────┘
```

**Merge / split / cut.** Renamed from Features. Home's "What I'm allowed to do" card
links here instead of Machines, and the guard list lives here (Machines links to it with a
count). Mandates are not merged in: they are agent-to-agent grants, reached from People.

**Data.** Existing: `/autonomy`, `/autonomy/profile`, `/autonomy/history`,
`/autonomy/elevation/opportunities`, `/autonomy/elevation/record`,
`/autonomy/elevation/dismiss`, `/autonomy/elevation/dismiss-rubber-stamp`, `/features`,
`/features/:id`, `/features/:id/transition`, `/guards` (and `?scope=pool`),
`/guards/:key/accept-fallback`. None new. No accept action for suggestions until an apply
route exists (see above).

**Tests that must pass before the tile switches.** Through the real routes: one fresh
local-tier feature from undiscovered to enabled; one fresh network-tier feature, which
must carry the consent record; one self-governing feature through its activation
challenge; and one disabled feature re-enabled directly.

**Effort and order.** M. README step 4 (it repairs a broken write path).

**Open questions for the operator.** None.

---

## What I've learned about you (legacy tab id: `preferences-learning`)

**Who comes here, and the one question on arrival.** Justin, when he notices the agent
doing (or not doing) something he asked for before. *"What has it picked up about me,
and is any of it wrong?"*

**What it does today (inventory).** `index.html:4132`, `dashboard/preferences-learning.js`,
polled, all read-only.
- Headline: N preferences / none yet / stale ("Can't refresh right now").
- Preferences (`GET /preferences/session-context`): the injected block split into lines.
- Recent corrections (`GET /corrections?limit=20`): scrubbed summary, kind, status, times seen, first noticed.
- Class reviews (`GET /class-reviews?limit=20`): verdicts and outcomes.
- Claim Verification observations (`GET /completion-claim/audit?limit=20`).
- Friendly 503 "not turned on" state.

**What is wrong with it today.**
- No way to correct or remove a wrong preference — the research's "a standing decision you can watch being recorded is one you can correct before it hardens" (synthesis #4) has no lever. (Adding one is not small; see Data.)
- Preferences are parsed back out of a formatted text block (`preferences-learning.js:161`), losing when each was learned, how often it was seen, and its confidence.
- Two of four sections are developer audit (class review lifecycle, claim-verification observer) on a page meant for the operator.

**The new design.**
- *Arrival:* "I've picked up 7 things about how you like to work." / "Nothing yet — correct me the same way twice and it shows up here." Facts: preferences · new this week · corrections being watched · conflicts between machines (only when any).
- *Layout:* (1) **How you like things** — each preference as a quoted sentence ("Lead with the short answer"), under it "learned Oct 12 · seen 4 times". Tap → sheet: the sentence, where it came from (linked corrections), when it was learned, how often it was seen. Read only in this build. (2) **Two machines disagree** — only when `/state/conflicts` has preference conflicts: both versions side by side, **Keep this one** each (`POST /state/resolve-conflict`, which exists). (3) **Things I'm still watching** — corrections not yet a preference, plain status ("Seen twice, waiting for a third day"). (4) A quiet line: "To change one, tell me in chat." No edit, forget or "tell me directly" controls in this build.
- *Primary action:* reading. Learned preferences stay advisory, as today; none is presented as something the operator said.
- *Honest states:* 503 → "Learning from corrections is off on this agent" (no fake empty list); preferences read fails → can't tell, corrections still shown; stale → last good list with age; a replicated preference from another machine is marked "learned on Mac Mini".
- *Multi-machine:* preferences union across machines when replication is on (`scope: mesh` in the session-context response); rows from other machines say so; forgetting propagates as a tombstone.
- *Rough sketch:*
```
┌ What I've learned about you ────┐
│ I've picked up 7 things about   │
│ how you like to work.           │
│ 7 kept · 2 new this week        │
├ How you like things ────────────┤
│ "Lead with the short answer."   │
│  Oct 12 · seen 4 times        › │
│ "No approvals to you at night." │
│  Oct 3 · seen 6 times · Mini  › │
├ Still watching (3) ─────────────┤
│ Plainer wording — seen twice  › │
│ [ Tell me something directly ]  │
└─────────────────────────────────┘
```

**Merge / split / cut.** Renamed. Class reviews (`GET /class-reviews?limit=20`) and Claim
Verification observations (`GET /completion-claim/audit?limit=20`,
`dashboard/preferences-learning.js:333`–`:334`) move to *How I'm doing inside* as its own
section, **Checks on my own claims** (`under-the-hood.md`); until that section ships, the
legacy tab keeps them, linked from the hood tile. Nothing is deleted.

**Data.** Existing: `/preferences/session-context`, `/corrections`, `/state/conflicts`,
`/state/resolve-conflict`. **New for this build, one read:**
- `GET /preferences` → `{ entries: [{ dedupeKey, learning, recordedAt, confidence, dedupeCount, origin? }] }` (the structured `PreferenceEntry`, `src/core/PreferencesManager.ts:40`; `violationPattern` omitted). Read only; it replaces parsing the formatted text block.

**Later, a separate backend change (not a small route wrapper).** Editing, forgetting and
"tell me directly" need real persistence and identity work, specified and tested on their
own before any button ships:
- *Who said it.* A preference must not be attributed to the operator, or ranked above
  learned ones, on the bearer token alone: agent sessions hold the same bearer (the server
  says so itself, `src/server/routes.ts:35818`–`:35821`), so a bearer-only "operator"
  write could be made by an agent. Attribution needs server-verified operator proof (for
  example the operator session, adapter b). Today the only provenance is
  `'correction-loop'` (`src/core/PreferencesManager.ts:37`).
- *Deleting.* The manager's replication seam is put-only with no delete path
  (`src/core/PreferencesManager.ts:184`–`:192`), so "forget" needs a delete and a
  replicated tombstone designed in.
- *Other machines.* The replicated store coerces every provenance back to
  `'correction-loop'` (`src/core/PreferencesReplicatedStore.ts:149`–`:153`), so a new
  provenance would be lost on other machines; and the session-context read can take the
  union of machines' copies (`src/server/routes.ts:28098`), so "forget" must be shown to
  remove every machine's copy and not return through that union.
- *Concurrent edits and re-learning.* What happens when two machines edit the same
  preference, and whether a forgotten preference may be learned again from new
  corrections, must be decided before "I'll stop loading this" can be promised.

**Effort and order.** S/M for the structured read (README step 5). The editing backend is
L and later.

**Open questions for the operator.** When the editing change is built: should a preference
you state yourself, once proven to be from you, rank above learned ones? (Recommended: yes,
only with that proof.)

---

## Files (legacy tab id: `files`)

**Who comes here, and the one question on arrival.** Justin, opening a link the agent
sent ("see CLAUDE.md") or fixing a line from his phone. *"Show me this file — and let me
change it safely."*

**What it does today (inventory).** `index.html:3228`, JS `:7353–7970`.
- Tree from `GET /api/files/list` (lazy per folder), file icons, expand/collapse.
- Open (`GET /api/files/read`): breadcrumbs (tapping a folder crumb expands it), Editable/Read-only badge, markdown rendered (marked + DOMPurify), code highlighted under 200 KB / 2,000 lines, binary placeholder with size.
- **Edit** → textarea editor with **Save** (`POST /api/files/save`, `expectedModified`), **Cancel**, ⌘S, Esc, unsaved-changes confirm on leave, iOS keyboard padding via `visualViewport`.
- **Copy** (rendered or editor text).
- Conflict dialog on 409: **Overwrite** / **Reload** / **Cancel**.
- 401 during save stashes the edit in `sessionStorage` and restores it after re-auth (<10 min).
- Deep links `?tab=files&path=…`; back button on phone.

**What is wrong with it today.**
- No way to find a file except walking folders; the root lists at most 500 entries silently (`src/server/fileRoutes.ts` `sorted.slice(0, 500)`).
- The editor is a bare textarea with tiny toolbar buttons; on a phone, Save sits at the top while the keyboard covers the bottom half.
- No review before save; Overwrite on conflict discards the other change blind.
- Download (`/api/files/download`) and copy-link (`/api/files/link`) routes exist with no button; a binary file is a dead end.
- Folder access settings (`PATCH /api/files/config`) have no face.
- Uses `confirm()` dialogs.

**The new design.**
- *Arrival:* a **search field** at the top ("Find a file"), then **Recent** (last 8 opened, per viewer in `localStorage`), **Pinned** (the agent's key files: CLAUDE.md, AGENT.md, MEMORY.md when present), then **Browse** folders. Headline only when something is wrong ("Can't read the file list").
- *Viewer (full screen on phone):* sticky header with back, file name, folder path as one muted line (tap → that folder), and a "…" menu (Copy text, Copy link, Download, Open in new tab). Markdown rendered with a **Rendered / Source** toggle; code with line numbers and wrap toggle; large files open as source without highlighting and say so; read-only shows a lock and why ("Hooks and scripts are never editable here").
- *Editing (MVP, deliberately simple):* **Edit** is a floating button bottom-right (thumb reach). The editor is full height, monospace 16 px (so iOS does not zoom), line-wrapped, no autocorrect/autocapitalize. **Save** and **Cancel** sit in a sticky header at the top, which stays visible while iOS scrolls the page; no keyboard-tracking bar. "Unsaved" shows beside Save. ⌘S and Esc on desktop. No diff engine in this build.
- *Conflict (on a 409):* "This file changed since you opened it (changed 10:42; you opened it at 10:31)." Two choices: **Reload theirs** and **Overwrite with mine**. Before either, your text is kept (the existing session-storage stash) and a **Copy my version** button is offered, so neither choice loses it.
- *Session expiry:* the existing stash-and-restore is kept and made visible ("Your unsaved edit was kept — sign in to save it").
- *Desktop:* tree left (280 px), viewer right; search above the tree.
- *Folder access:* a "Which folders can be browsed and edited" row at the bottom of Browse opens a sheet listing allowed paths with add/remove (`PATCH /api/files/config`, `X-Instar-Request: 1`); never-editable and never-served paths are listed as fixed, with the reason.
- *Honest states:* list failure → can't tell with retry, recent and pinned still usable; folder truncated → "Showing the first 500 — search to find the rest"; file too large → size and Download; binary → size, type, Download, and a preview for images; refused key-material path → "This file is never shown, by design".
- *Multi-machine:* files are this machine's disk; the header names the machine when the pool has more than one. No cross-machine browse.
- *Rough sketch:*
```
┌ Files ──────────────────────────┐   ┌ ‹ CLAUDE.md             … ─┐
│ ⌕ Find a file                   │   │ .claude/  ·  editable       │
├ Recent ─────────────────────────┤   │ [Rendered|Source]           │
│ CLAUDE.md          .claude/   › │   │ ## Telegram Relay           │
│ LIVE-PATH-PLAN.md  docs/      › │   │ Every message you receive…  │
├ Pinned ─────────────────────────┤   │                             │
│ AGENT.md · MEMORY.md            │   │                             │
├ Browse ─────────────────────────┤   ├─────────────────────────────┤
│ ▸ .claude   ▸ .instar   ▸ docs  │   │ Unsaved  [Cancel][Review&save]│
│ Folders you can browse        › │   │ (keyboard)                  │
└─────────────────────────────────┘   └─────────────────────────────┘
```

**Merge / split / cut.** Stays in Settings as Files. Nothing cut; `confirm()` dialogs
replaced by sheets.

**Data.** Existing: `/api/files/{list,read,save,config,download,link}`. **New, smallest:**
`GET /api/files/search?q=` (name match, capped, returns `truncated`), and a `truncated: true`
field on `/api/files/list` when the 500 cap applies. Search must apply the same path rules
the other file routes do, not just a name scan of allowed paths: every candidate goes
through the existing checks (`checkRelativePathAllowed` and `validatePath`,
`src/server/fileRoutes.ts:246`; the never-served list re-checked after resolving symlinks,
`:88`, `:152`, `:261`; the per-entry check used by the folder list, `:390`), so a symlink or
a never-served file never appears in results. The deep-link `?path=` keeps working through
the switch's URL adapter.

**Effort and order.** M. README step 5 (last of the remaining pages). Later upgrade, only if
use shows a need: a review-before-save diff and a side-by-side conflict view.

**Open questions for the operator.** None.
