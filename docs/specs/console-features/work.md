# Console features — the Work group

Native rebuild plans for the seven legacy tabs in the Work group: Sessions, Jobs,
Commitments, Projects, Initiatives, Blockers, Send content. Each section follows
`TEMPLATE.md`. Parent plan: `docs/specs/console-makeover.md`. Research:
`console/research/SYNTHESIS.md`.

## What "Work" means to the operator

Justin opens Work to answer one question: **"Is my agent doing what it should, and is
anything waiting on me?"** That splits into four everyday questions, and the new Work
page has exactly four places, one per question:

| Place | The question | Legacy tabs it replaces |
|---|---|---|
| **Sessions** | What is running right now, and can I step in? | Sessions, Send content |
| **Schedule** | What runs on its own, and did it actually run? | Jobs |
| **Promises** | What did you say you would do, and is any of it on me? | Commitments |
| **Plans** | How is the longer work going, and what is in the way? | Projects, Initiatives, Blockers |

Seven tabs become four. Nothing is dropped: every control and write action in the
seven legacy tabs is inventoried below and has a home in the new design.

## Merges recommended

1. **Projects + Initiatives → one "Plans" view.** They are the same records. `GET /projects`
   is `initiativeTracker.list({ kind: 'project' })` (`src/server/routes.ts:20851`), and the
   Initiatives tab hides projects and their children by default with
   `excludeKind=project&excludeParented=true` (`dashboard/index.html:9633`). Today the
   operator has to know which kind a piece of work is to find it. One list, with a
   project shown as a plan that has rounds, removes that.
2. **Blockers → the "In the way" section of Plans.** The operator's question about a
   blocker is never "show me the blocker ledger"; it is "is my work stuck, and is that on
   me?". The legacy tab is read-only and usually short. It keeps its own anchor
   (`/dashboard/console/#/work/plans/in-the-way`) so links still land on it.
3. **Send content → an action inside Sessions.** Pasting a long text is always "send this
   to a session", so it belongs on the session. The legacy tab's "Auto (most recent
   session)" target becomes a "Paste to a session" button on the Sessions list that
   asks which session (most recent preselected).
4. **Commitments is renamed "Promises".** The operator says "promise"; the legacy tab's own
   headline already does ("I'm carrying 3 open promises").
5. **Jobs is renamed "Schedule".** "Job" is an engineering word; "what runs on its own"
   is what he means.

Old links keep working: `?tab=projects`, `?tab=initiatives`, `?tab=blockers`,
`?tab=dropzone` go through the URL adapter from the parent plan to the new place once
each native view ships, and to legacy until then.

## Build order within the group

1. **Promises** (S/M). The largest existing capability with no face (research), Home
   already carries its rules (`dashboard/console/home-model.js:179`), and the legacy tab
   undercounts (it shows only beacon-watched promises). Read plus "Mark delivered".
2. **Plans, including In the way** (M). Fixes two real defects (a hardcoded "Ack round 0"
   button and silent failures on Halt) and removes three tabs.
3. **Schedule** (M). Adds the honesty states the legacy tab lacks (overdue, skipped,
   running long) and the pool view the server already offers.
4. **Sessions, including Paste** (L). Most used, but the legacy tab works on a phone today
   and carries the live terminal; rebuild it last, when the console's design system is
   proven on simpler views.

All four share one list-and-detail pattern (a headline, at most four facts, a grouped
list, a full-screen detail sheet on phone), built once with Promises and reused.

## Shared rules for every view in this group

- **The headline is a sentence, and the facts under it add up to it.** Every count in
  the headline has a fact you can tap to see exactly those records (the glance floors in
  `docs/specs/dashboard-ux-standard.md`).
- **"Needs you" is always first and always small.** Items waiting on the operator lead;
  routine items are a count you can open. Items untouched 14+ days go to "probably
  already handled", listed but not counted (the same rule as Home).
- **Working, slow, stuck and failed are four different looks.** No list is only
  successes.
- **Writes use the bearer token only.** None of the routes in this group needs operator
  proof (checked: no PIN gate on any `/sessions`, `/jobs`, `/commitments`, `/projects`,
  `/initiatives`, `/blockers` or `/pastes` route). No PIN is added. Destructive actions
  get a plain confirmation sheet, not a PIN.
- **Ids, cron text, raw states and model ids live one tap down**, in a "Details" fold
  in mono type, never on the list.

---

## Sessions (legacy tab id: `sessions`)

**Who comes here, and the one question on arrival.** Justin, usually on his phone, when a
reply is slow or he wants to see the agent work. "What is running right now, and is any
of it stuck or waiting on me?"

