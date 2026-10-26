# Capacity — native rebuild plan

Part of the console makeover (`docs/specs/console-makeover.md`). One section per legacy tab,
following `TEMPLATE.md`. Read-only inventory was taken from `dashboard/index.html`,
`dashboard/glance.js`, `dashboard/subscriptions.js`, `dashboard/spend-arming.js`,
`dashboard/money-layer-enable.js` and `src/server/routes.ts` on 2026-10-25.

## Group overview

**What "Capacity" means, in one sentence:** *what I have to work with: the computers I run on,
the AI accounts I think with and how much each has left, and what that thinking costs.*

The group page says that sentence at the top, then shows **three tiles instead of six**:

| New view | Its question | Built from legacy tabs |
|---|---|---|
| **Machines** | Where am I running, and is each machine coping? | `machines`, `resources`, `systems` (Health) |
| **Accounts** | How much AI allowance is left, and does any sign-in need you? | `subscriptions` |
| **What thinking costs** | What is AI use costing, where does it go, and are the limits set? | `tokens`, `spend`, `llm-activity`, `routing-map` |

Why these merges:

- **Resource usage and Health describe one machine each.** Both read only the machine that
  serves the page (`/resources/summary`, `/systems/status`). On their own tabs they look like
  agent-wide facts; inside the machine's detail they are what they are: "this machine's CPU and
  memory" and "the parts of me running on this machine".
- **Tokens, Spend, LLM activity and Routing map are four halves of one question.** They share
  sources (Spend and LLM activity both read the feature-metrics ledger), use the same label
  "Text processed" for two different things (`glance.js:1218` vs `:1661`), and run on three
  different time windows (24 h, 7 d, daily grain). LLM activity promises "what it cost" and never
  shows it (`index.html:3733`). One view with one time control and a named source on every
  number fixes all of that.
- **Accounts stays on its own.** It is the action-heavy screen (sign-in repair, setup, approve),
  and money is a different decision from allowance. The cost view links to it for "covered by
  your subscription".
- **One item leaves Capacity:** "Autonomous throughput observations" (on the Machines tab today,
  `index.html:4182`) is about runs, not machines. It moves to Work (beside Projects), or under
  Throughput in Under the hood.
- **Under the hood loses Routing map and LLM activity** (both become sections of the cost view).
  Their legacy tiles stay in Under the hood, pointing at the new sections, until legacy removal.

**Shared rules for all three views** (from the makeover plan, restated where they bite):

- Read-only first cut. Every write action that is not yet native shows as a clearly labelled
  link into the legacy tab ("Do this in the classic dashboard ↗"), so nothing is lost on day one.
- **One PIN sheet.** Where the server requires operator proof, the console asks once per visit
  through `POST /dashboard/unlock`, holds the operator session **in memory only**, and reuses it.
  No PIN for anything the bearer token already allows (rename, cancel a sign-in, submit a code,
  freeze a paid door).
- Every number says how old it is and where it came from; a failed source says "Can't tell"
  with the reason; part of the pool answering is "partial" and names the machines that did not.
- No polling of write-classified routes; polls pause while the tab is hidden; a poll never
  rebuilds a control the operator is using (floor F9).
- Nothing on these pages creates a notification. They are places to look, not things that ping.

**Build order:** 1. Machines (needs the honest machine states from P1 of
`trustworthy-machine-load-and-mesh-floor.md`; Home already links to it). 2. What thinking costs,
read-only (no writes needed except Freeze; clarifies the most confusing tabs). 3. Accounts
(largest: per-cell writes, F9, mixed PIN models). 4. Spending controls go native inside the cost
view (PIN plan flows; lowest frequency of use, highest care).

---

## Machines (legacy tab id: `machines`)

**Who comes here, and the one question on arrival.** Justin, usually from Home's "Where I'm
running" card or after a "machine X seems down" moment. *"Is every machine I run on reachable and
coping, and if not, how do I know?"*

**What it does today (inventory).**
- Glance (`glance.js:871–1045`): headline, tiles Online / Attention needed / Dispatcher /
  Safety checks; per-machine record (name, status word, specs, sessions active/max, guard counts,
  "load-bearing protection unproven" with raw keys); safety-check list and record. Reads
  `GET /pool`, `GET /guards` (this machine only). Polls every 15 s while open.
- **Rename** a machine: inline input, saves on Enter/blur, `PATCH /pool/machines/:id`
  `{nickname}`. Bearer only.
