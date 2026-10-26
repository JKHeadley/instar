# Console features — a native plan for every dashboard feature

Parent plan: `../console-makeover.md` (the console, Home, the design rule, the
instar.sh look). Shared building blocks: `00-patterns.md`. One section per legacy
tab, in the shape of `TEMPLATE.md`:

- `work.md` — Sessions, Jobs, Commitments, Projects, Initiatives, Blockers, Send content
- `capacity.md` — Machines, Health, Resource usage, Subscriptions, Spend, Tokens, LLM activity, Routing map
- `people-settings.md` — Threadline, Message origins, Mandates, Secrets, Features, Preferences, Files
- `under-the-hood.md` — Insights, PR pipeline, Evidence, Throughput, Integrated-Being, Process health, Feedback drain

Why this exists: the console's first version links every feature to its legacy page.
The operator (2026-10-25): "We should have a VERY intelligent, extremely aesthetic,
and extremely intuitive/user friendly plan specific for EACH feature in the
dashboard." Each plan below starts from the question the operator arrives with,
inventories every control and write action the legacy tab has (nothing is lost),
names what is wrong today with the code that causes it, and describes the new page
with a phone sketch.

These plans were revised after round-1 reviews by GPT-6 Astra and Gemini 4 Argon
(`../reports/console-features-review-r1-astra.md`,
`../reports/console-features-review-r1-argon.md`). What changed is in **Review
changes** at the end.

## The new map: 29 tabs become 16 places

