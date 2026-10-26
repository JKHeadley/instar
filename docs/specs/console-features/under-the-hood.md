# Under the hood — native rebuild plans

Part of the console makeover (`docs/specs/console-makeover.md`). Covers the
legacy tabs `insights`, `pr-pipeline`, `evidence`, `throughput`,
`integrated-being`, `process-health` and `feedback-drain`. (`routing-map` and
`llm-activity` belong to the Capacity plan; overlaps are noted where they occur.)

## Overview

**Who these are for.** Two very different readers, and today all seven tabs are
shown to both:

| Reader | Should see by default |
|---|---|
| An ordinary Instar user (one agent, no Instar source code) | One page, **How I'm doing inside**: what my other conversations have been doing, and (when switched on) problems I caught in my own work. |
| An Instar maintainer (a development agent, or a machine with the Instar source checkout) | The same page, plus a **Development** area: shipping, pace, and the feedback factory. |

Four of the seven are maintainer-only by construction: PR pipeline, Throughput
and Feedback drain read the Instar repository or the operated feedback factory
(Throughput is hard-coded to `JKHeadley/instar` and to two GitHub logins,
`src/server/throughputRoutes.ts:71`, `:118`), and Evidence is a lookup tool that
needs raw memory ids. An ordinary user who opens them today gets either a "not
turned on" message or, worse for Throughput, a chart of somebody else's project.

**Merges (decided, reasons in each section).**

1. **Insights is retired as a page.** Only one page has an insight collector
   (LLM Activity, `src/monitoring/dashboardInsightCollectors.ts:118`), the route is
   dark on ordinary agents, and Home's headline already answers "what stands
   out". The per-page "plain read" survives as one optional line on the page it
   describes.
2. **How I'm doing inside** = Integrated-Being (rebuilt as "What my other
   conversations have been doing") + Process health ("Problems I caught in my own
   work") + Evidence (a "Why do I believe this?" drawer on records, plus a
   maintainer lookup). One audit page, the research's "strongest material".
3. **Development** (maintainer only) = PR pipeline rebuilt as **Shipping** +
   Throughput as **Pace** + Feedback drain as **Feedback**. Three sections of one
   area, each still deep-linkable.

**Where they live in navigation.**

- *How I'm doing inside*: Settings → "Under the hood" section, first tile, for
  everyone.
- *Development*: a tile in the **Work** group ("What is being done"), shown only
  when the console is in maintainer mode. A maintainer checks shipping most days;
  two taps from Home, beside Sessions and Jobs, is the right distance. The
  Capacity-owned hood tiles (Routing map, LLM activity) stay where that plan puts
  them.

**How the console knows it is a maintainer's.** Nothing on the client can tell
today (no route exposes `developmentAgent`). Smallest addition: an authenticated
field, `consoleProfile: { maintainer: boolean, basis: string[] }`, on an existing
authed read (the authed `/health` block, beside `telegramOrigin`), where
`maintainer` = `developmentAgent === true` or an Instar source checkout is
present, and `basis` names which. Rules:

- `maintainer: true` → Development tile and maintainer details shown.
- `maintainer: false` → hidden. Settings carries one quiet row, "Show developer
  tools", a per-viewer toggle (browser storage, a convenience only; every write
  is still gated by the server).
- Field unreadable → **can't tell**: tools hidden, and the Settings row reads
  "Couldn't tell whether this is a development agent. Show developer tools?"
  Never silently decided.

Probing the feature routes instead is rejected: Throughput answers on any agent
that holds a GitHub token, so a probe would show a maintainer chart to a user.

**What an ordinary user sees.** Under Settings, one tile: *How I'm doing inside*.
On it, at most two sections. Nothing named "pipeline", "drain", "ledger",
"chain", "binding" or "evidence row" anywhere at the glance.

**Shared rules for every page below** (on top of the makeover design rule):

- **Slow, stuck and silently failed are separate states.** Every background
  worker shown here (merge watcher, drain, triage, executor, failure ledger) shows
  when it last did something and what its normal rhythm is. Past twice its
  rhythm: "last checked 3 h ago, usually every 15 min" (amber, *quiet*). A
  recorded failure: red, with the reason in plain words. Never a calm green over
  an unknown.
- **Disabled is not broken.** A 503/404 that the server marks as "off on this
  agent" renders as one muted line "Off on this agent" with the reason, not as
  can't-tell and not as an error.
- **PIN only where the server demands operator proof** (feedback approvals,
  re-enabling auto-merge). Bearer-allowed writes get a confirmation sheet, no PIN.
- **No raw server error text at the glance.** Reasons are mapped to sentences;
  the raw text sits in the record's "Technical detail" row.

**Build order.**

1. `consoleProfile` field + maintainer mode (S). Unblocks hiding.
2. **Feedback** (M). The only page here that regularly needs the operator's tap;
   its approvals are PIN-gated and currently buried in a drawer.
3. **How I'm doing inside** (M): Integrated-Being timeline first, then Process
   health, then the Evidence drawer.
4. **Shipping** (M). Replaces a tab that has never shown data.
5. **Pace** (S).
6. Retire the Insights tile; move the plain-read line onto LLM Activity (S, with
   the Capacity plan).