- **Machine identity recovery** (`index.html:6545–6644`, `GET /identity-recovery`): recovery key
  and root status, peer status, unacknowledged key rotations, quarantined identity claims.
  Writes, all needing a recent PIN unlock (`X-Instar-Operator-Session`, server-required):
  **Rotate recovery root** `POST /identity-recovery/rotate`; **Acknowledge** a rotation
  `POST /identity-recovery/rotations/:machineId/:epoch/ack`; **Approve / Deny** a quarantined
  claim (two steps: `…/quarantines/:id/approval-token`, then `…/approve` or `…/deny`).
- **Machine-to-machine SSH** (`GET /machines/ssh-health`): per-pair verified/blocked.
- **Autonomous throughput observations** (`GET /autonomous/throughput-floor`): per-run decision.
- Not used today though returned by `/pool`: rope condition per machine, router epoch,
  `holdsLease`, `awakeMachineCount`, `splitBrainState`, `sshEnrollment`, `selfMachineId`.
  `POST /identity-recovery/establish` exists with no UI (the UI says "run machine pairing").

**What is wrong with it today.**
- The status word comes from `online`, which a coarse git beat can hold true for up to an hour
  and which cannot say "never heard since boot" (the 2026-10-25 "offline since Oct 23" incident).
- Connection (rope) health is fetched and never shown; "Dispatcher: Assigned" does not say which
  machine (`glance.js:885`). No "this machine" marker.
- Three sections report any error, including network and 500, as "not enabled"
  (`index.html:6550`, `:6652`, `:6675`).
- PIN-gated buttons never prompt: without an unlock the button label turns into
  "Recent dashboard PIN unlock required" and the next poll wipes it. No confirm on Rotate, Approve,
  Deny. Rename failure is only a tooltip.
- Raw internals as content: machine ids, fingerprints, claim hashes, reason codes, epochs, config
  keys (`glance.js:982`, `index.html:6601–6622`). The 15 s poll clears and rebuilds sections.
- Phone: 28 px padding and 18 px type with no media query (`index.html:4162`).

**The new design.**
- *Arrival (glance):* one sentence from the machine states, e.g. **"3 machines, all answering."**
  / **"Mama PC is struggling: it answers slowly and sometimes not at all."** / **"I can't see the
  Laptop right now; last heard 40 min ago."** Then up to four facts: *Answering* (n of m),
  *Busiest* (name + load verdict), *Leading* (which machine routes conversations), *Needs a look*
  (identity changes to review, blocked SSH pairs, deviant guards; hidden when zero).
- *Layout:* a list of machine cards, this machine first and marked "this one". Each card: name,
  state chip (live / struggling / refusing / silent / stale / unknown, per spec A2), the evidence
  line "last evidence 2 min ago, direct" (spec A5 wording; observer named for peer sightings, e.g.
  "Mac Mini reached it 3 min ago"), load verdict (ok / busy / overloaded / impaired / unknown,
  spec B2) with CPU-idle and memory in small type, sessions "4 of 8". Tap a card → machine detail:
  - *How it's doing:* load signals with their ages; the outside view if it disagrees.
  - *What's using it* (this machine only, from Resource usage; see that section).
  - *My parts here* (this machine only, from Health; see that section).
  - *Safety checks:* named checks needing a look first; "all N on" collapsed.
  - *Connections:* each rope by kind (Tailscale, local network, tunnel) with its state; SSH
    pair status beside it.
  - *Identity:* collapsed "Identity: nothing to review" unless a rotation or claim waits.
  - *Rename* at the bottom.
- *Primary action(s):* reading. The one frequent write is Rename (inline, Bearer, error shown as
  text under the field, not a tooltip).
- *Secondary / destructive actions:* Acknowledge, Approve/Deny a claim, Rotate recovery root live
  in the Identity section only. Each opens a sheet that states in plain words what changes ("Trust
  the new key on Mac Mini. Its older key stops working.") with the technical detail (fingerprints,
  claim hash) behind "Show technical detail". The server requires operator proof, so the shared
  PIN sheet appears if no session is held; a wrong PIN says so in the sheet. First cut may link
  these to legacy; the sheet comes with the native rebuild.
