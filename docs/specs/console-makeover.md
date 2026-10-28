# Console makeover — one beautiful first screen, honest state, the legacy dashboard beside it

Status: round 2 (round-1 reports from GPT-6 Astra and Gemini 4 Argon are in
`docs/specs/reports/`; how each finding was handled is in "Review changes" at the
end). Topic 127504.

## Problem

The dashboard has 29 tabs. They are already grouped (a grouped dropdown at every
width, five groups by subsystem: Runtime, Work & Delivery, Cost & Routing,
Intelligence & Comms, Content & Access; `dashboard/index.html:927`, `:3077`), and
the Dashboard UX Standard has put most of them on the shared glance template. It
is still hard to use:

- Nothing answers "is everything OK, and does anything need me?" without opening
  several tabs.
- The groups name subsystems, not the operator's questions, so finding an answer
  means knowing where Instar keeps it.
- Some of Instar's strongest records have no face at all: open promises, held
  replies, which guards are dark, what the agent is allowed to do.
- It does not look like Instar. The product site (instar.sh) has a distinct,
  polished identity; the dashboard does not share it.

The Dashboard UX Standard left the visual redesign out of scope (its Non-goals).
This spec is that piece.

## Evidence

The hands-on research (`console/research/SYNTHESIS.md`, PR 2291): ChatGPT Dots,
Meta Muse and Grok Bot independently converged on one design — **the agent
always shows what it is doing and what it is allowed to do, together.** Grok Bot
runs a scheduler, plugins, an image model and a cloud agent platform from five
sidebar items.

The first-screen prototype (`console/prototype/`, Oct 22, built from live data):
its first run surfaced 126 open attention items, 26 of them replies to the
operator that had been held and expired undelivered, the oldest eleven days old.
Every one was recorded correctly. Nothing displayed them.

## Design rule

**A value that could not be read says so. It never renders as fine.** Three
cases, each with its own look:

- **Can't tell** — the source failed, timed out, is disabled, or answered without
  the fields needed. Shows the reason. Dashed outline, slate.
- **Partial** — some of the pool answered. Shows what answered and names what
  did not.
- **Stale** — good data older than its freshness limit. Shown with its age,
  never silently.

A zero is only "nothing" when the source proves it observed (for example a
held-reply count with a null `observedAt` is "Can't tell", not "all delivered").
Enforced by unit tests over each of these cases, not by care.

## Aesthetic bar (operator requirement, 2026-10-25)

The operator: "a heavy focus on extremely aesthetic UI", "aligned with the
instar.sh main site themes/colors". Visual quality is a pass/fail MVP criterion.

- **The site's identity, measured from its stylesheet:** ground `#0a0e17` with a
  faint teal 60 px grid; teal brand accent (`#6ec6c8`, gradient `#8dd6d8` →
  `#4ba8aa` on display type); slate text scale (`#f1f5f9` … `#64748b`);
  translucent slate cards (`slate-900` at ~40–60%) with hairline borders;
  Inter 800 with tight tracking for headings, JetBrains Mono for technical names;
  small uppercase wide-tracked labels; the Instar crab mark.
- **One stylesheet**, `dashboard/console/console.css`, holds every token. Inter and
  JetBrains Mono are self-hosted (SIL OFL) because the dashboard CSP allows fonts
  from `'self'` only. Dark only for MVP, as on the site (both round-2 reviewers
  advised deferring a second theme; the tokens are semantic, so a light theme is
  a token set added after Justin accepts Home).
- **Colour carries meaning only:** teal = healthy/brand, amber = needs you,
  red = failing, dashed slate = can't tell. Healthy state recedes; what needs the
  operator is the most prominent thing on screen.
- **Phone first** (designed at 390 px; bottom navigation), widened to desktop
  (sidebar), never squeezed down. Short purposeful motion; `prefers-reduced-motion`
  honoured.
- **Checked by eye:** each visual iteration produces phone and desktop screenshots
  from a live server. At most three critique passes by GPT-6 Astra and Gemini 4
  Argon on the screenshots, each fixing concrete defects; Justin's own judgment on
  his phone is the acceptance.

## The plan

### 1. Home