---

## Insights (legacy tab id: `insights`)

**Who comes here, and the one question on arrival.** Anyone who wants a short
plain read of the dashboard. The question: "What stands out right now?"

**What it does today (inventory).**
- One strip per registered page from `GET /insights` (503 when dark: friendly "not
  turned on" note). Each strip: page title; source badge (`AI`, `AI · cached`,
  `summary`, `paused`, `no data`); "as of" time; headline sentence; up to 3 lines
  with a severity dot (watch/alert) and an optional action phrase; "Show the
  data" disclosure of metric tiles; "Open <page>" button (`switchTab`).
- Header stamp "updated HH:MM". No refresh control, no polling, no writes.
- Unused by the tab: `GET /insights/status`, `GET /insights/:page`.

**What is wrong with it today.**
- One registered page (LLM Activity), so the "cross-dashboard" read is a single
  card that repeats another tab (`dashboardInsightCollectors.ts:118`).
- Dark on ordinary agents and `dryRun: true` on development agents
  (`ConfigDefaults.ts:64`), so the "AI" read is in practice the deterministic
  summary with a badge most people cannot decode.
- Its role (one sentence over everything) is now Home's headline, which is
  honest about coverage; Insights is not.
- The error path prints the raw exception text into the page
  (`dashboard/index.html`, `loadInsights`).

**The new design.**
- *Arrival (glance):* there is no Insights page. Where a page has a collector, its
  native page shows one line under its own headline:
  "Plain read: Three checks did most of the work today; none failed." with a
  small stamp "written by AI · 4 min ago" or "summary · 4 min ago".
- *Layout:* the line sits under the page headline, never replaces it, one line
  clamped, tap to expand the up-to-3 supporting lines and "Show the data".
- *Primary action(s):* none; it is read-only. The old "Open <page>" button is
  unnecessary because the line lives on that page.
- *Secondary / destructive actions:* none.
- *Honest states:* route dark (503) → line absent (it is an extra, and the page's
  own headline already carries the truth). `source: paused` → "Plain read paused:
  this page's data could not be read." Timeout (5 s) → line absent, no spinner
  left behind. Stale (`asOf` older than its 5-minute TTL ×2) → stamp shows the age.
- *Multi-machine:* this machine only; the stamp says so when the host page is a
  pool view ("plain read of this machine").
- *Rough sketch:* (on the LLM Activity page)

```
┌──────────────────────────────────┐
│ LLM activity                     │
│ 14 checks ran 2,310 times today; │
│ 3 calls failed.                  │
│ ┄ Plain read: two checks did most│
│   of the work.   AI · 4 min ago ▾│
│ [tiles…]                         │
└──────────────────────────────────┘
```

**Merge / split / cut.** Retire the page; fold into Home (cross-page) and into
each page (per-page line). The Under-the-hood tile is removed once LLM Activity's
native page carries the line; until then the tile links to legacy as today.

**Data.** `GET /insights/:page` (existing). No new route.

**Effort and order.** S. After the Capacity plan's LLM Activity page exists.

**Open questions for the operator.** None.

---

## PR pipeline (legacy tab id: `pr-pipeline`)

**Who comes here, and the one question on arrival.** Maintainers only. "Is any of
my work stuck on the way to merge or release, and does any of it need me?"

**What it does today (inventory).**
- Refresh button. `GET /pr-gate/metrics` → glance: headline "N of M open pull
  requests are ready to merge"; tiles *Ready to merge* / *Not ready yet*; rows
  "Pull request #n — ready/not ready"; record: number, ready, why, commit (8
  chars), first seen (`dashboard/glance.js`, `buildPrPipelineGlance`).
- 404 or `disabled: true` → "The auto-merge gate isn't turned on for this agent
  yet." Other failure → "Could not load the merge gate right now". No writes (the
  PR-review-hardening spec made it read-only).

**What is wrong with it today.**
- **The route was never built.** `src/server/routes.ts:3538` installs only the
  phase-gate middleware for `/pr-gate`; no `/pr-gate/metrics` handler exists. With
  the phase off the tab says "not turned on"; with it on, the request falls
  through to a 404. The tab has never shown a pull request.
- It calls itself the "auto-merge gate", which is the name operators use for the
  green-PR auto-merge watcher, a different system that has no dashboard face at
  all, nor do local verify or release readiness (none of `/green-pr-automerge`,
  `/local-verify`, `/release-readiness` is read by any dashboard file).
- Shown to every user, though it only means anything on the Instar repository.

**The new design.** Rebuilt as **Shipping**, the first section of Development,
from the three live systems.
- *Arrival (glance):* "3 pull requests on their way. 1 needs your approval on
  GitHub." Tiles (≤4): **Needs you** (code-owner review or approval-required),
  **Testing** (local verify queue; position and "about 45 min each"), **Set to
  merge** (armed, GitHub merges when checks pass; overdue past 24 h in amber),
  **Stuck** (stuck-red PRs, failed verifies). Under the tiles one line from
  release readiness: "Finished work waiting for a release: 4 changes, oldest 2
  days" or "Everything merged is released."