- *Honest states:* loading skeleton per card; "Can't read the machine pool: <reason>" for a
  failed `/pool`; each sub-section has its own failure line ("Couldn't check identity changes:
  timed out") distinct from "not turned on here" (only on a real 503); stale = card dimmed with
  age; unknown = dashed outline, "no evidence since this server started" (spec A2/A3).
- *Multi-machine:* states come from the server's `liveness` field once spec P1 ships; until
  then the console's existing `machineState()` mapping (`home-model.js:255`) is used and labelled
  "estimated". An unreachable machine keeps its card, with the last direct evidence and its age;
  the word "offline" appears only with positive evidence. Single-machine agents see one card and
  no Identity/SSH sections.
- *Rough sketch:*
```
┌──────────────────────────────┐
│ Machines                      │
│ Mama PC is struggling.        │
│ Answering 3/3 · Leading Studio│
├──────────────────────────────┤
│ ● Mac Studio  (this one)  live│
│   ok · 61% idle · 4 of 8      │
│   last evidence now           │
├──────────────────────────────┤
│ ◐ Mama PC          struggling │
│   overloaded · 3% idle        │
│   2 min ago, direct     ›     │
├──────────────────────────────┤
│ ┆ Laptop             unknown  │
│   Mac Mini reached it 9m ago ›│
└──────────────────────────────┘
```

**Merge / split / cut.** Absorbs Resource usage and Health as machine-detail sections. Moves
"Autonomous throughput observations" out (to Work). Machine identity stays here (it is about which
machine is which). Nothing dropped.

**Data.** Existing: `/pool`, `/guards` (and `?scope=pool` for peer guard counts),
`/identity-recovery`, `/machines/ssh-health`, `/resources/summary`, `/systems/status`. Needs the
P1 fields (`liveness`, evidence slots, load report). One small gap: `/resources/summary` and
`/systems/status` are this-machine only, so a peer's detail shows "open on that machine to see its
processes" until a pool form exists; no new route proposed now.

**Effort and order.** M. First. Depends on spec P1 for honest states (can ship on the estimated
mapping, labelled).

**Open questions for the operator.** None.

---

## Health (legacy tab id: `systems`)

**Who comes here, and the one question on arrival.** Someone checking whether the agent itself is
working, usually after something odd. *"Is any part of me broken on this machine?"*

**What it does today (inventory).** `GET /systems/status`, loaded on open and on **Refresh** (no
poll). Glance: headline, tiles Subsystems / Need attention / Recent events; per-subsystem record
(what it does, right now, processes, non-zero stats); event list. No writes, no PIN.

**What is wrong with it today.**
- Headline bug: when `health !== 'healthy'` and no subsystem is `error`, it says **"0 subsystems
  need attention."** and never shows why (`glance.js:1108–1118`).
- Every process status other than `running` shows as "Error", including stopped or disabled
  (`glance.js:1149`). Stats are jargon ("5h rate %", "Gaps", "Applied"); descriptions are server
  prose ("4-layer stack… JSONL issues").
- No poll and no "last updated", so a degraded state is invisible until Refresh.
- The tab reads like an agent-wide verdict but only covers the machine serving the page.

**The new design.**
- *Arrival (glance):* becomes the **"My parts here"** section of a machine's detail. Its one line
  also feeds the machine card: "All my parts are working" / "2 parts need a look: Watchdog,
  Telegram relay" / "Something is off but no single part says why: <overall reason>".
- *Layout:* a short list of parts that need a look, each one sentence ("Watchdog: stopped"); the
  rest collapsed as "12 other parts working". A part opens to: what it does (one plain sentence,
  client-side copy keyed by id with the server text as fallback), processes with honest words
  (running / stopped / turned off / failed), and only the stats that matter for that part, named
  plainly. Recent events as a collapsed "What happened lately" list with times.
- *Primary action(s):* none; reading.
- *Secondary / destructive actions:* none today. Nothing added.
- *Honest states:* "Can't tell: couldn't read my parts (<reason>)"; stale after 2 min with age;
  "Not reporting yet" when the list is empty (never "all operational"). Polls every 30 s while
  visible.
- *Multi-machine:* this machine only, labelled so. A peer's detail says "Open the console on
  <name> to see its parts", until a pool form exists.
- *Rough sketch:*
```
│ My parts here                 │
│ 2 parts need a look           │
│ ▲ Watchdog — stopped        › │
│ ▲ Telegram relay — failing  › │
│   12 other parts working    ▾ │
│   What happened lately      ▾ │
```

**Merge / split / cut.** Merged into Machines (machine detail). The Health tile leaves the group
page. The Home headline already covers "is anything broken"; this is the drill-down.

**Data.** `GET /systems/status` (existing). None new.

**Effort and order.** S. With Machines.

**Open questions for the operator.** None.

---

## Resource usage (legacy tab id: `resources`)

**Who comes here, and the one question on arrival.** Someone asking why a machine is slow.
*"What is using this machine's CPU and memory right now?"*

**What it does today (inventory).** `GET /resources/summary?sinceHours=1`, on open and
**Refresh** (no poll). Glance: headline, tiles CPU right now / Memory right now / Processes;
per-source record (current, average, peak CPU; current and peak memory). No writes, no PIN.
`/resources/footprint` (process counts and trend) and `/resources/samples` exist but are not used.

**What is wrong with it today.**
- Says "right now" with no sample time and no stale warning; `sampleCount` and window are
  fetched and hidden.
- Sessions appear as "Conversation 1a2b3c4d" (`glance.js:~1731`), with no link to the session.
- CPU is not per core and can read over 100% with no note. A missing aggregate shows "—"
  without explanation.

**The new design.**
- *Arrival (glance):* becomes **"What's using it"** in a machine's detail: one line, "The server
  and 4 conversations are using 38% of this machine's CPU and 6.2 GB of memory (sampled 20 s
  ago)." CPU shown as a share of the whole machine (divided by cores), with the raw figure in the
  record.