Home leads with **one sentence** that summarizes the whole agent ("3 things need
you." / "Nothing urgent that I can see." / "All quiet."), a line under it that
breaks the count down and names any area that is failing, needs a look, or
cannot be seen fully, then six compact cards. Each card has a title, one value,
at most three rows, and either an inline "See all" (the records it already
fetched, each row expandable to its full text) or a link to the legacy tab that
holds the detail. Page-wide budget before interaction: one headline, six cards,
at most 18 rows. Each card fetches and renders on its own (a skeleton until it
resolves; 5 s deadline, 8 s for the two pool reads, which wait up to 5 s on peers
server-side and show "Still checking the other machines…" meanwhile), refreshes
every 30 s while visible, keeps its last good data with an age when a refresh
fails, and keeps any opened row or list open across refreshes.

| Card | Route (existing) | Fields used | Scope | Can't tell when | Detail |
|---|---|---|---|---|---|
| Can I reach you | `/health` | `telegramOrigin.heldForward.{count,oldestSince,observedAt,expiredUnreported}` | this machine | block absent, `observedAt` null, count missing; stale past 5 min | legacy Message origins |
| What needs you | `/attention?scope=pool`, plus the promises *waiting on you* from What I've promised; `/pool` for machine names | `items[]` with `status=OPEN`; `pool.failed`; `machines[].{machineId,nickname}` | pool | request fails or no list; promises unread marks it partial | inline See all |
| What I'm doing | `/sessions?scope=pool` | `sessions[].{name,status,machineNickname,startedAt,telemetry.lastActivity}`; `pool.failed` | pool | request fails or no list | legacy Sessions |
| What I've promised | `/commitments?scope=mesh` (all statuses; the tracker's active rule applied client-side to own and replica rows alike) | `enabled`, `scope`, `commitments[].{owner,blockedOn,status,expiresAt,createdAt,viewSource,originMachineId,stalenessMs}` | mesh | request fails or `enabled:false` | inline See all + legacy Commitments |
| Where I'm running | `/pool` | `machines[].{nickname,online,routerReceivedAt,loadAvg,hardware.cpuCores,ropeCondition}` | pool | request fails or no list | legacy Machines |
| What I'm allowed to do | `/guards`, `/mandate` | `summary.{onConfirmed,onUnverified,onDryRun,offDeviant,offDarkDefault,…}` (all required, read never recomputed), `guards[].{key,effective,offClass,criticalPath}`; active unexpired `mandates[]` | this machine | guards request fails or summary counts missing | inline See all + legacy Machines |

Block specifics:

- **What needs you** splits the open items: *waiting on you* (URGENT, items raised
  by the agent, and decision/approval/review/security/sign-in categories); routine
  automated items are not counted on Home (see "A calm front page"). The same notice raised again or on
  several machines (same category and title) is **one** entry ("27 copies ·
  Mac Studio, Mac Mini, Laptop"). An entry untouched for 14+ days moves to a
  visible "Older, still open" group that is listed but not counted (age is not evidence it was handled);
  security items never age out. Highest priority first, newest first within it.
  Unreachable peers are named, never shown by internal id (a machine with no name
  is described as such). It also lists the promises *waiting on you* from What
  I've promised, marked "a promise", so it is the one answer to "what needs you":
  the headline counts this card alone and the two can never disagree (operator,
  2026-10-27, topic 127504: the headline said "One thing needs you." above this
  card saying "Nothing needs you"). (Operator, 2026-10-25: "If the user is overloaded
  with notification/required actions/attention items they will simply ignore all
  of them." On live data this took the count from 32 to 4. The root cause, items
  that never close when their cause clears, is its own issue:
  `docs/issues/attention-noise-items-never-close.md` in the agent home, topic
  10000000850.)
- **What I'm doing** names each live session with its machine and how long it has
  run. A session's initial prompt is never shown as its latest action;
  `telemetry.lastActivity` (the last hook event of any kind) is shown as
  "active N min ago". Topic focus is not used in MVP.
- **What I've promised** leads with promises *waiting on you* (owner user, or
  blocked on your input or authorization) touched in the last 14 days, then
  missed ones; older waiting promises are listed as "untouched 14+ days" but not
  counted (47 → 11 on live data); the rest is not counted on Home (see "A calm front page"). Replica rows say they come from another machine and how old they are.
  Coverage is stated beside the value: no replica rows means "only this machine's
  promises are visible", a replica over 15 min old means "some of it is out of
  date"; either marks the card a partial view even when it also needs you.
- **Where I'm running** maps evidence to a state, first match wins: an explicit
  `peer-offline` rope signal → *unreachable*; no timestamp → *no reading*; silent
  over 15 min → *not answering*; silent over 2 min → *quiet* (stale evidence never
  supports a load diagnosis); `degraded`/`urgent` rope or load over 2 per core →
  *struggling*; `online:false` → *no reading*; otherwise *live*. Every machine
  always shows its evidence age; load per core is shown beside the state when
  known.
- **What I'm allowed to do** shows guards on, watching only, off-where-they-should-
  be-on and off by design, from `/guards`' own summary, plus active mandates; a
  failed mandate read keeps the guard reading and marks the card a partial view.