| Group | Place | Replaces |
|---|---|---|
| Home | Home | — |
| Work | **Sessions** (with "Paste to a session") | Sessions, Send content |
| Work | **Schedule** | Jobs |
| Work | **Promises** | Commitments |
| Work | **Plans** (with an "In the way" section, above "In flight") | Projects, Initiatives, Blockers |
| Work | **Development** (maintainers only) | PR pipeline, Throughput, Feedback drain |
| Capacity | **Machines** (always includes **This machine**, with its health and resource use) + a **Health** shortcut on the Capacity page | Machines, Health, Resource usage |
| Capacity | **Accounts** | Subscriptions |
| Capacity | **What thinking costs** ("Recorded AI cost on this machine", one time control) | Spend, Tokens, LLM activity, Routing map |
| People | **Other agents** | Threadline |
| People | **Messages to you** (the detail of Home's "Can I reach you") | Message origins |
| People | **Permission slips** | Mandates |
| People | **Passwords & keys** | Secrets |
| Settings | **What I'm allowed to do** (autonomy profile, then the one home of the safety-check list) | Features |
| Settings | **What I've learned about you** | Preferences |
| Settings | **Files** | Files |
| Settings › Under the hood | **How I'm doing inside** — subtitle "Conversation history, recurring problems, checks on my claims" | Integrated-Being, Process health, Evidence (lookup), and the Preferences tab's class reviews and claim checks |
| — | retired as a page | Insights (its job is Home's headline; its one line moves to the Background checks section of What thinking costs) |

Every legacy `?tab=` link keeps working through the URL adapter in the parent plan,
and every old tab name stays a search alias. Until a feature's native page ships,
and until its rows in the checklist below pass, its tile keeps opening the legacy tab.

## Defects found while planning (fixed by the rebuild)

The planners read every legacy tab against its routes. Some legacy behaviour is
wrong today, and the native pages fix it:

- **Features:** the on/off switch sends only `{to:'enabled'}`; the server refuses that
  for every feature not already in the *interested* or *disabled* state, and for 10 of
  13 features it also needs a consent record; profile history never shows (it reads
  the wrong field).
- **PR pipeline:** has never shown data — no handler for `/pr-gate/metrics` exists.
- **Projects:** "Ack round 0" always acknowledges round 0; Halt has no confirmation and
  a refused halt looks like success.
- **Initiatives:** the "In progress" tile counts whatever the filter returned.
- **Commitments:** the legacy tab counts only beacon-tracked promises, so it disagrees
  with Home.
- **Health:** can read "0 subsystems need attention" while one is failing.
- **Spend:** "spend figures not available" is presented as if turning on limits fixes it;
  they are separate switches.
- **Subscriptions:** a built "logins waiting" panel is never shown; the account grid
  scrolls sideways on a phone; a write request goes out on every 30 s poll.
- **Feedback drain:** a failed data read renders "Nothing needs you".
- **Files:** the folder list is silently cut at 500 entries.
- **Throughput:** hard-coded to the Instar repository and two logins, so an ordinary
  user can be shown Instar's history as if it were theirs.
- **Job history** shows times without dates; **Send content** says "text or files"
  but takes text only.

## What the server needs (kept small)

Most pages need no new route. Part of this plan:

1. `consoleProfile: { maintainer, basis }` on the authenticated `/health` — so an
   ordinary user's console never shows maintainer pages. It controls visibility only;
   every route keeps its own gate.
2. Preferences: one structured read, `GET /preferences`.
3. Files: a search route (under the same path rules as the other file routes) and a
   `truncated` flag on the folder list.
4. Accounts: run the follow-me scan on the server's own timer, so the console never
   writes on a poll.

**Separate changes, not part of this plan's default** (each needs its own spec and
review, and the first needs the operator's yes):

- Letting one PIN unlock also cover the routes that today take the PIN in the request
  body (account setup, identity repair, follow-me approval), by accepting the operator
  session there too. Until then those routes ask for the PIN every time.
- Preference editing, forgetting and "tell me directly", with server-verified operator
  proof before a statement is attributed to the operator (`people-settings.md`).
- Per-check dollar figures, which need feature-to-route attribution in the ledger.
- An apply route for earned-trust suggestions; until it exists there is no accept button.
- A forward lookup in the conversation ledger ("what later resolved this entry?").

## Build order (the one order every group plan uses)

1. **Promises** — proves the shared patterns (`00-patterns.md`: page, list, detail
   sheet, actions, PIN sheet, states). Already being built. One representative screen
   is judged at phone size in four states (populated, empty, failed, mid-action)
   before the patterns are reused.
2. **Machines**, with a visible **This machine** view (health and resource use) that
   works with no pool, and the **Health** shortcut on the Capacity page.
3. **Accounts** (sign-in repair) and **Messages to you** — the operator interventions
   from a phone.
4. **What I'm allowed to do** (driven by the server's actual state and
   `validTransitions`; no fake trust-accept button) and, for maintainers,
   `consoleProfile` plus **Feedback approvals**.
5. **Plans**, **Schedule** and **What thinking costs** (read-only), which also retires
   Insights. Then the remaining pages: Permission slips, Passwords & keys, Other
   agents, What I've learned about you (structured read), How I'm doing inside,
   Files (simple editor and search), Shipping (read-only) and Pace.
6. **Later:** the Sessions page with its live terminal (legacy works on a phone
   today), preference editing and forgetting, "Why do I believe this?" drawers on
   records, the new Shipping controls (hold, test now, stop and restart auto-merging),
   comparison charts, Files editor upgrades (diff review), and the native
   spending-control sheets.

Each page ships behind the console (legacy stays the default until the MVP call),
with the three test tiers, phone and desktop screenshots, and a review pass. Existing
legacy controllers are reused where practical.

## Old control → native control checklist (the switch-over gate)

A legacy tab's tile switches to its native page only when every row for that tab
below has its native control built and checked. A link back to the legacy tab is an
acceptable temporary fallback while a page is being built; it does not tick a row.

| Legacy tab | Old control | Native control | Plan |
|---|---|---|---|
| Sessions | Live session list (WebSocket + pool), idle machines, session count | Sessions list grouped Needs a look / Working / Idle machines | work.md |
| Sessions | Badge legend, tool names, event counts, model badge | Plain words in the row; tool names and event counts in the "⋯" Details | work.md |
| Sessions | New session (name, platform, door, model, machine) | "+ New" sheet with the same fields | work.md |
| Sessions | Default for new topics (Save / Clear) | "Change the default" inside the New session sheet | work.md |
| Sessions | Close (local and remote), with outcomes | "⋯" → Close sheet, same three outcomes | work.md |
| Sessions | Terminal: live stream, scroll-back to 50,000 lines, Resume live output | Open session: terminal, "Back to live" | work.md |
| Sessions | One-line input + Send; keys Enter, y, n, Ctrl+C, Esc, arrows | Multi-line composer + Send; Keys tray, Stop (Ctrl+C) with one confirm | work.md |
| Sessions | Door + model switch, watching for the restart | "⋯" → Switch door and model | work.md |
| Send content | Label, text box with counts, target (incl. Auto), Send | Paste sheet; target named, most recent preselected | work.md |
| Send content | Result line (delivered / waiting / error), live status events | Same states in the sheet | work.md |
| Send content | Recent pastes (last 20) with delete | Recent pastes (count, expandable), Delete with confirm | work.md |
| Send content | (not possible today) text to another machine's session | "Type it into the session" over the live stream, with that machine's answer | work.md |
| Jobs | List with live updates, summary cards, sort, filter chips | Schedule: facts, Needs a look / Coming up / Everything else (search + origin filter) | work.md |
| Jobs | Detail: status, last/next run, 50-run sparkline, history table (50 runs) | Detail sheet: last 20 as marks + **Show all 50** as a dated list | work.md |
| Jobs | Configuration fold (raw cron, model, priority, supervision, tags, pre-flight, machines) | Details fold | work.md |
| Jobs | Run now (with 409 / 429) | Run now, following the run to its end | work.md |
| Jobs | Enable/disable toggle (confirm for high/critical) | On/Off switch, same confirm rule | work.md |
| Jobs | Override, Unfork, Edit (with conflict check) | "⋯": Make my own copy, Go back to the default, Edit | work.md |
| Jobs | Migration banner: confirm / roll back | "Setup issues" line → each explained, same two actions | work.md |
| Jobs | Issues card (kind filter, refresh, dismiss) | "Setup issues (n)" list, kinds in Details | work.md |
| Commitments | Tiles Open / Due soon / Overdue / Waiting on you / Quiet, rows, full record | Promises: facts, sections, detail sheet; Quiet → "paused reminders" state | work.md |
| Commitments | **Mark delivered** on every displayed promise, incl. waiting on you | Mark delivered on every promise shown (secondary on waiting-on-you, missed and older rows) | work.md |
| Projects | Card: rounds, progress, stages, drift, id/version | Plans row + project detail sheet (rounds track, drift sentence, Details) | work.md |
| Projects | Halt | "Stop this round" with the honest interruption sheet | work.md |
| Projects | Ack round 0 | "OK, continue round N" with the current round | work.md |
| Projects | Refresh, auto-poll | 30 s in-place refresh | work.md |
| Initiatives | Status filter Active / All / Completed / Archived / Abandoned | Chips Paused / Halted / Waiting on you; Completed / Archived / Abandoned inside Finished | work.md |
| Initiatives | "Show projects + children" checkbox | Always shown, children folded | work.md |
| Initiatives | Tiles, record, signal record, Refresh | Plans facts, sections, detail sheet | work.md |
| Blockers | Tiles Truly stuck / Being worked / Resolved, record | In the way section (+ access requests in Needs you), Cleared this week | work.md |
| Machines | Glance, per-machine record, guard counts | Machines cards and detail; guard count links to the safety-check list | capacity.md |
| Machines | Rename | Inline rename with error text | capacity.md |
| Machines | Identity recovery: Rotate, Acknowledge, Approve / Deny claim | Identity section sheets (operator session) | capacity.md |
| Machines | SSH pair health | Connections section | capacity.md |
| Machines | Autonomous throughput observations | Moves to Work (beside Plans) | capacity.md |
| Health | Subsystems, records, events, Refresh | This machine › My parts here; Health shortcut on Capacity; failures on the Machines landing page | capacity.md |
| Resource usage | CPU / memory per source, Refresh | This machine › What's using it | capacity.md |
| Subscriptions | Account cards with quota bars | Allowance rows + account detail | capacity.md |
| Subscriptions | Account × machine grid | On each machine: chips per account (phone), compact table (desktop) | capacity.md |
| Subscriptions | Follow-me cards, Approve follow-me | Needs you card, PIN each time | capacity.md |
| Subscriptions | Set up / Sign in / Retry a cell; Repair identity | Cell sheet, PIN each time | capacity.md |
| Subscriptions | Submit code; Cancel a sign-in | Sign-ins in progress / cell sheet, bearer | capacity.md |
| Subscriptions | Repair sign-in / Try again / Cancel repair / Don't retry on its own (local and any machine) | Cell sheet, operator session | capacity.md |
| Subscriptions | Pending logins panel (built, never shown) | Sign-ins in progress list | capacity.md |
| Spend | Grain: daily / **hourly / monthly / total**; Refresh | Time control + More detail: By hour (30 days) / By day / By month / All time | capacity.md |
| Spend | Estimated cost, text processed, per-model and per-key records | Recorded cost section with cost basis and committed limits kept separate | capacity.md |
| Spend | Money-layer switch: Turn on / Re-check / Also record it here / Turn off; Restart | Spending controls sheets with exact plan text + nonce (later; legacy link until then) | capacity.md |
| Spend | Paid doors: picker, limits, Preview cap / go live / Unfreeze, Approve with PIN | Route sheets with prefilled limits and exact plan text (later; legacy link until then) | capacity.md |
| Spend | Freeze this door | Freeze on the route row, with optional reason | capacity.md |
| Tokens | Summary, recent conversations, idle, Refresh | Your conversations section (`sessionsActive` / `codex.sessionCount`) | capacity.md |
| LLM activity | Window, per-feature records | Background checks section (calls and tokens, no per-check dollars) | capacity.md |
| Routing map | Chains, lane and job records | "Model routing & fallbacks" sheet | capacity.md |
| Insights | Plain-read strip | One line at the top of Background checks | capacity.md, under-the-hood.md |
| Threadline | Restart notices (Dismiss), leak alarm | Waiting on you cards | people-settings.md |
| Threadline | Approve, Decline, Finish, Not them, It's one of my agents | Waiting cards / "…" menus (PIN each time where the server asks) | people-settings.md |
| Threadline | Make an invite (for whom, 1 h / 24 h), Copy / Done, Check an invite, Cancel an invite | Connect another agent sheet (Make / I was sent one), Copy and Share | people-settings.md |
| Threadline | Paired-agents list | Agents list with reachability | people-settings.md |
| Threadline | Telegram bridge: master, auto-create, mirror; allow/deny lists | Mirroring to Telegram section; per-agent always / never / default | people-settings.md |
| Threadline | Thread list (filters), thread view, message search, Refresh | Agent detail conversations, search icon | people-settings.md |
| Message origins | Display settings (picker, agent defaults, four checkboxes, Save) | Footer on messages sheet | people-settings.md |
| Message origins | Recording status | Facts + Recording details disclosure | people-settings.md |
| Message origins | Recent messages, Load more, Refresh | Recent list with Load more; held replies list | people-settings.md |
| Mandates | Approve / Decline requests | Waiting for you cards (PIN each time) | people-settings.md |
| Mandates | Issued mandates, grants | Active slips, slip detail | people-settings.md |
| Mandates | Grant a person an action | "Let a person act" in slip detail | people-settings.md |
| Mandates | Revoke | Revoke at the bottom of slip detail | people-settings.md |
| Mandates | Advanced: author a mandate by hand | Same, behind a disclosure, with an agent picker | people-settings.md |
| Mandates | Decision audit (200 rows, chain verified) | Decision history, chain line at the top | people-settings.md |
| Secrets | Requests (waiting / expired), Open, Copy link, Cancel | Waiting cards: Open, Share link, Cancel in "…"; Expired collapsed | people-settings.md |
| Secrets | Create test request | "Try it with a test link" inside Ask someone for one | people-settings.md |
| Features | Autonomy profile Change / Apply, profile history | Profile control + confirm sheet with reason; History | people-settings.md |
| Features | Feature switches and detail | Features list; switch driven by `validTransitions`, consent and challenge in the sheet | people-settings.md |
| Features | (on Machines today) guard list | Safety checks section, one tap from Home | people-settings.md |
| Preferences | Preferences, recent corrections | How you like things (structured read), Things I'm still watching | people-settings.md |
| Preferences | **Class reviews**, **Claim Verification observations** | How I'm doing inside › Checks on my own claims | under-the-hood.md |
| Files | Tree, open, render, highlight, binary placeholder | Browse, viewer | people-settings.md |
| Files | Edit, Save, Cancel, ⌘S, Esc, unsaved-changes guard | Edit button, sticky Save / Cancel header | people-settings.md |
| Files | Copy | "…" → Copy text | people-settings.md |
| Files | Conflict: Overwrite / Reload / Cancel | Reload theirs / Overwrite with mine, Copy my version | people-settings.md |
| Files | 401 stash and restore; deep links `?path=` | Kept, made visible; URL adapter | people-settings.md |
| PR pipeline | PR list (never worked) | Shipping (read-only) + Open on GitHub | under-the-hood.md |
| Evidence | Viewer scope; by-entity lookup; What cites this (kind, source id); Inspect evidence | Look up a memory's sources (one field, kind picker when ambiguous, scope picker) | under-the-hood.md |
| Throughput | Author select, window select | Person picker, window picker | under-the-hood.md |
| Throughput | Charts: merges, latency, rework, reverts, **median push iterations**, changed lines, index | Four plain numbers + charts incl. Push iterations and Index | under-the-hood.md |
| Integrated-Being | Kind / counterparty / limit filters; entries table; stats cards | Timeline with chips (incl. Commitments); Show more; tiles; counters under Technical | under-the-hood.md |
| Integrated-Being | Commitment entries with their status | Their own detail sheet with full status (unknown when later history isn't loaded) | under-the-hood.md |
| Integrated-Being | **Chain explorer: ledger-ID lookup** | Technical → Look up an entry by its id | under-the-hood.md |
| Integrated-Being | Session bindings, Revoke | Technical → Session bindings, Revoke with confirm | under-the-hood.md |
| Process health | Patterns, problems (last 10), rollout track, More detail | Problems I caught: patterns, Show older, one-line stage, Technical | under-the-hood.md |
| Feedback drain | Decision headline with its button | Headline + the to-do card open under it | under-the-hood.md |
| Feedback drain | Readiness authority: Adjust limits, Approve / Restore / Save limits / Revoke | Approval card and Settings (PIN each time) | under-the-hood.md |
| Feedback drain | Triage authority: Approve / Restore / Revoke | Same | under-the-hood.md |
| Feedback drain | Ignores live / back to practice; Let it run anyway; Review and publish | Sheets with the server's exact plan text, PIN + plan nonce | under-the-hood.md |
| Feedback drain | Ranked queue (top 25), More detail | Queue rows, Technical | under-the-hood.md |

## Decisions that are the operator's

The planners kept these to taste and policy questions the code cannot answer, each
with a recommended default the build uses unless told otherwise:

1. May you drop a promise yourself, or only the agent? *Default: yes, with a reason.*
2. Is "Plans" the right word for projects and initiatives? *Default: Plans.*
3. Should a separate server change let one unlock also cover account setup, identity
   repair and follow-me approval (routes that today take the PIN in the request)?
   *Default: no; they ask each time, as today.*
4. When preference editing is built (later), should a preference you state yourself,
   once the server can prove it came from you, outrank one the agent learned?
   *Default: yes, only with that proof.*
5. When the Shipping controls are built (later), should "Stop auto-merging" be a phone
   button? *Default: yes (stopping is safe; turning it back on keeps its PIN).*
6. Keep the combined throughput index, or just the plain numbers? *Default: the plain
   numbers.*

## Review changes

How each round-1 finding was handled. "Astra" = GPT-6 Astra (verdict: not ready, 10
findings). "Argon" = Gemini 4 Argon (verdict: ready with changes); Argon's ranked
findings are A1–A9, and points raised only in its body sections are listed after them.

| Finding | Handled |
|---|---|
| Astra 1 — the PIN pattern mixes three contracts | Accepted. `00-patterns.md` §4a: one visual PIN sheet with three adapters: (a) bearer only, (b) operator session from `/dashboard/unlock` held in page memory for its server lifetime, (c) body PIN cleared after the one action. Every group plan lists its routes by adapter. Money and feedback commits keep the server's plan text and nonce. "One unlock per visit" is now a separate, optional server change. "Don't retry on its own" corrected to operator session. Native pairing no longer keeps the raw PIN. |
| Astra 2 — "you told me" preferences forgeable; forget is not a small wrapper | Accepted. Structured read only in this plan; editing, forgetting and "tell me directly" are a separate later backend change requiring server-verified operator proof, with the put-only seam, replica coercion, union readers, concurrent edits and re-learning listed as open work. The "small route wrapper" claim is removed. |
| Astra 3 — ledger commitments are not Promises duplicates; route inventory wrong; chain walks backwards | Accepted. Commitment entries keep their own detail sheet with full status; no Promises link without a verified relationship. Inventory corrected (`POST /shared-state/resolve/:id` exists, `user-resolve` answers 501). Status shows "unknown" when later history cannot be established; the backwards chain is no longer claimed to prove it. |
| Astra 4 — "Pause at a safe point" misdescribes Halt; Resume omits the round | Accepted. "Stop this round" with a sheet saying it interrupts running work. Resume sends the selected round's index. Approval recorded / scheduled to resume / running are told apart from returned and observed state. |
| Astra 5 — costs page claims more than its sources prove | Accepted. Titled "Recorded AI cost on this machine"; cost-basis words kept; committed limits shown separately; no "covered by subscription" for missing attribution; per-check calls and tokens without dollars; token counts use `summary.sessionsActive` and `codex.sessionCount`; routing usage labelled as aggregate. |
| Astra 6 — holes in "nothing is lost" | Accepted. Old control → native control checklist added above and made the switch-over gate. Mark delivered on every displayed promise; Spend hourly / monthly / total under More detail; Show all 50 job runs; median push iterations kept; ledger-ID lookup kept; class reviews and claim verification added as their own section. |
| Astra 7 — merging Health hides it; single-machine hole | Accepted. A This machine view that works with no pool; a Health shortcut with a one-line summary on Capacity; failures surfaced on the Machines landing page. The incorrect "Home already covers it" rationale is replaced with what Home actually reads. "How I'm doing inside" gets a subtitle and old names as aliases. |
| Astra 8 — the age rule can hide unresolved trouble | Accepted. "Probably already handled" renamed "Older, still open" everywhere; old items grouped and counted but not in the headline, never described as handled; missed / overdue / failed and approval items keep a visible count in their own section regardless of age; grouped jobs keep per-machine outcomes and action targets. |
| Astra 9 — Features repair does not follow the state machine; fake trust accept | Accepted. The sheet is driven by the server's state and `validTransitions`, step by step, with consent and challenge; the four test paths are listed as the gate. The trust-accept button is removed until an apply route exists. |
| Astra 10 — build order delays urgent workflows; too much new product | Accepted. One build order, used in every group plan. Terminal, preference writes, Evidence drawers, new shipping controls, comparison charts and Files editor upgrades moved to Later. Pace grounded in what the route returns (daily medians labelled as such; result-cap refusal shown as can't tell, not partial). File search scoped to the existing path rules. Maintainer mode stated as visibility only. One representative screen judged at phone size in four states before the patterns spread; legacy controllers reused where practical. |
| Argon A1 — standardize PIN handling; never cache the raw PIN | Accepted, as Astra 1. One partial difference: Argon asked for a fresh PIN on every destructive or authority-granting commit. Routes that take a body PIN do ask every time; identity-recovery actions accept only the operator session, so within a live session the console does not re-ask (the server grants that), but they still open a confirmation sheet. |
| Argon A2 — Preferences audit sections orphaned | Accepted. "Checks on my own claims" section added to How I'm doing inside, backed by `/class-reviews` and `/completion-claim/audit`. |
| Argon A3 — "In the way" below "In flight" | Accepted. Plans order: Needs you → In the way (when non-empty) → In flight → Idle → Finished. |
| Argon A4 — Files diff engine and keyboard bar are over-engineered | Accepted. MVP editor: sticky Save / Cancel header, plain 409 prompt with times, draft kept and copyable; no diff engine, no keyboard-tracking bar. Diff review moved to Later. |
| Argon A5 — guard details split across three places | Accepted. The guard list has one home, What I'm allowed to do › Safety checks, deviant checks first, one tap from Home's card; Machines shows a count linking there. |
| Argon A6 — routing map inline under a time control it ignores | Accepted. "Model routing & fallbacks" is a sheet opened from the costs page header. |
| Argon A7 — move Feedback up; align README with capacity.md | Feedback approvals moved up to step 4. Order alignment done, but in the operator's chosen order rather than capacity.md's old one: Accounts (step 3) now comes before read-only costs (step 5) everywhere, because sign-in repair is an operator intervention; capacity.md was changed to match. |
| Argon A8 — Insights target disagrees between docs | Accepted. One destination: the top of the Background checks section of What thinking costs, in both capacity.md and under-the-hood.md. |
| Argon A9 — no cross-machine paste | Accepted, with an honest limit: for a session on another machine the paste sheet offers "Type it into the session" over the live stream (which already relays input), states that it is not kept as a paste, and shows that machine's refusal if it does not accept remote typing. |
| Argon (factual errors) — PIN lifetime contradiction across docs | Fixed by the adapter table (Astra 1). |
| Argon (lost controls) — Initiatives paused / halted have no filter | Accepted. Status chips for Paused / Halted / Waiting on you, plus Completed / Archived / Abandoned inside Finished. |
| Argon (confusing merges) — How I'm doing inside mixes audiences | Kept as one page with a stated shared question ("What have I been doing on my own, and has it held up?"), a subtitle, maintainer detail folded under Technical, and old names as aliases; a split into a second page is recorded as the fallback if use shows it is still a drawer. |
| Argon (security) — `consoleProfile` must not be relied on for access | Accepted; stated in `00-patterns.md` §9 and under-the-hood.md: visibility only, every read and write keeps its server gate. |
| Argon (over-engineering) — Pace 30-day double-window math | Accepted. Cut: Pace shows the selected window's plain numbers from one fetch; no client-side comparison. |
| Argon (build order) — costs before Accounts, as capacity.md had it | Not adopted; see A7. |