- *Layout:* top five consumers as rows, named by what they are: "The agent server", "Conversation:
  <session or topic name>" (resolved from `/sessions`), each with CPU and memory; "N smaller"
  collapsed. Row opens to the hour's average and peak. A small "Processes" line from
  `/resources/footprint` ("41 processes, steady over the last hour" / "climbing"), when enabled.
  Each conversation row links to its session.
- *Primary action(s):* tap a conversation row → its session (Work).
- *Secondary / destructive actions:* none. No kill buttons; ending sessions stays in Sessions.
- *Honest states:* "Resource tracking isn't turned on here" only on a real 503; "Can't tell" for
  other failures; stale with age; "No samples yet" when empty.
- *Multi-machine:* this machine only, labelled; peers show their load verdict from the pool
  report and "open on <name> for its processes".
- *Rough sketch:*
```
│ What's using it  (20 s ago)   │
│ 38% CPU · 6.2 GB memory       │
│ Agent server     9% · 1.1 GB  │
│ Conv: Console plan 14% · 900MB›│
│ Conv: Mama PC fix  8% · 700MB ›│
│ 41 processes, steady          │
```

**Merge / split / cut.** Merged into Machines (machine detail). Tile leaves the group page.

**Data.** `/resources/summary`, `/resources/footprint`, `/sessions` (for names). None new.

**Effort and order.** S. With Machines.

**Open questions for the operator.** None.

---

## Accounts (legacy tab id: `subscriptions`)

**Who comes here, and the one question on arrival.** Justin, when a session stalls or a sign-in
needs him, or before planning heavy work. *"How much AI allowance is left on each account, and
does any sign-in need me?"*

**What it does today (inventory).** One controller (`subscriptions.js`), polling every 30 s.
- **Account cards** (JS:340–446): name, "In use now", status, provider, email, quota bars (5-hour,
  weekly, Fable) with reset countdowns, stale-reading age, local repair box.
- **Account × machine grid** (JS:679–1112), with cell states active / needs sign-in / signing in /
  offline / held / can't resolve / email missing / expired / just verified / broken / empty.
- **Let another machine use a subscription** cards (follow-me, JS:459–493).
- **Pending logins panel**: written and tested, never shown (container not passed,
  `index.html:10649–10653`), yet other text points at it (JS:1454).
- Writes:
  - **Approve** follow-me: `POST /mandate/issue-for-machine` with `pin` (server-required).
  - **Set up / Sign in / Retry** a cell: `POST /subscription-pool/matrix/start-cell` with `pin`.
  - **Repair identity**: `POST /subscription-pool/:id/repair-email` with `pin`.
  - **Submit code**: `POST /subscription-pool/follow-me/submit-code`. Bearer.
  - **Cancel** a sign-in: `POST /subscription-pool/follow-me/cancel`. Bearer, native `confirm()`.
  - **Repair sign-in / Try again / Cancel repair / Don't retry on its own** (any machine):
    `POST /subscription-relogin/repair-cell`, operator session (server-required; delivers a
    signed mandate to the peer).
  - Local card repair: `POST /subscription-relogin/:id/{approve,cancel,retry}`, operator session.
  - `POST /subscription-pool/follow-me/scan` on **every poll** (a write-classified POST).