- *Layout:* phone: headline, tiles as a 2×2 grid, then one list of PRs ordered
  needs-you → stuck → testing → armed, each row "#2391 · waiting for your review ·
  2 h". Tap a row → a stage strip (queued → verifying → passed → set to merge →
  merged) with the current stage lit, why it is held, last verify result and
  time, and the commit in mono. Desktop: list left, record right.
- *Primary action(s):* **Open on GitHub** on every needs-you row (direct link to
  the PR's Files tab, per the operator's direct-link rule). One tap.
- *Secondary / destructive actions:* in the record: **Hold this pull request**
  (`POST /green-pr-automerge/hold`, bearer, confirmation sheet with a reason
  field; the response states whether the in-flight merge was actually disarmed,
  and the sheet repeats that, never a blanket "held"); **Test it now**
  (`POST /local-verify {pr}`). In the section footer, small and red-outlined:
  **Stop auto-merging** (`POST /green-pr-automerge/rollback`, bearer, confirm
  sheet listing every armed PR it will disarm and reporting any it could not).
  **Turn auto-merge back on** (`POST /green-pr-automerge/enable`) asks for the PIN
  because the server requires it. These are additions: the legacy tab had no
  writes, and today these actions exist only conversationally.
- *Honest states:* loading skeleton per tile. 503 (no source checkout, no
  safe-merge) → "Shipping tools aren't set up on this machine" + the mapped
  reason. Partial: one of the three sources failed → its tile is dashed with the
  reason; the others render. Slow vs stuck: watcher `lastTickAt` past 2× its
  cadence → "Merge watcher last checked 2 h ago"; breaker open → red "Merge
  watcher paused itself after repeated failures"; `invariantOk: false` → red,
  named. A zero is only "nothing waiting" when `lastSuccessfulListAt` is fresh.
- *Multi-machine:* the watcher and local verify run on the lease holder; a
  non-holder answers 409 `not-lease-holder` for local verify. The page then says
  "Testing runs on Mac Studio; open the console there for the queue" (partial),
  and labels every tile with the machine whose data it is.
- *Rough sketch:*

```
┌──────────────────────────────────┐
│ DEVELOPMENT · SHIPPING           │
│ 3 pull requests on their way.    │
│ 1 needs your approval on GitHub. │
│ ┌──────────┐┌──────────┐         │
│ │Needs you ││Testing   │         │
│ │    1     ││ 1 · ~45m │         │
│ └──────────┘└──────────┘         │
│ ┌──────────┐┌──────────┐         │
│ │Set to    ││Stuck     │         │
│ │merge  1  ││    0     │         │
│ └──────────┘└──────────┘         │
│ Released: 4 changes waiting, 2d  │
│ ─────────────────────────────    │
│ #2391 your review · 2h   [Open ↗]│
│ #2388 testing · 1st in line    › │
│ #2380 set to merge · 40m       › │
│ Watcher checked 3 min ago · Mini │
└──────────────────────────────────┘
```

**Merge / split / cut.** Merge into Development as its first section. Cut the
`/pr-gate/metrics` client code and the "auto-merge gate" wording; if the PR-gate
phase ever ships a metrics route, it becomes one more source of the *Stuck* tile.

**Data.** Existing: `GET /green-pr-automerge` (`episodes[]`, `armed[]`,
`armedCount`, `stuckRed`, `snapshot`, `breaker`, `lastTickAt`,
`lastSuccessfulListAt`, `invariantOk`), `GET /local-verify` (queue, merge line),
`GET /local-verify/status`, `GET /release-readiness` (`openEpisodes`,
`oldestOpenSha`, `lastTickAt`). PR titles are not in these payloads; rows show the
number and link to GitHub rather than adding a GitHub call. No new route.

**Effort and order.** M. After maintainer mode. Field names of `episodes[]` to be
pinned by a contract test at build time.

**Open questions for the operator.** Should **Stop auto-merging** be on the phone
page at all, or only reachable by asking the agent? (It is bearer-allowed today,
so a button adds no new authority; it adds a new place to tap it by accident.)

---

## Evidence (legacy tab id: `evidence`)

**Who comes here, and the one question on arrival.** Maintainers debugging memory.
"Why does the agent believe this, and what else relies on this source?"

**What it does today (inventory).**
- *Viewer scope* select: private (full) / shared-topic / shared-project
  ("narrowing only").
- *Evidence by entity*: text field for an entity id + Lookup →
  `GET /memory/evidence/by-entity/:id?viewerScope=` → evidence rows.
- *What cites this?*: kind select (feedback, commit, session, document, message,
  job-run, ledger-entry, pattern-entity, external-url, supersedes-evidence) +
  sourceId field + "Find citing entities" → `GET /memory/entities/by-evidence` →
  entity rows, each with **Inspect evidence** (re-runs the first lookup).
- Status lines for empty / count / error. No writes, no polling.

**What is wrong with it today.**
- It starts from an id the operator does not have. There is no list to pick from;
  a person must already know `ent_…` or `fb_…` (`dashboard/index.html` evidence
  panel). It is a developer's console, presented to everyone.
- The purpose line uses "viewer-scope filtered by SemanticMemory".
- Errors are printed raw in red.