- **A calm front page** (operator, 2026-10-27: "still looks WAY too busy and hard
  to understand"). Home shows only what asks something of the operator: no
  count of routine notices, no count of promises carried or untouched for
  weeks (they stay under See all), a miss untouched for 14+ days is history
  rather than a red row, a promise waiting on the operator is listed once (in
  What needs you), and when every machine is answering the machine list
  collapses to that one line. The headline names the areas it cannot fully
  see instead of counting them.
- **No internal text on Home.** No card or headline shows an internal id, a
  placeholder value (undefined/null), an internal field name or bookkeeping
  phrasing; `tests/unit/console-home-one-answer.test.ts` scans every builder's
  rendered text for it.
- **The headline** counts What needs you (which already includes waiting
  promises). It is teal "All quiet." only when every card is observed and
  fine. Unknown, partial or stale cards make it "Nothing urgent that I can see."
  in a muted tone, and a known count always carries the coverage qualification.

### 2. Navigation

| Group | Question | Legacy tabs |
|---|---|---|
| **Home** | Is everything OK, and does anything need me? | — |
| **Work** | What is being done, and what was promised? | Sessions, Jobs, Commitments, Projects, Initiatives, Blockers, Send Content |
| **Capacity** | What do I run on, and what does it cost? | Machines, Health, Subscriptions, Resource Usage, Tokens, Spend |
| **People & agents** | Who is talking to whom, with what permission? | Threadline, Message origins, Mandates, Secrets |
| **Settings** | How is it set up, and what has it learned? | Features, Preferences, Files |
| **Under the hood** (a section of the Settings page) | How is the machinery doing? | Insights, PR Pipeline, Evidence, Routing Map, LLM Activity, Throughput, Integrated-Being, Process Health, Feedback Drain |

Phone: a five-item bottom bar (Home, Work, Capacity, People, Settings). Desktop:
the same five in a sidebar. Each group page is a static directory: the group's
question, then one tile per tab with a one-line description; Settings shows its
"Under the hood" tiles in a visible section below (no extra disclosure tap). A tile opens the
legacy tab as an **ordinary link** (`/dashboard?tab=<id>`), so every behavior,
write action and PIN gate is exactly the legacy one. Any legacy tab is two taps
from Home (group, then tile).

No embedding. The dashboard keeps `X-Frame-Options: DENY`; no header changes.

### 3. Access

- The console is static files under `dashboard/console/`, served at
  `/dashboard/console/` by the existing dashboard static route, on the same
  origin, with the same security headers and cache rules.
- It reads the same stored token as the legacy dashboard
  (`localStorage.instar_token`) and validates it against a protected route
  (`/sessions`), never `/health`, which is public. With no valid token it shows
  its own PIN screen, which calls the existing `POST /dashboard/unlock` and stores
  only the bearer token, exactly as legacy does.
- The console is read-only in MVP, so it needs no operator proof. PIN-gated
  actions happen in the legacy tab, which keeps its own in-memory proof and asks
  for the PIN when it has none. Nothing persists the operator proof.

### 4. What is deliberately not in this plan

- **Embedding legacy tabs** inside the console, and reskinning them. Both
  reviewers showed the cost (framing exposure, broken operator proof, duplicate
  pollers, deep-link loss, restyle regressions across 29 tabs).
- **Native rebuilds** of legacy tabs (after MVP, one at a time).
- **"Take over"** (hand the operator the agent's live browser) — needs a
  security decision first; options in `console/design/take-over-handoff.md`.
- **Outcome gallery** and **write actions on Home**.

## Rollout

- **Now (this work):** console at `/dashboard/console/`. `/dashboard` is
  unchanged except for one header link, "Try the new console". The console has
  "Legacy dashboard" in its header and footer.
- **MVP call (Justin):** on his phone and desktop, against the criteria below.
- **Switch (after MVP only):** `/dashboard` serves the console; legacy moves to
  `/dashboard/legacy`. A small URL adapter keeps every link agents have sent
  working: on the console, any request carrying `tab`, `session` or `path` is
  redirected to `/dashboard/legacy` with its full query and hash intact. Tests
  cover an encoded file path, a session-only link and an ordinary tab link.
- **Legacy removal:** no deadline. Legacy stays while any console link points into
  it, and is removed only after a checked inventory shows every tab, write action,
  PIN gate and old link has a working replacement.

## MVP definition (what Justin judges)

0. It looks extremely good and unmistakably Instar on his phone and on desktop.
1. Home's headline and six cards render from live data; each card shows can't-
   tell / partial / stale honestly (unit-tested over HTTP failure, timeout,
   `enabled:false`, null `observedAt`, missing fields and partial pool).
2. Every legacy tab is reachable in two taps from Home; the legacy dashboard is
   one tap away from every console page.
3. Works at 360 and 390 px with no sideways scroll; bottom navigation reachable.
4. Nothing the legacy dashboard does is lost (it is untouched).
5. Three test tiers pass: unit (view-models and state mapping), integration (the
   console files are served with the dashboard headers; the legacy link exists),
   e2e (the console loads and renders against a live server).

## Migration parity and agent awareness

Dashboard files ship in the package (`package.json` `files` includes
`dashboard`), so every agent gets the console on update; no config or hook
migration. The CLAUDE.md template's Dashboard entry gains the console URL through
`generateClaudeMd()` and a content-sniffed `migrateClaudeMd()` entry.

## Review changes

Round 1 (both reviewers: "ready with changes").

| Finding | Handling |
|---|---|
| Framing exposure from SAMEORIGIN (Astra 1, Argon 8) | Accepted: no embedding at all; `DENY` kept. |
| Operator proof not shared by the stored token (Astra 2, Argon 1) | Accepted: console is read-only; PIN actions stay in legacy with its own in-memory proof; nothing persists it. |
| HTTP-200-but-incomplete answers (Astra 3) | Accepted: per-card data contract table, three honest states, null-`observedAt` rule, `scope=mesh` for commitments, tests per case. |
| Deep links and cutover (Astra 4, Argon 4) | Accepted: ordinary links now; URL adapter for `tab`/`session`/`path` at the switch, with tests. |
| Phone budget and workflows (Astra 5, Argon 3/7) | Accepted: one headline + six compact cards, ≤18 rows; independent fetch per card; workflows stay in legacy pages, unframed. |
| Time-based legacy removal (Astra 6) | Accepted: no deadline; inventory-gated removal. |
| Baseline wrong: "flat strip"; machine states not exposed yet; lastActivity is not a sentence (Astra 7, Argon 2) | Accepted: Problem corrected; deterministic machine-state mapping from available fields; lastActivity shown as a timestamped tool use only. |
| Cut group summaries, legacy reskin, unbounded review loop (Astra 8, Argon 5/6) | Accepted: group pages are static directories; no reskin; at most three bounded design passes, Justin accepts. |

Round 2 (Argon: ready; Astra: ready with changes).

| Finding | Handling |
|---|---|
| Detail links led to tabs without the records (Astra 1) | Accepted: inline See all for attention and guards; promises also inline. |
| Mesh commitments filter hid remote violations; coverage unproven (Astra 2) | Accepted: unfiltered mesh read, client-side active rule, origin + age per row, coverage stated. |
| 5 s client deadline races the 5 s peer deadline (Astra 3) | Accepted: 8 s for the pool reads with a "still checking" line at 5 s. |
| Overlapping machine predicates (Astra 4) | Accepted: explicit precedence; speculative PR 2355 branch removed. |
| "Last tool use" mislabels hook events (Astra 5) | Accepted: "active N min ago"; focus endpoint dropped. |
| Under the hood needed a third tap (Astra 6) | Accepted: visible section. |
| Light theme (Astra 7, Argon 5) | Accepted: dark only for MVP. |
| Trailing-slash route test, registry-driven tab test, raw-token unlock fallback, partial two-source cards (Argon 1–4) | Accepted: all four implemented and tested. |

Round 3, visual (both: "close").

| Finding | Handling |
|---|---|
| Uncertainty lost to confident headlines (Astra 1, Argon 1) | Accepted: headline rules above; coverage label in the card head; dashed note for partial coverage; dashed outline on machines with no reading. |
| Secondary text too faint (Astra 2) | Accepted: muted token, 13 px row metadata, 12 px nav labels. |
| Truncated rows unreadable (Astra 3) | Accepted: every attention and promise row expands to its full text, with a chevron, `aria-expanded`, and state kept across refreshes; See all is uncapped. |
| Small touch targets (Astra 4, Argon 4) | Accepted: 44 px card actions, 40 px top chip. |
| Heading margins, loose group heading (Astra 5) | Accepted. |
| Too much amber (Astra 6) | Accepted: only the feature card keeps the amber wash. |
| Mixed load/age column (Astra 7, Argon 2) | Accepted: age always shown, load beside the state. |
| Duplicate Legacy link on desktop, tile affordance, hero depth (Argon 3, 7, 8) | Accepted: chip hidden on desktop, trailing arrow on tiles, soft radial glow behind the headline. |
| Allowed card red/amber mismatch (Argon 6) | Accepted: rows are amber; meter segments separated. |
| "Reaching you" overstated the evidence (Astra) | Accepted: "No replies held". |
| Browser interaction acceptance (Astra) | Kept for the phone acceptance pass with Justin; screenshots cover appearance only. |