- Reads: `/subscription-pool` (+`?scope=pool`), `/subscription-pool/pending-logins?scope=pool`,
  `/subscription-pool/in-use`, `/subscription-relogin?scope=pool`.
- Server routes with no UI: `/subscription-pool/proactive-swap` (+`/check`),
  `/subscription-pool/login-history`, `POST /subscription-pool/swap`,
  `POST /subscription-relogin/configure` (unattended repair; operator session).

**What is wrong with it today.**
- The most-read thing (allowance left) sits below a wide grid; the grid forces sideways scroll on
  phones (`min-width:620px`, `index.html:3996/4039`); cell buttons are ~24 px tall at 11 px type;
  inputs under 16 px make iOS zoom.
- Two PIN models on one screen: per-cell PIN typed every time vs the global unlock with "Enter PIN,
  then try again" (JS:1400, 1610).
- If a required read fails, nothing is shown (JS:1211–1215); first load can stay blank; no
  "last updated".
- Raw ids and server error strings reach the operator (JS:708, 723, 1457, 1744); jargon
  ("Token auto-refreshed", "Repair identity", "fail-closed", "Warming up").
- The follow-me card has no CSS at all; an in-progress cell can show two Cancel buttons.
- The scan POST keeps running in a hidden tab; countdowns jump in 30 s steps.
- "Tap Switch account" refers to a button on the provider's page without saying so.

**The new design.**
- *Arrival (glance):* **"Plenty left: the busiest account is at 62% of its 5-hour limit."** /
  **"1 sign-in needs you."** / **"Claude is nearly out until 4:10pm; Codex has room."** Facts:
  *Needs you* (sign-ins, approvals; hidden at zero), *Most used* (account + % + resets in),
  *Accounts* (n working of m), *In use now* (which account this machine is serving with).