**The new design.** Two faces.
- *Arrival (glance), everyone:* no page. Wherever the console shows something the
  agent learned or remembers (a preference, a learned lesson, a commitment
  record, an Integrated-Being entry that cites a memory), the record gets a
  **Why do I believe this?** row. Tap → a sheet: "Based on 3 sources", each a
  plain line ("A message from you, 12 Oct", "Commit a1b2c3d", "A job run, 9 Oct")
  with its date and kind, and a link when it is a commit, URL or session.
- *Maintainer:* the lookup tool, as the last section of *How I'm doing inside*
  (collapsed, titled "Look up a memory's sources"). One search field that accepts
  either an entity id or a source id (the kind inferred from its prefix, with the
  kind picker shown only when ambiguous), and the scope picker labelled "See it
  as: me / people in this topic / people in this project".
- *Layout:* the sheet is a bottom sheet on phone, a side panel on desktop; rows
  are two lines (what it is · when). "What else relies on this?" is a row inside
  each source, so the two old panels become one walk: belief → sources → other
  beliefs.
- *Primary action(s):* open the sheet (one tap from any record).
- *Secondary / destructive actions:* none; read-only.
- *Honest states:* no sources → "No sources recorded for this, so I can't show
  why." (amber, because a belief without sources is itself a finding). Narrowed
  scope with nothing visible → "Nothing is visible to people in this topic" (not
  "no sources"). Route failure → can't tell, with the mapped reason. Memory
  disabled → the row is absent.
- *Multi-machine:* memory is per machine; the sheet says "from this machine's
  memory".
- *Rough sketch:*

```
┌──────────────────────────────────┐
│ Why do I believe this?        ✕  │
│ "Justin prefers plain summaries" │
│ Based on 3 sources               │
│ ● A message from you · 12 Oct  › │
│ ● A correction you made · 9 Oct › │
│ ● Commit a1b2c3d · 2 Oct     ↗   │
│ from this machine's memory       │
└──────────────────────────────────┘
```

**Merge / split / cut.** Split: the everyday face becomes a drawer on records
across the console; the lookup tool merges into *How I'm doing inside* for
maintainers. The tab tile is removed once two record types carry the drawer.

**Data.** Existing `GET /memory/evidence/by-entity/:id` and
`GET /memory/entities/by-evidence`. The drawer needs the record to carry its
memory entity id; where a record does not, the drawer is not offered (no new
route; adding ids to those records is each owning plan's choice).

**Effort and order.** M, spread out: lookup tool with *How I'm doing inside*; the
drawer as each record type gains an entity id.

**Open questions for the operator.** None.

---

## Throughput (legacy tab id: `throughput`)

**Who comes here, and the one question on arrival.** Maintainers only. "Are we
shipping faster or slower than before, and is quality holding?"

**What it does today (inventory).**
- Author select: Team / Codey / Echo. Window select: 7 / 14 / 30 days.
- `GET /throughput/series?days=` → seven bar charts: merges, median latency (h),
  rework loops, reverts, median push iterations, changed lines, composite index
  (full width). Each bar's tooltip is the day and value; "latest: N" under each.
- Failure → "Throughput data is temporarily unavailable." No writes.

**What is wrong with it today.**
- Hard-coded to one repository and two people (`throughputRoutes.ts:71`, `:118`),
  yet shown to every agent; on an ordinary agent with a GitHub token it renders
  Instar's history as if it were theirs.
- Seven equal charts, no headline: the operator has to compute "better or worse"
  himself. The composite index (weights 40/20/25/15) is unexplained.
- Bars are scaled per chart to their own maximum, with no axis, so a quiet week
  and a busy week look the same.
- 503 `github-auth-unavailable` collapses into the same "temporarily unavailable"
  as a real outage.
- "Latest" shows today's partial day as if it were complete.

**The new design.** **Pace**, the second section of Development.
- *Arrival (glance):* one sentence comparing this window with the previous one:
  "Faster than the last two weeks: 41 merges (up from 33), half took under 6 h.
  Quality held: 1 revert." Four tiles: **Merged** (count, change), **Time to
  merge** (median, change), **Redone** (rework loops + reverts), **Size**
  (median changed lines). Each tile's change is "up 24%" / "about the same"
  (±10%), coloured only when quality worsens (amber).
- *Layout:* phone: headline, tiles 2×2, then one chart at a time with a segmented
  control (Merged · Time · Redone · Size · Index); each chart has a labelled
  y-axis, today drawn hollow ("so far today"), and a faint line for the previous
  window. Tap a bar → that day's numbers. Window picker (7/14/30) and person
  picker (Everyone / per author) sit in one row under the headline. Desktop: the
  four charts in a 2×2 grid, index below.
- *Primary action(s):* change the window (one tap on the segmented control).
- *Secondary / destructive actions:* none; read-only. The index chart carries an
  "i" explaining the four weights in one sentence each.
- *Honest states:* loading skeleton; `github-auth-unavailable` → "Can't reach
  GitHub from this machine: no GitHub sign-in found" (can't tell, with the fix
  named); other 503 → "GitHub didn't answer"; window with zero merges → "No merges
  in this window" (a real zero, because the query ran); cached up to 60 s, shown
  as "as of HH:MM"; `MAX_SEARCH_PAGES` hit → "Partial: only the first 1,000 pull
  requests counted".