**What it does today (inventory).** All bearer-only; none PIN-gated.
- Session list: local sessions live over the WebSocket (`/ws?token=`), other machines via
  `GET /sessions?scope=pool` (polled). Each row: name, type badge (interactive/job), model
  badge, platform icon, machine badge, "duplicate" badge, running time, tool names,
  background-task count, "waiting Nm" after 10 idle minutes, event count
  (`dashboard/index.html:4729`).
- Idle machines: a row per pool machine with no sessions, from `pool.machines[].emptyState`.
- Badge legend (the "?" button). Session count.
- **New session** ("+"): name, platform (auto/Telegram/Slack/headless), door, model,
  machine (only when 2+ machines; offline and clock-out machines disabled) →
  `POST /sessions/create`; reads `/topic-profile/options`, `/pool`,
  `/topic-profile/options?machine=` (`:5212`–`:5395`).
- **Default for new topics** row → sheet: door + model, Save / Clear →
  `POST /topic-profile/new-topic-default` (`:5622`).
- **Close session** (× on each row, "× Close" in the terminal): local `DELETE /sessions/:name`,
  other machines `POST /sessions/:name/remote-close`; browser `confirm()`, stronger wording
  for protected sessions; outcomes "already closed", "closed on X", "outcome unknown"
  (`:5797`).
- **Terminal view**: live stream (also streamed from another machine through the relay),
  scroll-back history loaded in batches up to 50,000 lines, "Resume live output" button
  when scrolled up, one-line input + Send, keys Enter, y, n, Ctrl+C, Esc, four arrows,
  back button.
- **Door + model** sheet on a Telegram session: shows the current pin and its source,
  switch → `POST /topic-profile/:topicId`, then watches `/sessions` until the restart lands.

**What is wrong with it today.**
- The list row is a wall of badges: tool names, event counts and model families are
  engineer facts; the one thing he wants ("is it doing something?") is a small grey
  "waiting 14m" tag that appears only after 10 minutes (`:4777`).
- "Waiting" cannot be told apart from "stuck" or "done and waiting for you".
- The terminal header carries eleven buttons in one row; on a 390 px phone Ctrl+C (which
  interrupts the agent) sits beside Enter (`:3198`–`:3212`).
- Close uses the browser's `confirm()`, which looks like a system error on a phone.
- The input is a single line; anything long needs the separate Send content tab.
- A bare "OPUS" badge means "exact version not recorded", explained only in the legend.

**The new design.**
- *Arrival (glance):* headline, for example "4 sessions running. One has been quiet for
  25 minutes." Facts: **Running** (count), **Waiting on you** (sessions whose last turn
  ended asking the operator something; see Data), **Quiet** (no activity 10+ min),
  **Machines** ("3 of 3 answering").