- *Layout:*
  1. **Needs you** (only when non-empty): one card per thing, each with one button: "Sign in
     Echo's Claude on Mama PC", "Approve Laptop using your Codex account (expires 3:40pm)".
  2. **Allowance**: one row per account, grouped Claude / Codex / other: name, a single bar for
     the tightest window with "62% · resets 4:10pm", second window in small type. Tap → account
     detail: both windows, reading age, which machines it works on, recent sign-in history (from
     `login-history`, read-only), why it last moved a session (from `proactive-swap`, read-only).
  3. **On each machine**: the grid becomes, on phone, a list per account of machine chips ("✓
     Studio  ✓ Mini  ⟳ Mama PC needs sign-in"); desktop keeps a compact table. Tapping a chip
     opens a bottom sheet with that cell's state and its one action.
  4. **Sign-ins in progress**: the restored pending-logins list, one row per active sign-in with
     the link, the code box, time left (live countdown), Cancel.
- *Primary action(s):* "Sign in" / "Repair sign-in" from the Needs-you card: one tap opens the
  sheet; if the server needs operator proof and none is held, the shared PIN sheet appears first;
  the flow (link → code → done) stays in the sheet and is never rebuilt by a poll (F9).
- *Secondary / destructive actions:* Cancel a sign-in and "Don't retry on its own" live in the
  cell sheet, styled quiet, with an in-sheet confirm (no native `confirm()`), Bearer as today.
  Repair identity, Set up an empty cell and Approve follow-me use the PIN sheet. Unattended repair
  settings appear read-only in account detail ("Repairs itself without asking: yes/no") with a
  link to legacy until a native form exists.
- *Honest states:* "Can't read accounts: <reason>"; "No reading yet" per account; reading age
  shown when over 1 h (not 6 h); "Usage isn't readable for this kind of account" (grok);
  partial: a machine whose pool answer failed shows its chips dashed, "no answer from Mama PC";
  repair status unavailable per machine stated in the sheet; outcome lines in plain words
  ("Signed in as justin@… on Mama PC").
- *Multi-machine:* the grid is the pool view; every chip names its machine by nickname (never id;
  "a machine with no name yet" otherwise). Actions on a peer say "This runs on Mama PC" and report
  "Couldn't reach Mama PC" distinctly from refusal.
- *Rough sketch:*
```
┌──────────────────────────────┐
│ Accounts                      │
│ 1 sign-in needs you.          │
├──────────────────────────────┤
│ ▲ Sign in Claude (echo@…)     │
│   on Mama PC    [ Sign in ]   │
├──────────────────────────────┤
│ Allowance                     │
│ Claude · echo   ▓▓▓▓▓░ 62%    │
│   resets 4:10pm · weekly 31%› │
│ Codex · justin  ▓░░░░░ 12%   ›│
├──────────────────────────────┤
│ On each machine               │
│ echo: ✓Studio ✓Mini ⟳MamaPC   │
└──────────────────────────────┘
```

**Merge / split / cut.** Stays its own view (renamed "Accounts"; the tile says "Subscriptions and
sign-ins"). Restores the orphaned pending-logins list. Nothing dropped.

**Data.** Existing reads above, plus `login-history?summary=1&days=7` and `proactive-swap`
(read-only). Two small server changes, both optional:
1. Run the follow-me scan on the server's own timer (or on view open) so the console never POSTs
   on a poll.
2. Let `start-cell`, `repair-email` and `issue-for-machine` accept the operator session header as
   an alternative to a body `pin` (the `requireReloginOperatorPin` pattern, `routes.ts:34524`), so
   one unlock covers the visit. Without it, the PIN sheet still asks for those three each time.

**Effort and order.** L. Third. Ship read-only Allowance + Needs-you links first, then the native
cell sheets with F9 tests carried over from `tests/unit/dashboard-refresh-interaction-hold.test.ts`.

**Open questions for the operator.**
- Should one PIN unlock cover every account action for the visit (change 2 above), or do you want
  the PIN typed for each new sign-in?

---

## What thinking costs (legacy tab id: `spend`)

**Who comes here, and the one question on arrival.** Justin, when wondering whether AI use is
costing real money, or before turning on a paid route. *"Am I paying for anything beyond my
subscriptions, how much, and are limits in place?"*

**What it does today (inventory).**
- Grain selector (daily / hourly / monthly / total), **Refresh**.
- **Spending controls switch** (`money-layer-enable.js`, `GET /routing-spend/enable-status`):
  Turn on / Re-check and turn on / Also record it here / Turn off, each a plan
  (`POST /routing-spend/plan-money-layer`, Bearer) then **PIN commit**
  (`POST /routing-spend/money-layer/commit`); **Restart the agent server**
  (`…/restart-nonce`, Bearer, then `…/restart` with PIN + nonce + hash of the shown text, secure
  context only); post-restart status poll (3 s, ~63 s).
- Glance (`glance.js:1204–1295`): estimated cost, text processed, pay-per-use access; per-model
  and per-key records. Reads `/routing-spend/summary?grain=`, `/routing-spend/caps`.
- **Paid doors** (`spend-arming.js`): door picker, lifetime and daily limit inputs; **Preview cap
  change** / **Preview go live** / **Unfreeze** (plan via `POST /routing-spend/plan`, Bearer) then
  **Approve with PIN** (`/caps/adjust`, `/go-live`, `/unfreeze`, PIN); **Freeze this door**
  (`POST /routing-spend/freeze`, Bearer, one tap, no reason).
- Unused routes: `/routing-spend/caps/log` (audit), `/routing-spend/config-inspect`,
  `/routing-spend/reconciliation`, go-live with `enabled:false` (disarm).

**What is wrong with it today.**
- Two switches with the same meaning to a reader: the figures 503 on `routingSpend.enabled` ("it's
  a development-agent surface, dark on the fleet", `index.html:7029`), while the visible switch
  flips `routingSpend.money.enabled`; turning it on does not clear the 503, and the early return
  hides the Paid doors panel (`:7032`).
- Server plan text shown verbatim carries internals ("FD-13", "Increment D", "lease epoch");
  expiry times are raw ISO strings.
- A frozen door is "paused" in one place and "Frozen" in another; limit inputs start empty
  instead of showing the current limits; success says only "Applied."; no history shown.
- Freeze has no confirm and records reason "not stated".
- Purpose text says "controls below" while the switch sits above.

**The new design.**
- *Arrival (glance):* one sentence across the whole merged view: **"Your subscriptions covered
  everything this week. Pay-per-use: $0."** / **"$4.20 in pay-per-use this week, all on OpenRouter;
  limit $25 a day."** / **"Spending limits are off, and no paid route is open."** Facts: *Paid this
  window*, *Covered by subscription* (link to Accounts), *Background checks* (calls, errors), *Limits*
  (on / off / a route frozen).
- *Layout:* one time control at the top for the whole view (Today / 7 days / 30 days), then
  sections, each with its source named in its header:
  1. **Money** (this section): spend by model and route, per row "Model · route · $ · tokens";
     paid routes with their limits as "$3 of $25 today · $40 of $60 total" and a status word used
     everywhere (Not open / Open / Frozen).
  2. **Background checks** (from LLM activity), 3. **Your conversations** (from Tokens),
     4. **Which model does what** (from Routing map, collapsed). See those sections.
  5. **Spending controls** (collapsed unless something needs you): state in one sentence
     ("Limits are on and enforcing" / "Waiting for a restart to start enforcing"), then the
     actions. History from `caps/log` as "What changed" (time, change, by whom).
- *Primary action(s):* reading. The urgent action, **Freeze**, is one tap on a paid route row,
  then an in-sheet "Freeze OpenRouter? Paid calls stop now. Reason (optional)" and Freeze. Bearer;
  no PIN (halting money must stay cheap).
- *Secondary / destructive actions:* Change limits, Open a route, Unfreeze, Turn limits on/off,
  Restart: each opens a sheet that shows the **plan in plain words** first (console renders from
  the plan's structured fields; the server's verbatim text is shown beneath under "Exact wording
  you are approving", since the commit is bound to it), then the PIN field, then Approve. Limit
  inputs prefill current values. Restart says "This restarts the whole agent server on Mac Studio;
  conversations pause for about a minute." Expiry shown as local time. After success the sheet
  shows the committed change and closes. When the money layer is on through the config file, Turn
  off leads with "This won't stop spending. Freeze stops it now." (`money-layer-disable-store-only`).
  First cut: these link to legacy; native sheets are build step 4.
- *Honest states:* "Spend figures aren't available on this agent" (the `routingSpend.enabled`
  503), stated once and **separately** from the limits switch, so turning limits on is never
  expected to fix it; "Can't tell" for other failures; stale prices flagged per row ("price may be
  out of date"); unpriced tokens counted, not hidden; plain-http restart refusal explained.
- *Multi-machine:* the controls belong to one machine (`machineNickname` from enable-status):
  "These limits are held by Mac Studio." Figures are this machine's ledger, labelled so.
- *Rough sketch:*
```
┌──────────────────────────────┐
│ What thinking costs  [7 days▾]│
│ Subscriptions covered it all. │
│ Paid $0 · 1,240 checks · Limits on│
├──────────────────────────────┤
│ Money        (spending ledger)│
│ No paid route is open.        │
├──────────────────────────────┤
│ Background checks  (AI calls) │
│ 1,240 calls · 3 errors      › │
├──────────────────────────────┤
│ Your conversations (transcripts)│
│ 14 conversations · 9.1M text ›│
├──────────────────────────────┤
│ Which model does what       ▾ │
│ Spending controls           ▾ │
└──────────────────────────────┘
```

**Merge / split / cut.** Host of the merged view; absorbs Tokens, LLM activity, Routing map. Adds
the existing audit log. Disarm (go-live `enabled:false`) is added to the route sheet as "Close
this route", since the route supports it and only arming exists today.

**Data.** Existing: `/routing-spend/summary`, `/caps`, `/caps/log`, `/enable-status`, the plan and
commit routes, `/freeze`. Freeze sends the reason field the route already accepts. None new.

**Effort and order.** M read-only (step 2); M for native controls (step 4).

**Open questions for the operator.** None.

---

## Background checks (legacy tab id: `llm-activity`, Under the hood)

**Who comes here, and the one question on arrival.** Someone wondering what the agent's automatic
AI checks do. *"Are my background checks doing real work, failing, or mostly skipping?"*

**What it does today (inventory).** `GET /metrics/features?sinceHours=24|168|720`, window selector
(default 7 d) and **Refresh**, no poll. Tiles Components / AI calls / Acted / Errors; per-feature
record (runs on, calls, acted, skipped, errors, text in/out, p50/p95). No writes.

**What is wrong with it today.** Promises cost and never shows it (`index.html:3733`). "Acted"
counts components while "Errors" counts calls (`glance.js:1482`, `:1498`), side by side. Skipped
has no tile. "Runs on" shows the framework, not the model. Jargon ("sentinels, gates",
"Components").

**The new design.**
- *Arrival (glance):* section 2 of the cost view: "1,240 background checks; 3 failed; the
  tone check skipped 40% to save limits."
- *Layout:* rows per check, named in plain words ("Message tone check"), each "calls · acted ·
  skipped · failed" as one small stacked bar plus numbers, the model it ran on, and tokens. A check
  with failures or mostly skipped sorts first. Row opens to latency and per-model split
  (`byModel`). Cost shown per check only where a paid route served it (join of `byModel` with the
  price list already applied in `/routing-spend/summary`); otherwise "covered by subscription".
- *Primary action(s):* none.
- *Secondary / destructive actions:* none.
- *Honest states:* 503 → "Not tracked on this agent"; failure → Can't tell; empty → "No background
  checks ran in this window".
- *Multi-machine:* this machine's ledger, labelled.
- *Rough sketch:*
```
│ Background checks (AI calls)  │
│ Tone check  ▓▓▓▒▒░  410 · 2✗ ›│
│ Topic intent ▓▓▓▓▓  300      ›│
│ +14 more                    ▾ │
```

**Merge / split / cut.** Into What thinking costs. The Under the hood tile points to this section.

**Data.** `/metrics/features` (existing, incl. `byModel`). None new.

**Effort and order.** S, with the cost view (step 2).

**Open questions for the operator.** None.

---

## Your conversations (legacy tab id: `tokens`)

**Who comes here, and the one question on arrival.** *"How much text are my conversations
processing, and which ones are the heavy ones?"*

**What it does today (inventory).** `GET /tokens/summary`, `/tokens/sessions?limit=10`,
`/tokens/orphans?idleMs=1800000`; **Refresh**; fixed 24 h. Tiles Text processed / Recent
conversations / Idle; records with project path and session id. No writes.

**What is wrong with it today.** The session count is capped at 10 (`index.html:6898`) while the
total covers everything, so the headline undercounts. Codex usage is fetched and dropped. Two tiles
open the same list. Absolute paths and UUIDs as content. Window fixed while the neighbours differ.

**The new design.**
- *Arrival (glance):* section 3 of the cost view: "14 conversations processed 9.1M tokens of text
  this week (Claude 8.2M, Codex 0.9M)." Counts from `summary.sessionCount`, not the list length.
- *Layout:* top conversations by tokens, named by session/topic name, with the project's short
  name; "Idle with no activity for 30 min" as a collapsed count. Row links to the session.
- *Primary action(s):* tap a row → the session.
- *Secondary / destructive actions:* none.
- *Honest states:* 503 → "Not tracked here"; "Last scanned <age>" if available, else not claimed.
- *Multi-machine:* this machine's transcripts, labelled.
- *Rough sketch:*
```
│ Your conversations (transcripts)│
│ 14 · 9.1M tokens              │
│ Console plan      2.3M      › │
│ Mama PC fix       1.1M      › │
```

**Merge / split / cut.** Into What thinking costs. Tile removed from the group page.

**Data.** Existing routes with `since=` set from the shared time control (`parseSinceMs`,
`routes.ts:12692`) and `limit=20`. None new.

**Effort and order.** S, step 2.

**Open questions for the operator.** None.

---

## Which model does what (legacy tab id: `routing-map`, Under the hood)

**Who comes here, and the one question on arrival.** *"Which AI model handles which kind of
background work, and what is the backup?"*

**What it does today (inventory).** `GET /intelligence/routing/chains`, **Refresh**; headline from
the quick-task chain; tiles per chain showing the number of fallback positions; lane and job
records. No writes by design.

**What is wrong with it today.** Tile numbers are chain lengths, meaningless to a reader. The
headline reflects one chain only. Jargon ("lane", "door", "skippedInIncrementA" shown as "Skipped
for now"). It shows the static design, not which model actually served recently.

**The new design.**
- *Arrival (glance):* section 4 of the cost view, collapsed: "Quick checks run on GPT-6 Luna;
  judging runs on Opus 5.5; Claude is the last fallback."
- *Layout:* four plain rows (Quick checks, Sorting, Judging, Writing), each "first choice → backup
  → last resort", with a tag where a choice is pay-per-use. Beside each, "actually used lately"
  from `/metrics/features` `byModel`, so plan and reality sit together. Job list collapsed.
- *Primary action(s):* none.
- *Secondary / destructive actions:* none (routing is changed in Settings/config, not here).
- *Honest states:* 503 → "No AI routing configured on this agent"; failure → Can't tell.
- *Multi-machine:* this machine's routing, labelled.
- *Rough sketch:*
```
│ Which model does what       ▴ │
│ Quick   Luna → Codex → Claude │
│ Judging Opus → Luna           │
│ used lately: Luna 92%         │
```

**Merge / split / cut.** Into What thinking costs (collapsed). Under the hood tile points here.

**Data.** `/intelligence/routing/chains`, `/metrics/features`. None new.

**Effort and order.** S, step 2.

**Open questions for the operator.** None.
