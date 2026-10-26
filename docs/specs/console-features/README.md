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

## The new map: 29 tabs become 16 places

| Group | Place | Replaces |
|---|---|---|
| Home | Home | — |
| Work | **Sessions** (with "Paste to a session") | Sessions, Send content |
| Work | **Schedule** | Jobs |
| Work | **Promises** | Commitments |
| Work | **Plans** (with an "In the way" section) | Projects, Initiatives, Blockers |
| Work | **Development** (maintainers only) | PR pipeline, Throughput, Feedback drain |
| Capacity | **Machines** (health and resource use inside each machine) | Machines, Health, Resource usage |
| Capacity | **Accounts** | Subscriptions |
| Capacity | **What thinking costs** (one time control) | Spend, Tokens, LLM activity, Routing map |
| People | **Other agents** | Threadline |
| People | **Messages to you** (the detail of Home's "Can I reach you") | Message origins |
| People | **Permission slips** | Mandates |
| People | **Passwords & keys** | Secrets |
| Settings | **What I'm allowed to do** | Features (autonomy profile first) |
| Settings | **What I've learned about you** | Preferences |
| Settings | **Files** | Files |
| Settings › Under the hood | **How I'm doing inside** | Integrated-Being, Process health, Evidence (a "Why do I believe this?" panel on records) |
| — | retired as a page | Insights (its job is Home's headline; its one line moves to the costs page) |

Every legacy `?tab=` link keeps working through the URL adapter in the parent plan.
Until a feature's native page ships, its tile keeps opening the legacy tab.

## Defects found while planning (fixed by the rebuild)

The planners read every legacy tab against its routes. Some legacy behaviour is
wrong today, and the native pages fix it:

- **Features:** the on/off switch sends only `{to:'enabled'}`; the server refuses that
  for 10 of 13 features (they need a consent record), and profile history never
  shows (it reads the wrong field).
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

Most pages need no new route. The few that do:

1. `consoleProfile: { maintainer, basis }` on the authenticated `/health` — so an
   ordinary user's console never shows maintainer pages.
2. Preferences: a structured list, forget, and edit/add (three routes).
3. Files: a search route and a `truncated` flag on the folder list.
4. Optional, Accounts: stop the poll from writing; one PIN covering a whole visit
   (an operator decision, below).

## Build order

Shared patterns first (`00-patterns.md`: page, list, detail sheet, actions, PIN
sheet, states), then features by how often the operator needs them and how much the
legacy page currently fails him:

1. **Promises** — reuses Home's honesty rules; fixes the count mismatch.
2. **Machines** — with the honest machine states from the machine-load work.
3. **Plans** — fixes three live bugs.
4. **Schedule** — adds "late", "skipped" and "running long".
5. **Accounts** — the largest page; sign-in repair from a phone.
6. **What I'm allowed to do** — makes turning features on actually work.
7. **Messages to you**, **Passwords & keys**, **Permission slips**, **Other agents**.
8. **What thinking costs** (read-only first, then the spending controls).
9. **What I've learned about you**, **Files**.
10. **Sessions** — the live terminal; the legacy one already works on a phone.
11. **Development** and **How I'm doing inside**.

Each page ships behind the console (legacy stays the default until the MVP call),
with the three test tiers, phone and desktop screenshots, and a review pass.

## Decisions that are the operator's

The planners kept these to taste and policy questions the code cannot answer, each
with a recommended default the build uses unless told otherwise:

1. May you drop a promise yourself, or only the agent? *Default: yes, with a reason.*
2. Is "Plans" the right word for projects and initiatives? *Default: Plans.*
3. Should one PIN unlock cover every account and money action for the rest of a visit,
   or ask each time? *Default: ask each time (today's server behaviour).*
4. Should a preference you type outrank one the agent learned? *Default: yes.*
5. Should "Stop auto-merging" be a phone button? *Default: yes (stopping is safe; turning
   it back on keeps its PIN).*
6. Keep the combined throughput index, or just the four plain numbers? *Default: the four
   numbers.*