- *Multi-machine:* the data comes from GitHub, so every machine shows the same
  numbers; no pool view needed.
- *Rough sketch:*

```
┌──────────────────────────────────┐
│ DEVELOPMENT · PACE   [7|14|30]   │
│ Faster than the last two weeks.  │
│ 41 merged (33 before); 1 revert. │
│ ┌──────────┐┌──────────┐         │
│ │Merged 41 ││To merge  │         │
│ │ up 24%   ││ 5.8h ↓   │         │
│ └──────────┘└──────────┘         │
│ ┌──────────┐┌──────────┐         │
│ │Redone 3  ││Size 140  │         │
│ └──────────┘└──────────┘         │
│ (Merged·Time·Redone·Size·Index)  │
│ ▁▃▅▂▇▅▃▆▄▅▇▆▃▢  so far today ▢   │
└──────────────────────────────────┘
```

**Merge / split / cut.** Merge into Development. The hard-coded authors and repo
are a server concern: until the route derives them from config, the page shows
them as named ("Instar repository · Codey, Echo") and is maintainer-only.

**Data.** Existing `GET /throughput/series` (`rows[].{day,team,authors}`,
`weights`, `repo`, `generatedAt`). The comparison needs the previous window, and
the route accepts only 7, 14 or 30 days. Smallest form: request the 30-day series
for the 7- and 14-day views and compute both windows client-side; for 30 days,
show no comparison ("no earlier window to compare") rather than add a route.

**Effort and order.** S. After Shipping.

**Open questions for the operator.** Keep the composite index at all? It is a
weighted blend nobody asked to read on a phone; the four tiles may be enough.

---

## Integrated-Being (legacy tab id: `integrated-being`)

**Who comes here, and the one question on arrival.** Everyone (the ledger is on by
default, `src/core/types.ts:5209`); maintainers for its internals. "What have my
other conversations been doing, agreeing and leaving open?"

**What it does today (inventory).**
- Refresh button; 30 s poll while open.
- Notice when more than one machine is paired: "this machine only".
- Four count cards from `GET /shared-state/stats`: Total entries, Classifier
  fires, Rotations, Unclosed > TTL.
- Filters: Kind (commitment, agreement, thread-opened/-closed/-abandoned,
  decision, note), Counterparty (user, agent, self, system), Limit (1–200).
- Entries table from `GET /shared-state/recent`: id, time, kind (with commitment
  mechanism, ref-status, expired/stranded/dispute badges), subject (deadline,
  overdue, derived resolved/expired/stranded/cancelled status, "disputed × n"),
  counterparty, provenance/source, supersedes/disputes pointer.
- Chain explorer: 12-hex id + **Walk chain** → `GET /shared-state/chain/:id` →
  raw JSON.
- Bindings (only when v2 is on; `GET /shared-state/sessions`): session id,
  label, registered, last active, TTL, status, **Revoke** →
  `POST /shared-state/sessions/:sid/revoke` (bearer + `X-Instar-Request`, browser
  `confirm()`; not PIN-gated).
- Unused: `GET /shared-state/render`. Specified but never built: resolve /
  cancel / dispute buttons (`integrated-being-ledger-v2.md` §5; no
  `/shared-state/resolve` route exists).

**What is wrong with it today.**
- The name is internal; nobody outside the project knows what "Integrated-Being"
  means, and the purpose line has to explain it.
- The front page is a seven-column table of ids, provenance and pointers, built
  with `innerHTML` strings; on a phone it scrolls sideways.
- The four cards are machinery counters ("Rotations", "Classifier fires"), not
  answers.
- Commitment entries duplicate the Commitments tab with different status words.
- Chain explorer returns raw JSON.
- The supersession status is derived only within the loaded page of entries, so
  a commitment's resolution older than the limit is silently missed.

**The new design.** Section 1 of **How I'm doing inside**, titled **What my other
conversations have been doing**.
- *Arrival (glance):* "In the last day: 4 decisions, 2 agreements, 3 open
  threads. 1 thread has gone quiet." Tiles: **Decisions**, **Agreements**, **Open
  threads**, **Gone quiet** (unclosed past their limit; amber only when non-zero).