- *Layout:* phone: the facts, then a list grouped by state: *Needs a look* (quiet, or
  duplicate), *Working*, *Idle machines* (one line each). A row is two lines: the name
  (Telegram topic name when there is one) and "Mac Studio · 2 h · active 1 min ago".
  Tapping opens the session full-screen: terminal on top, composer at the bottom, a
  title bar with the name, machine and model in words ("Opus 5.5" or "Opus, version not
  recorded"), and a "⋯" menu. Desktop: list on the left, the open session on the right.
- *Primary actions:* open a session (one tap). Type to it: a multi-line composer that
  grows to 6 lines; Send. A **Keys** tray beside the composer opens a row of Enter, y, n,
  Esc and arrows; **Stop (Ctrl+C)** is the last key, red, separated, and asks once
  ("Interrupt what it is doing?") because it is the one key that loses work.
- *Secondary / destructive actions:* in the "⋯" menu: Switch door and model, Paste long
  text (see Send content), Close session. "New session" is a button at the top of the
  list; "Default for new topics" sits inside the New session sheet as "Change the
  default", not a standing row. Close opens a bottom sheet: "Close 'Bug: login loop' on
  Mac Mini? Its conversation is kept." Protected sessions add "This one is normally kept
  running." No PIN; the server allows it with the bearer token.
- *Honest states:* loading (skeleton rows); empty ("Nothing is running. Machines: all
  answering."); can't tell (the list request failed: shows the reason, keeps the last list
  with its age); partial (named machines did not answer: "Mac Mini did not answer; its
  sessions are not shown"); stale (WebSocket down: a dashed banner "Live updates paused,
  reconnecting", list keeps its age). Per session: *working* (activity under 2 min),
  *quiet* (10+ min, shows the exact minutes, never called stuck), *no reading* (no
  telemetry), *starting*. Close: "closed", "already closed", "outcome unknown, checking".
  Door switch: "switching…" until the new model is seen, then "now on Fable 5".
- *Multi-machine:* one list across the pool, each row naming its machine. A machine that
  did not answer gets one dashed row "Mac Mini: not answering (last seen 6 min ago)". The
  duplicate badge becomes a *Needs a look* entry: "Running on two machines at once".
- *Rough sketch:*
```
┌──────────────────────────────┐
│ Sessions            [+ New]  │
│ 4 running. One quiet 25 min. │
│ ┌──────┐┌──────┐┌──────┐     │
│ │4 run ││0 you ││1 quiet│    │
│ └──────┘└──────┘└──────┘     │
│ NEEDS A LOOK                 │
│ ◌ Feedback drain    25 min › │
│   Mac Mini · 3 h             │
│ WORKING                      │
│ ● Bug: login loop   1 min  › │
│   Mac Studio · 40 min        │
│ ● Topic 127504      now    › │
│ IDLE: Laptop (answering)     │
│ [Paste to a session]         │
└──────────────────────────────┘
open session:
│ ‹ Bug: login loop    ⋯       │
│ Mac Studio · Opus 5.5        │
│ ░░ terminal ░░░░░░░░░░░░░░░░ │
│ [▼ Back to live]             │
│ ┌──────────────────┐[Keys]   │
│ │ Type a message…  │[Send]   │
└──────────────────────────────┘
```

**Merge / split / cut.** Absorbs Send content (see that section). Keep the badge legend's
content but as plain words in the row, so the legend is cut. Tool names and event counts
move to "Details" in the "⋯" menu, not dropped.

**Data.** Existing: `/ws`, `GET /sessions?scope=pool`, `/pool`, `POST /sessions/create`,
`DELETE /sessions/:name`, `POST /sessions/:name/remote-close`, `/topic-profile/*`.
*Waiting on you* needs no new route only if the session already reports that its last
turn ended on a question; it does not today, so in this build the fact is omitted, not
guessed. Smallest addition, later: a `telemetry.lastStopAt` timestamp so "quiet after a
finished turn" (done) can be told from "quiet mid-turn" (maybe stuck).

**Effort and order.** L. Last in the group. Depends on the shared list/detail pattern and
on loading the terminal library inside the console's CSP.

**Open questions for the operator.** None.

---

## Send content (legacy tab id: `dropzone`)

**Who comes here, and the one question on arrival.** Justin, when he has a long text
(a log, a document, a big prompt) to give a session. "Did my text reach the session?"

**What it does today (inventory).** All bearer-only.
- Form: optional label (256 chars), a large text box with a character and token count,
  target session select ("Auto (most recent session)" plus this machine's interactive
  sessions), Send → `POST /pastes` (`dashboard/index.html:8141`).
- Result line: "Delivered N chars to session X" or "Waiting for session — will be
  delivered when a session starts", or the server's error.
- Recent pastes (`GET /pastes`, last 20): label, size, age, status (delivered / waiting /
  other), delete × → `DELETE /pastes/:id`.
- Live status change over the WebSocket (`paste_delivered`, `paste_acknowledged`).
- Notice: "Stored locally for up to 7 days. Avoid pasting secrets or credentials."

**What is wrong with it today.**
- It is a whole tab for one action that always targets a session.
- The session list is this machine's only (`:8096`); sessions on other machines cannot be
  targeted, and nothing says so.
- The console's tile describes it as "Paste text or files", but it takes text only
  (`dashboard/console/nav-model.js`). Fix the copy.
- Delete has no confirmation and no result.
- "Auto (most recent session)" hides which session will get it until after sending.

**The new design.**
- *Arrival (glance):* not a page. "Paste long text" is in an open session's "⋯" menu
  (target fixed to that session), and "Paste to a session" sits at the bottom of the
  Sessions list (asks which session; the most recently active one is preselected and
  named, "Topic 127504, active 1 min ago").
- *Layout:* a full-height sheet on phone: label field, text box with "12,400 characters,
  about 3,100 tokens", the target named in words, Send. Below, "Recent pastes" collapsed
  to its count ("3 in the last 7 days").
- *Primary action:* paste, Send: two taps from an open session.
- *Secondary / destructive actions:* in Recent pastes, each row has "Delete" behind a swipe
  or a "⋯"; it asks "Delete this paste? The session keeps what it already read."
- *Honest states:* sending; delivered (with the session name); waiting ("No session was
  ready; it will be delivered when one starts", amber, stays in Recent until delivered);
  failed (the server's message, text kept in the box so nothing is lost); can't tell
  (history request failed). Recent shows only this machine's pastes and says so.
- *Multi-machine:* the target picker lists only sessions on this machine, with one line
  "Sessions on other machines can't receive pastes yet". Honest rather than hidden.
- *Rough sketch:*
```
┌──────────────────────────────┐
│ Paste to: Topic 127504  [▾]  │
│ What is it? (optional)       │
│ ┌──────────────────────────┐ │
│ │ paste here…              │ │
│ │                          │ │
│ └──────────────────────────┘ │
│ 12,400 chars · ~3,100 tokens │
│ Kept 7 days. No passwords.   │
│ [          Send          ]   │
│ Recent pastes (3)          › │
└──────────────────────────────┘
```

**Merge / split / cut.** Merged into Sessions; the tab is retired once Sessions ships.
`?tab=dropzone` opens Sessions with the paste sheet up.

**Data.** Existing `POST /pastes`, `GET /pastes`, `DELETE /pastes/:id`, WebSocket paste
events. No new route. (Pool targeting would need a route change; not proposed.)

**Effort and order.** S, built with Sessions.

**Open questions for the operator.** None.

---

## Jobs → "Schedule" (legacy tab id: `jobs`)

**Who comes here, and the one question on arrival.** Justin, when he wonders whether
background work happened, or wants to start or stop one. "Did everything that should
have run actually run?"

**What it does today (inventory).** All bearer-only.
- List (`GET /jobs`, this machine) with live updates over `GET /jobs/events` (SSE):
  status dot, name, failure count, description, plain schedule, model, priority badge,
  instar/user/fork badge, a "!" lock-trust warning (`dashboard/index.html:8655`).
- Summary cards: Total, Running, Failing, Disabled. Sort (status, priority, name, last
  run). Filter chips: All, Running, Failing, Disabled, Instar defaults, Your jobs.
- Detail: status sentence, last run (time and age), last result, last error, next run;
  50-run sparkline (success/failure/skipped); run history table (time, result, duration,
  error) from `GET /jobs/:slug/history?limit=50`; folded configuration (schedule with raw
  cron, model, priority, execution type, supervision tier, tags, pre-flight check,
  machines).
- **Run now** → `POST /jobs/:slug/run`, then polls for up to 120 s; handles 409 "already
  running" and 429 "rate limited".
- **Enable/disable toggle** → `PATCH /jobs/:slug`; confirmation only for high/critical.
- **Override** (copy an instar default to edit) → `POST /jobs/:slug/override`;
  **Unfork** (back to the default, keeps a 30-day backup) → `POST /jobs/:slug/unfork`;
  **Edit** (name, description, schedule, priority, body; conflict check) →
  `POST /jobs/:slug/save`.
- **Migration banner**: Confirm migration complete → `POST /jobs/migration-confirm`;
  Roll back → `POST /jobs/migration-abandon` (from `GET /jobs/migration-status`).
- **Issues card** (orphan manifest, shadow body, missing migration, staged save, case
  collision): kind filter, refresh, dismiss-until-reload.

**What is wrong with it today.**
- No "it should have run and didn't". A job whose next run is in the past and is not
  running (the scheduler may be stalled) looks healthy; the memory and CLAUDE.md both tell
  the agent to check exactly this by hand.
- "Skipped" exists only as a grey sparkline dot, with no reason.
- "Running" means `lastResult === 'pending'`, with no sense of "longer than usual".
- Run history shows times without dates (`:8902`), so last night and this morning blur.
- The raw cron text sits beside the plain schedule (`:8802`); the Issues card's kinds are
  internal vocabulary; the summary, six chips and a sort select fill a phone before the
  first job.
- Local only, though `GET /jobs?scope=pool` exists (`src/server/routes.ts:16788`).
- "Run now" gives up after 120 s with "Still running..." and resets, losing the answer.
- `toggleJobEnabled` (`:8559`) is dead code; `/enable` and `/disable` are unused.

**The new design.**
- *Arrival (glance):* headline, for example "12 scheduled jobs. 1 failed its last two
  runs; 1 is late." Facts: **Late** (next run over 10 min in the past and not running),
  **Failing**, **Running** (with "longer than usual" when past twice its median
  duration), **Off**.
- *Layout:* phone: facts, then groups *Needs a look* (late, failing, running long),
  *Coming up* (next three by next run, "in 12 min"), *Everything else* (collapsed, with a
  search field). A row: name, then "Every 4 hours · last ran 2 h ago ✓". Detail sheet:
  a sentence ("Runs every 4 hours. Last run 2 h ago took 3 min and succeeded. Next at
  16:00."), buttons Run now and an On/Off switch, then "Last 20 runs" as a strip of
  marks with day separators; tapping a mark shows date, time, duration, and the error or
  skip reason. "Details" fold: raw cron, model, priority, supervision, tags, machines,
  origin (instar default / yours / your copy of a default).
- *Primary actions:* Run now (one tap; the button becomes a live line "Running 1 min 20 s"
  and keeps following the run until it ends, however long). On/Off switch (one tap; asks
  only for high and critical jobs, as today).
- *Secondary / destructive actions:* in "⋯" on the detail: Edit (for your jobs), Make my
  own copy (for instar defaults, explained: "instar stops updating it"), Go back to the
  default (with "your version is kept 30 days"). Edit is a full-screen form; the conflict
  message stays. Migration actions and file issues move to a single "Setup issues (2)"
  line at the bottom of the page, each explained in a sentence, with the legacy kinds in
  Details.
- *Honest states:* loading; empty ("No scheduled work yet. Ask me in chat to do something
  on a schedule."); can't tell (`/jobs` failed, or the scheduler is absent: "The scheduler
  is not running on this machine", not an empty list); stale (SSE dropped: "live updates
  paused" with age); per job *late*, *skipped (reason)*, *running long*, *failed*, *off*.
  Run now: already running, rate limited, refused (server text), still running.
- *Multi-machine:* pool view by default (`?scope=pool`): each job names its machine; the
  same job on two machines shows once with "on Mac Studio and Mac Mini". A machine that
  did not answer: "Mac Mini did not answer; its jobs are not shown." Run now and the
  switch act on the machine that owns the row; if the route cannot target a peer, those
  buttons show only on this machine's rows with "Open on Mac Mini" otherwise.
- *Rough sketch:*
```
┌──────────────────────────────┐
│ Schedule                     │
│ 12 jobs. 1 failing, 1 late.  │
│ [1 late][1 failing][0 run][2 off]
│ NEEDS A LOOK                 │
│ ✕ Git sync           Studio ›│
│   failed twice · 2 h ago     │
│ ⏱ Feedback process    Mini  ›│
│   due 40 min ago, not run    │
│ COMING UP                    │
│ ○ Memory hygiene   in 12 min │
│ ○ Guardian pulse   in 30 min │
│ Everything else (8)        › │
│ Setup issues (2)           › │
└──────────────────────────────┘
```

**Merge / split / cut.** Stays its own view. Cut: the sort select (the grouping does its
job) and the "Instar defaults / Your jobs" chips (become a filter inside Everything
else). Dead code `toggleJobEnabled` is not carried over.

**Data.** Existing: `GET /jobs?scope=pool`, `/jobs/events`, `/jobs/:slug/history`,
`/jobs/:slug/run`, `PATCH /jobs/:slug`, override, unfork, save, migration-status/confirm/
abandon, and the issues route the legacy card reads. "Late" and "running long" are
computed from existing `state.nextScheduled`, `state.lastRun` and history durations.
Skip reasons come from history rows if they carry one; if not, a skip shows "skipped (no
reason recorded)". No new route.

**Effort and order.** M. Third.

**Open questions for the operator.** None.

---

## Commitments → "Promises" (legacy tab id: `commitments`)

**Who comes here, and the one question on arrival.** Justin, from Home's "What I've
promised" card or when he remembers asking for something. "Is anything I asked for being
dropped, and is any of it waiting on me?"

**What it does today (inventory).** All bearer-only.
- `GET /commitments?status=active` (this machine). Headline ("I'm carrying N open
  promises; …"); tiles Open, Due soon, Overdue, Waiting on you, Quiet; each opens a list
  of promise summaries; each row opens the full record (promise text, id, topic, cadence,
  heartbeats, last heartbeat, soft and hard deadline) (`dashboard/glance.js:440`–`:590`).
- **Mark delivered** on the record → `POST /commitments/:id/deliver`; failure shows a
  browser `alert()`.
- Honest notes for "not set up on this agent" and "could not load".

**What is wrong with it today.**
- It shows only promises with a beacon (`beaconEnabled && status === 'pending'`,
  `glance.js:437`). A promise without a beacon, a missed one, or one from another machine
  does not appear, while Home (which reads `?scope=mesh` with the owner and blocked-on
  rules) counts them. The two disagree.
- No distinction between *the agent owns this* and *this is on you* except one tile.
- The full record is raw fields: cadence in seconds, heartbeat counts, ids.
- No way to drop a promise that no longer matters, though the server has `withdraw`.
- Missed (`violated`) and expired promises are invisible, so the list is only the
  cheerful half.

**The new design.**
- *Arrival (glance):* uses Home's rules exactly (one model, `home-model.js`, so both
  screens always agree). Headline: "2 promises are waiting on you. 9 more I'm carrying."
  Facts: **Waiting on you**, **Missed** (violated or past hard deadline), **Due soon**,
  **I'm carrying** (agent-owned, on track).
- *Layout:* phone: facts, then *Waiting on you* (each row: what was asked, in his words,
  then "you said: 'send me the summary' · 2 d ago · on your yes"), *Missed*, *Due soon*,
  *I'm carrying* (collapsed to a count), *Probably already handled* (14+ days untouched,
  collapsed, not counted), *Closed recently* (delivered, withdrawn, last 7 days). The
  detail sheet reads as a short story: "You asked: … I said: … Waiting on: your approval
  for a production deploy. Next check: Friday 09:00. Topic: Bug: login loop (open in
  Telegram)." Details fold: id, cadence, heartbeats, deadlines, origin machine.
- *Primary actions:* for waiting-on-you rows, the action that unblocks it: "Open the
  conversation" (deep link to the topic) is the default; the reply happens in Telegram,
  where the agent hears it. For agent-owned rows: **Mark delivered** (one tap, confirm
  inline "Mark as done?").
- *Secondary / destructive actions:* "Drop this promise" in "⋯", asking for a one-line
  reason (the server requires one) → `POST /commitments/:id/withdraw`. "Resume reminders"
  shows only on a paused beacon → `POST /commitments/:id/resume`. No PIN.
- *Honest states:* loading; empty ("No open promises."); can't tell (request failed, or
  `enabled:false`: "Promise tracking is off on this agent"); partial (no replica rows:
  "Only this machine's promises are visible"; a replica over 15 min old: "Mac Mini's
  promises are from 22 min ago"); per promise *missed*, *due soon*, *paused reminders*,
  *waiting on you*. A failed write shows the server's message on the sheet, never an
  `alert()`.
- *Multi-machine:* `?scope=mesh`; rows from another machine say "from Mac Mini, 3 min
  old". Writes to a replica row go to the owner (the server forwards); a 409 "ambiguous
  across machines" is shown in words with a retry that names the origin.
- *Rough sketch:*
```
┌──────────────────────────────┐
│ Promises                     │
│ 2 waiting on you. 9 more     │
│ I'm carrying.                │
│ [2 you][1 missed][0 soon][9] │
│ WAITING ON YOU               │
│ ▸ Approve the prod deploy  › │
│   2 d ago · your yes         │
│ ▸ Pick a name for the bot  › │
│ MISSED                       │
│ ✕ Morning summary         › │
│   due yesterday 08:00        │
│ I'm carrying (9)           › │
│ Probably handled (14)      › │
│ Closed this week (6)       › │
└──────────────────────────────┘
```

**Merge / split / cut.** Stays its own view (it is Home's second-most important card's
detail). The legacy "Quiet" tile becomes the *paused reminders* state on rows.

**Data.** Existing: `GET /commitments?scope=mesh`, `POST /commitments/:id/deliver`,
`/withdraw`, `/resume`. No new route.

**Effort and order.** S/M. First; reuses Home's model and builds the shared pattern.

**Open questions for the operator.** Should "Drop this promise" be available to him at
all, or should a promise only ever be closed by the agent (so a dropped promise is
always the agent's own decision, recorded in the conversation)? Default if unanswered:
offer it, with the required reason.

---

## Projects (legacy tab id: `projects`)

**Who comes here, and the one question on arrival.** Justin, when the agent is running a
multi-round plan. "Which round is it on, and does it need my go-ahead?"

**What it does today (inventory).** All bearer-only.
- `GET /projects` (active only), then `GET /projects/:id?reconcile=false` for up to 25.
  Card per project: title, id and version (mono), drift badge ("drift: minor-drift"),
  per round "Round 0: name — status", a progress bar (merged / total items) and a stage
  count line ("outline: 2 • building: 1 • merged: 3") (`dashboard/index.html:9426`).
- **Halt** → `POST /projects/:id/halt` with reason "user-halt-from-dashboard"; no
  confirmation.
- **Ack round 0** → `POST /projects/:id/ack` with `forRoundIndex: 0`.
- Refresh button, auto-poll.

**What is wrong with it today.**
- **"Ack round 0" always acknowledges round 0** (`:9575`), whatever round the project is
  on. It is a bug, not a label problem.
- Halt has no confirmation and its result is swallowed (`catch {}`, `:9591`); a refused
  halt (409 "no halt-able round") looks like nothing happened.
- No sign of when the agent needs his acknowledgement (`unacknowledgedAdvanceCount`,
  `firstLaunchAckAt` exist on the record).
- Drift verdicts are shown as raw tokens ("premise-violated").
- Pipeline stage names ("spec-converged") as the progress text.
- Server actions advance, resume, abandon, accept-partial, run-round, drift-check,
  claim-ownership exist but are not offered; that is fine (they are the agent's), but
  Resume after his own Halt is missing.

**The new design.**
- *Arrival (glance):* projects appear in **Plans** (see Initiatives for the page). A
  project row: title, then "Round 2 of 4 · 3 of 5 pieces merged · waiting for your OK".
- *Layout:* the project detail sheet shows the rounds as a vertical track: done rounds
  collapsed with a check, the current round open with its pieces as plain-word chips
  ("2 being built, 1 written up, 2 merged"), future rounds as names. Drift reads as a
  sentence: "Last check: the plan still holds" / "The plan's starting assumption no
  longer holds — the agent paused it" (red) / "Needs a human look" (dashed).
- *Primary action:* when the project is waiting for him (unacknowledged advance or first
  launch), one amber button: **OK, continue round 2** → `POST /projects/:id/ack` with the
  *current* round index.
- *Secondary / destructive actions:* "⋯": **Pause this project** (was Halt; asks "Pause?
  The current round stops at a safe point." and sends a reason he may type) and, when
  halted, **Resume** → `POST /projects/:id/resume`. Abandon and accept-partial stay
  agent-side, not offered. No PIN.
- *Honest states:* loading; empty ("No multi-round plans running."); can't tell (`/projects`
  503: "Plan tracking is off on this agent", not "endpoint unavailable"); detail fetch
  failed for one project (that row shows "Couldn't load its rounds" with retry, others
  render); version conflict ("Changed while you looked; refreshed"); refused halt shows
  the server's reason; more than 25 projects says "showing 25 of N".
- *Multi-machine:* this machine's records; the Plans page states "This machine's plans".
- *Rough sketch (project detail):*
```
┌──────────────────────────────┐
│ ‹ Console makeover        ⋯  │
│ Round 2 of 4 · waiting on you│
│ ✓ Round 1  Home screen       │
│ ● Round 2  Work group        │
│   2 building · 1 written ·   │
│   2 merged     ▓▓▓▓░░░░      │
│ ○ Round 3  Capacity group    │
│ ○ Round 4  Switch-over       │
│ Plan check: still holds      │
│ [ OK, continue round 2 ]     │
│ Details ›                    │
└──────────────────────────────┘
```

**Merge / split / cut.** Merged into Plans (same store). The legacy id/version line moves
to Details.

**Data.** Existing `GET /projects`, `/projects/:id`, `/ack`, `/halt`, `/resume`. No new
route.

**Effort and order.** M, shipped with Plans (second).

**Open questions for the operator.** None.

---

## Initiatives (legacy tab id: `initiatives`) — the Plans page

**Who comes here, and the one question on arrival.** Justin, to see longer efforts.
"Is the long work moving, and does any of it need me?"

**What it does today (inventory).** Read-only; no write actions in the dashboard.
- `GET /initiatives` (status filter Active / All / Completed / Archived / Abandoned; "Show
  projects + children" checkbox) and `GET /initiatives/digest`.
- Headline ("N initiatives in flight; M need you"); tiles In progress, Needs you, Ready to
  move on, Check-in due, Idle; rows open a record (title, status, description, steps done,
  last worked on) or a signal record (why it needs a look, detail)
  (`dashboard/glance.js:1806`). Refresh.

**What is wrong with it today.**
- The "In progress" tile counts whatever the filter returned, so with the filter on
  Completed it says "In progress: 14" (`glance.js:1826`).
- Projects are hidden by default and live in another tab, though they are the same
  records.
- "Needs you" says that something needs him but not what to do.
- Feedback work items appear as a "feedback-summary" signal pointing at another tab.
- Statuses `paused`, `halted` and `awaiting-user` exist in the data but are not filters.

**The new design (the Plans page).**
- *Arrival (glance):* headline, for example "6 plans in flight. 1 needs you; 1 is stuck."
  Facts: **Needs you** (`needsUser`, `awaiting-user`, project waiting for an OK, blocker
  that asked for access), **In the way** (true blockers + blockers being worked),
  **Moving** (touched in 7 days), **Idle** (not touched in 7+ days).
- *Layout:* phone: facts, then *Needs you* (each row says what: "Waiting for your OK on
  round 2", or the record's `needsUserReason`), *In flight* (initiatives and projects
  together; projects show their round line, initiatives "Step 3 of 5 · worked on 2 h
  ago"; child items fold under their parent), *In the way* (see Blockers), *Idle*,
  *Finished* (collapsed; filter chips Completed / Archived / Abandoned inside it).
  Detail for an initiative: title, its description, steps as a checklist with dates,
  links (spec, PR, topic) as tappable chips, and the digest reason in words.
- *Primary action:* opening a plan. Where a plan needs him, the row's chevron becomes an
  amber "Open" that lands on the exact thing (the project OK button, the topic link).
- *Secondary / destructive actions:* none new for initiatives (the server has PATCH and
  DELETE, but they are the agent's tools; offering them is not proposed). Feedback work
  items are listed under *In flight* with "from user feedback" and link to the Feedback
  drain page.
- *Honest states:* loading; empty ("No longer plans running."); can't tell (`/initiatives`
  failed or tracker off); partial (the digest failed: plans listed, "Couldn't check which
  ones need you" in dashed slate, and the Needs you fact shows Can't tell, not 0); stale
  (age when a refresh fails).
- *Multi-machine:* this machine only; a single quiet line "Plans on this machine". No
  pool route exists; none proposed until the tracker replicates.
- *Rough sketch:*
```
┌──────────────────────────────┐
│ Plans                        │
│ 6 in flight. 1 needs you;    │
│ 1 is stuck.                  │
│ [1 you][1 in way][4 move][1] │
│ NEEDS YOU                    │
│ ▸ Console makeover     Open ›│
│   waiting for your OK, rnd 2 │
│ IN FLIGHT                    │
│ ● Telegram issues grp      › │
│   step 3 of 5 · 2 h ago      │
│ ● Feedback fixes (user)    › │
│ IN THE WAY                   │
│ ✕ Vercel token expired     › │
│   truly stuck · recheck Mon  │
│ Idle (1) ›   Finished (23) › │
└──────────────────────────────┘
```

**Merge / split / cut.** Absorbs Projects and Blockers. The "Show projects + children"
checkbox is cut (they are always shown, children folded). The status select becomes
the chips inside Finished.

**Data.** Existing: `GET /initiatives` (no `excludeKind`), `/initiatives/digest`,
`/projects/:id` for round detail, `/blockers`. No new route.

**Effort and order.** M (with Projects and Blockers). Second.

**Open questions for the operator.** Is "Plans" the right word for him? Alternatives:
"Projects", "Longer work". Default: Plans.

---

## Blockers (legacy tab id: `blockers`) — "In the way" inside Plans

**Who comes here, and the one question on arrival.** Justin, when work seems stalled.
"Is something stuck, and is getting it unstuck on me?"

**What it does today (inventory).** Read-only.
- `GET /blockers`. Headline ("1 thing is truly stuck right now; 2 are being worked");
  tiles Truly stuck, Being worked, Resolved; rows show the text that opened the blocker;
  the record shows what looked stuck, state in words, id, who opened it, first seen, last
  update, outcome (resolved, playbook path; or true blocker with reason and recheck date)
  (`dashboard/glance.js:594`–`:700`). Refresh. 503 → "not turned on for this agent".

**What is wrong with it today.**
- "Asked you for access" (`access-requested`) is a needs-you state, but it is buried
  inside "Being worked".
- The framing ("decaying hypotheses", in the tab's purpose line, `dashboard/index.html:3705`)
  is engineering language.
- Resolved blockers count on the front page, padding a list he should not need to read.
- A blocker never says which plan or session it stopped.
- Off by default on most agents, and the tab spends a whole slot saying so.

**The new design.**
- *Arrival (glance):* a section of Plans titled **In the way**, contributing the "In the
  way" fact. A blocker that asked him for access moves up to Plans' *Needs you*:
  "I need access to Cloudflare to continue".
- *Layout:* rows: the blocker's own text, then a plain state: "Truly stuck for now ·
  rechecking Monday" (red), "Trying it safely first" / "Checking who can clear it"
  (teal, working), "Waiting on you for access" (amber, in Needs you). Resolved ones are
  a collapsed "Cleared this week (4)". Detail sheet: what looked stuck, what was tried,
  where it stands, the recheck date, and for resolved ones the note "it turned out not to
  be a wall" with the playbook name. Details fold: id, origin, raw state, timestamps,
  playbook path.
- *Primary action:* none to perform in the console; for an access request, "Open the
  conversation" where the agent asked.
- *Secondary / destructive actions:* none (the advance/settle routes are the agent's own
  ladder; settling a blocker belongs to its gate).
- *Honest states:* off ("Blocker tracking is off on this agent": one dashed line in the
  section, not a page); can't tell (request failed: the section shows the reason and the
  In the way fact says Can't tell); empty ("Nothing in the way."); a true blocker past
  its recheck date shows "recheck overdue" in amber.
- *Multi-machine:* this machine's ledger, stated once in the section header.
- *Rough sketch:*
```
│ IN THE WAY                   │
│ ✕ Vercel token expired     › │
│   truly stuck · recheck Mon  │
│ ◐ Deploy needs DNS change  › │
│   trying it safely first     │
│ Cleared this week (4)      › │
```

**Merge / split / cut.** Merged into Plans as a section. The tab is retired once Plans
ships; `?tab=blockers` opens Plans scrolled to In the way.

**Data.** Existing `GET /blockers`. Linking a blocker to its plan or session would need a
field the ledger does not have; not proposed now.

**Effort and order.** S, inside the Plans build.

**Open questions for the operator.** None.