- *Layout:* phone: a day-grouped timeline, newest first, each entry one plain
  sentence plus who it was with and when: "Agreed with Dawn to hand off the
  review · 2 h ago". Kind is an icon, not a badge wall. Filter chips above the
  timeline (All · Decisions · Agreements · Threads · With people · With agents).
  Commitment entries show "Promise — see Commitments ›" and link there instead of
  restating status. Tap an entry → record: full subject, what it replaced or
  disputes (as a link to that entry, i.e. the chain walk, rendered as a short
  history list not JSON), provenance in plain words ("written by the session in
  topic 4120" / "asserted by the system").
- *Primary action(s):* tap a chip to filter; tap an entry to read its history.
- *Secondary / destructive actions (maintainer details, collapsed "Technical"):*
  ids, raw provenance, counters (rotations, classifier fires), and **Session
  bindings** with **Revoke** per session (bearer, confirmation sheet naming the
  session and stating that its future writes will be refused; no PIN, matching
  the server). Shown to ordinary users only if v2 is on, and then still behind
  "Technical".
- *Honest states:* 404/disabled → "This record is off on this agent." Recent read
  fails, stats succeed → timeline can't-tell, tiles show. A derived status that
  depends on an entry outside the loaded window → "status unknown, older history
  not loaded" (instead of silently "open"). Empty → "Nothing recorded in the last
  day."
- *Multi-machine:* per machine only today. The section head says "This machine
  only: other machines keep their own record" whenever the pool has more than
  one machine (partial, not fine).
- *Rough sketch:*

```
┌──────────────────────────────────┐
│ HOW I'M DOING INSIDE             │
│ What my other conversations      │
│ have been doing                  │
│ 4 decisions, 2 agreements, 3 open│
│ threads. 1 has gone quiet.       │
│ (All)(Decisions)(Agreements)(…)  │
│ TODAY                            │
│ ◆ Decided to retry on Codex · 2h │
│ ⇄ Agreed with Dawn: hand off   › │
│   review · 3h                    │
│ ○ Thread with PP gone quiet · 1d │
│ This machine only                │
└──────────────────────────────────┘
```

**Merge / split / cut.** Merge into *How I'm doing inside*. Rename. Commitment
rows defer to the Commitments page (Work group) rather than compete with it.

**Data.** Existing `GET /shared-state/recent`, `/stats`, `/chain/:id`,
`/sessions`, `POST /shared-state/sessions/:sid/revoke`. The "Gone quiet" count is
`stats.unclosedThreadsOverTtl`. The windowed-status gap needs no route: the record
view walks the chain on open.

**Effort and order.** M. First section of *How I'm doing inside*.

**Open questions for the operator.** The v2 spec promised **Mark resolved /
Cancel / Dispute** buttons on commitments that were never built. Should those
live here, or only on the Commitments page? (Recommendation: Commitments page
only, so a promise has one place to be closed.)

---

## Process health (legacy tab id: `process-health`)

**Who comes here, and the one question on arrival.** Whoever runs the
failure-learning loop: maintainers always; ordinary users only when it is switched
on (it is dark by default). "Is something going wrong repeatedly in my own work?"

**What it does today (inventory).** (`dashboard/process-health.js`)
- Stamp; headline "Keeping an eye out — N things noticed so far" with an
  open/attributed subline; stale headline after refresh failures.
- *Recurring patterns* from `GET /failures/insights?limit=50`: expandable cards
  (status, times seen across changes/fixes, first noticed).
- *Problems it's noticed lately* from `GET /failures?limit=10`: expandable items
  (category sentence, "came up while building <feature>", status, where, times
  seen, first noticed, cause confidence).
- *How far the system is switched on*: four-stage rollout track
  (`rollout.stage`).
- *More detail* drawer from `GET /failures/analysis`: totals, attributed, no
  feature link, per category, unknown-toolchain count.
- Disabled (503) state with a "For whoever set this up" note. Visibility-gated
  ETag polling. No writes. Unused by the page: `POST /failures`,
  `POST /failures/analyze`, `GET /failures/:id`.

**What is wrong with it today.**
- Mostly right in tone (grandfathered as an exception in the UX standard), but:
- The headline "Keeping an eye out — 9 things noticed" never says whether any of
  it matters now; "noticed so far" has no time window.
- The rollout track takes a whole section to say one fact (which stage).
- Only the last 10 problems; no way to see more.
- Its sanitizer strips symbol glyphs from all data (`process-health.js:43`), which
  will also strip legitimate arrows or check marks in summaries; fine, but the
  console must keep the same safety contract.

**The new design.** Section 2 of **How I'm doing inside**, titled **Problems I
caught in my own work**.
- *Arrival (glance):* "One kind of problem keeps coming back: timing clashes,
  across 4 changes." or "Nothing repeating. 3 one-off problems this week, all
  explained." Tiles: **Repeating** (patterns, amber when any is *reopened*),
  **Still open** (not yet explained), **This week** (captured in 7 days).
- *Layout:* patterns first (each a card: plain category sentence, "seen in 4
  changes since 2 Oct", status word), then recent problems as one-line rows that
  expand to the same fact sheet as today, with "Show older" paging past 10. The
  rollout stage becomes a single line in the section head: "Watching quietly (no
  alerts)" with an info tap for the four stages.
- *Primary action(s):* tap a pattern to see the problems behind it.
- *Secondary / destructive actions:* none on the page (it is awareness-only by
  spec). Maintainer "Technical" drawer: the analysis counts and the per-tool
  unknowns.
- *Honest states:* 503 → for an ordinary user the section is omitted and the page
  head says "Failure watching is off on this agent"; for a maintainer the same
  line with the reason. Stale (no fresh 200 within the controller's limit) →
  "Showing what I knew at 14:02; couldn't refresh since." Patterns read fails but
  problems succeed → patterns can't-tell, rest renders. Zero patterns is "nothing
  repeating" only when `/failures/insights` answered.
- *Multi-machine:* the ledger is per machine; section says "this machine".
- *Rough sketch:*

```
┌──────────────────────────────────┐
│ Problems I caught in my own work │
│ Watching quietly · this machine ⓘ│
│ Nothing repeating. 3 one-offs    │
│ this week, all explained.        │
│ ┌────────┐┌────────┐┌────────┐   │
│ │Repeat 0││Open 0  ││Week 3  │   │
│ └────────┘└────────┘└────────┘   │
│ ● A settings problem · 2d      › │
│ ● A timing clash · 4d          › │
│ Show older                       │
└──────────────────────────────────┘
```

**Merge / split / cut.** Merge into *How I'm doing inside*. Keep the ETag polling
module's behavior (visibility-gated, abort-safe) and its sanitizer.

**Data.** Existing `/failures`, `/failures/insights`, `/failures/analysis`. "Show
older" uses `limit` on `/failures`; if the route has no offset, cap at 50 rather
than add one.

**Effort and order.** S–M. Second section of *How I'm doing inside*.

**Open questions for the operator.** None.

---

## Feedback drain (legacy tab id: `feedback-drain`)

**Who comes here, and the one question on arrival.** Maintainers running the
operated feedback factory (in practice, the operator, on his phone). "Does feedback
need me, and is it actually being turned into fixes?"

**What it does today (inventory).**
- Stamp; 15 s poll of the headline and status.
- **Decision headline** (`feedback-drain-headline.js`): one sentence + one button,
  from five reads (`/feedback-factory/readiness-authorities/proposal`,
  `/triage/summary`, `/triage/authority/proposal`, `/execute/status`,
  `/triage/queue`). To-dos in order: approve the sorting model; approve the
  triage model; one-time OK for the fix worker (approver not independent); fixes
  held for a secret-shaped file; fixes waiting for GitHub approval (button opens
  the PR). The reveal button opens the drawer, scrolls, focuses the PIN field and
  may press the card's own preview button.
- **Approvals and settings** drawer:
  - *Readiness authority card* (`feedback-readiness-authority.js`): status line;
    server summary sentence; blockers; "Adjust limits" (reports per batch 1–50,
    daily spend cap USD, answer length tokens) with live re-preview via the
    proposal route; bound-to line (agent, machine, epoch, model, provider); PIN
    field; **Approve** / **Approve (restore)** / **Save new limits** / **Revoke** →
    `POST /feedback-factory/readiness-authorities` — **PIN-gated**.
  - *Triage section* (`feedback-triage.js`): summary paragraph (authority words,
    counts, calls today of cap, quota pause, ignore brake, ignore live/practice,
    recommendation); triage authority card with PIN, **Approve** / **Approve
    (restore)** / **Revoke** → `POST /feedback-factory/triage/authority` —
    **PIN-gated**; **Turn ignores live… / back to practice…** →
    `POST /triage/plan {action:'ignore-live'}` then **Confirm with PIN** →
    `POST /triage/commit` — **PIN-gated**; executor card (plain reason, live
    attempts, PRs waiting, starts today) with **Let it run anyway…**
    (`accept-approver-dependence`) and per held attempt **Review and publish…**
    (`publish-secret-shape`), both plan → **Confirm with PIN** → commit —
    **PIN-gated**; ranked work queue (top 25, "…and N more").
- **More detail** drawer from `GET /feedback-factory/drain/status`: posture,
  backlog counts, last run and oldest queued age, source byte/generation lag and
  checksum conflicts.
- Not on the page, reachable only by asking the agent (bearer +
  `X-Instar-Request`): execute stop / release / revoke-acceptance / tick /
  canary-retry, drain tick and run cancel, readiness hold/release, consumer
  promote/revoke, triage tick and action list, failover finalize; reads
  `/feedback-factory/stats`, `/backlog/analysis`.

**What is wrong with it today.**
- The decision headline (ACT-003) is good, but everything it points at is inside
  a closed drawer, then a card, then a field; the path from "it needs you" to a
  PIN is three moves and a scroll.
- One PIN field per card (`fraPin`, `ftPin`), and the triage card's PIN is reused
  by the executor card above it ("enter your PIN in the box above"), so it is easy
  to type into the wrong one.
- Two status lines say "Active (version 7)": "version" is an authority
  generation the operator never chose.
- The summary is a paragraph of seven clauses; the queue rows inline severity in
  brackets.
- "More detail" is raw counters ("byte lag 0; generation lag 0").
- The page never answers "is it actually making progress?" in one line: stall
  state (`readinessProgress`, `lastReadinessFailure`) is only reachable via the
  API, although the agent memory says that is the first thing to read when
  sorting looks stuck.
- Five reads per 15 s; a failed read becomes `null` and the headline then says
  "Nothing here needs you" (`feedback-drain-headline.js`, `calmLine`), which is
  the "renders as fine" failure the console forbids.

**The new design.** **Feedback**, the third section of Development.
- *Arrival (glance):* the existing decision sentence, kept verbatim in logic, plus
  a progress line: "Feedback is waiting on one approval from you." or "Nothing
  needs you. 12 reports sorted today; 2 fixes waiting for GitHub approval." Tiles:
  **Needs you** (to-dos count), **Being fixed** (live attempts + open PRs),
  **Waiting to sort** (untriaged + queued), **Progress** ("last sorted 8 min
  ago" / amber "no usable answer for 3 h" from `readinessProgress`).
- *Layout:* phone: when there is a to-do, the approval card itself is the first
  thing under the headline, open, with its sentence, its limits collapsed under
  "Adjust limits", and **one** PIN field at the bottom of that card. Other to-dos
  are a numbered list below ("2 more things need you") each opening its own card
  in a bottom sheet with its own PIN field. Then the work queue as rows ("1 ·
  Serious · Telegram replies lost on restart · fix waiting for your approval ›"),
  severity as a small coloured word. Then **Settings** (collapsed): both
  authorities' status in plain words ("Sorting model approved on 20 Oct, up to 50
  reports a batch, $5 a day"), with **Change limits**, **Revoke**, and the ignore
  practice/live switch. "Technical" (collapsed, last): the drain-status counters,
  bound-to fields, generations.
- *Primary action(s):* **Approve** on the open card: PIN, one tap. GitHub
  approvals: **Open the fix ↗** directly to the PR.
- *Secondary / destructive actions:* **Revoke** (either authority) and **Turn
  ignores back to practice / live** live under Settings, red-outlined for revoke,
  each opening a sheet that shows the server's exact rendered plan text (for
  plan/commit actions) before the PIN; never a paraphrase. "Let it run anyway"
  and "Review and publish" appear only as to-dos when the server says they are
  needed. The PIN is held in the page's memory for the sheet's life only, never
  stored; polling never rebuilds an open card (F9).
- *Honest states:* each of the five reads is tracked separately. Any read that
  feeds the to-do list failing → headline "I can't tell whether feedback needs
  you: the triage summary didn't answer" (dashed), never "Nothing needs you".
  Drain posture `unavailable` / not the operated host → "The feedback factory
  doesn't run on this machine" (off, muted). Stall: `readinessProgress` failed
  runs ≥ 6 → amber "Sorting hasn't produced a usable answer since 11:40 (provider
  problem; nothing is paused)"; paused by a brake → amber "Sorting is paused:
  <pausedBecause>. Only your approval restarts it." with Approve. Quota pause and
  ignore brake each a one-line amber note. Stale: last poll older than 1 min →
  stamp shows age.
- *Multi-machine:* the factory runs on one operated host. On any other machine:
  "Feedback is handled on Mac Studio" with a direct link to that machine's
  console when its tunnel URL is known; no controls rendered here (the server
  would refuse them).
- *Rough sketch:*

```
┌──────────────────────────────────┐
│ DEVELOPMENT · FEEDBACK           │
│ Feedback is waiting on one       │
│ approval from you.               │
│ ┌──────────────────────────────┐ │
│ │ Approve which model sorts    │ │
│ │ incoming reports.            │ │
│ │ GPT-6 Luna · ≤50 a batch ·   │ │
│ │ $5 a day        Adjust limits▾│ │
│ │ [ PIN •••• ]   [  Approve  ] │ │
│ └──────────────────────────────┘ │
│ 1 more thing needs you         › │
│ ┌────────┐┌────────┐┌────────┐   │
│ │Fixing 2││Sort 14 ││8m ago  │   │
│ └────────┘└────────┘└────────┘   │
│ 1 Serious · replies lost…  ↗     │
│ Settings ▾        Technical ▾    │
└──────────────────────────────────┘
```

**Merge / split / cut.** Merge into Development as its third section. The
pause/stall attention items the drain already raises reach Home's *What needs
you*, so the operator need not open this page to learn it needs him; the page is
where he acts. Nothing is dropped: every PIN action above has a home; the
agent-only levers stay agent-only (they are documented as conversational
instructions).

**Data.** Existing routes listed in the inventory, plus `readinessProgress` and
`lastReadinessFailure` from `GET /feedback-factory/drain/status` (already
returned, not yet shown). No new route.

**Effort and order.** M. First page built after maintainer mode, because it is the
one place here that asks the operator to act.

**Open questions for the operator.** None. (Whether the triage model may ever be
approved without a PIN is settled: the server requires operator proof.)

---

## The two combined pages, in one view

```
How I'm doing inside            Development  (maintainer only)
(Settings → Under the hood)     (Work group tile)
├ What my other conversations   ├ Shipping   ← pr-pipeline
│   have been doing             │   (green-PR watcher, local verify,
│   ← integrated-being          │    release readiness)
├ Problems I caught in my own   ├ Pace       ← throughput
│   work ← process-health       └ Feedback   ← feedback-drain
│   (omitted when off, for an
│    ordinary user)
└ Look up a memory's sources
    ← evidence (maintainer)
```

Each combined page opens on its own one-sentence headline built from its
sections' headlines (the worst state first, coverage stated, same rules as Home),
and each section is deep-linkable (`#shipping`, `#feedback`, …) so links the agent
sends land on the right part. Legacy tabs stay reachable from Settings → "Legacy
dashboard" until the makeover's inventory-gated removal.
