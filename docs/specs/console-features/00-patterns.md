# Console patterns — the shared pieces every feature is built from

Every feature plan in this folder is built from the same small set of parts, so the
console feels like one product rather than 29 pages. A feature may not invent a new
pattern for something one of these already covers; if it needs one, the pattern is
added here first.

All patterns use the tokens in `dashboard/console/console.css` (the instar.sh
identity) and follow the design rule in `../console-makeover.md`: a value that could
not be read says so.

These patterns are proved on one page first (Promises, already being built) before
any other page uses them. Before the pattern is reused, one representative Promises
screen is judged at phone size (390 px) in four states: populated, empty, failed and
mid-action. That is the aesthetic and usability test; no shared framework is built
for all 29 tabs ahead of it. Existing legacy controllers are reused where practical
(for example the cell-sheet refresh-hold tests in
`tests/unit/dashboard-refresh-interaction-hold.test.ts`).

## 1. The feature page

```
┌──────────────────────────────┐
│ EYEBROW (group)              │
│ Headline sentence.           │  ← answers the feature's one question
│ One line of context.         │
│ [ fact ] [ fact ] [ fact ]   │  ← at most 4 facts, plain words
│ ┌──────────────────────────┐ │
│ │ primary list / content   │ │
│ └──────────────────────────┘ │
│ [ primary action ]           │  ← sticky at the bottom on a phone
└──────────────────────────────┘
```

- **Headline first.** Every page opens with a sentence that answers its question
  ("Two jobs failed today; everything else ran on time."), never a title alone.
- **Facts, not tiles of numbers.** At most four short facts. A number always has its
  unit and its meaning ("3 waiting on you", not "3").
- **One primary action**, visible on arrival, sticky at the bottom on a phone.

## 2. Lists

- One row = one thing, in words: a title (two lines max, expandable), one muted line
  of context (machine, age, owner), and a status at the end.
- **Grouping before scrolling.** Repeats collapse into one row with a count
  ("27 copies"). A grouped row keeps what differs between its members: a job that
  runs on two machines keeps each machine's own last outcome and its own Run now
  target inside the group.
- **Older, still open.** An item that is still open but untouched for 14+ days goes
  into a visible group named **"Older, still open"**, shown with its count. It is not
  counted in the page's "needs you" headline: the operator asked for this, because an
  overloaded headline makes him ignore all of it. Nothing is ever described as
  handled, resolved or done because of its age; age only moves it out of the
  headline. Two kinds of item are exempt and keep a visible count in their own
  section whatever their age: **missed, overdue or failed** items, and **items
  waiting for the operator's approval**. For those, the section shows the fresh ones
  as rows and the old ones as a counted line in the same section ("+3 older, still
  open ›"), so the section's count is never smaller than the truth. Each feature plan
  states how this rule applies to it.
- **Filters are chips**, at most four, with counts, above the list. No dropdowns of
  enum values.
- Long lists load the first 20 and offer "Show more"; nothing silently truncates.

## 3. Detail sheet

Tapping a row opens a sheet: a bottom sheet on a phone (drag down or tap outside to
close), a right-hand panel on desktop. The sheet has, in order: a plain summary,
the actions for this item, the full record (identifiers and timestamps last, in the
mono face). The URL changes (`#/feature/item-id`) so a sheet can be linked and Back
closes it.

## 4. Actions

- **Constructive actions** are filled teal buttons. **Destructive** ones (stop, revoke,
  delete) are quiet text buttons, never first, and always confirm in a sheet that
  says exactly what will happen in one sentence.
- **Optimistic, then honest.** The button shows progress, then the server's actual
  answer; a refusal shows the server's reason in words and keeps the user's input.
- An action never navigates away from the page it was started on.

### 4a. Operator proof: one PIN sheet, three adapters

There is **one visual PIN sheet**: a bottom sheet with one sentence saying what the
PIN is about to approve, a numeric field (16 px type so iOS does not zoom), and the
button. What happens to the PIN after it is typed is **not** a property of the sheet.
Each action names one of three adapters, matching what its server route actually
checks, and each group plan lists which of its routes use which adapter.

| Adapter | What the route checks | What the console does | Example routes |
|---|---|---|---|
| **(a) Bearer only** | The ordinary API token. | No PIN sheet at all. Destructive actions get a plain confirmation sheet. | `PATCH /jobs/:slug`, `POST /commitments/:id/deliver`, `POST /routing-spend/freeze`, `POST /subscription-pool/follow-me/cancel` |
| **(b) Operator session** | The `X-Instar-Operator-Session` header, a short-lived proof issued by `POST /dashboard/unlock` (`src/server/AgentServer.ts:1256`, `:1302`). Its lifetime is set by the server: 15 minutes by default (`src/server/DashboardOperatorSessionStore.ts:18`). | The sheet sends the PIN to `/dashboard/unlock` and keeps only the returned session token, in page memory (a variable, never storage), until the server's `operatorSessionExpiresAt`. Within that lifetime, other adapter-(b) actions do not ask again, because the server itself accepts the same proof. A 401/403 drops the token and asks once more. The raw PIN is not kept. | identity recovery (`src/server/routes.ts:23429`), sign-in repair (`:34524`, which accepts this header or a body PIN), message origins (`src/server/telegramOriginRoutes.ts:24`, `src/server/originDisplayPreferences.ts:18`) |
| **(c) Body PIN** | A `pin` field in that one request's body (`checkMandatePin`, `src/server/routes.ts:13664`, or a route's own equal check). These routes do not accept the operator session. | The sheet puts the PIN in that one request and clears it from the field and from memory as soon as the request settles, on every path (success, refusal, network error), the way `dashboard/mandates.js:451` already does. It is never cached and never replayed into a later action. The next adapter-(c) action asks again. | mandates, approvals, pairing approve/finish, account setup, money commits, feedback approvals |

Rules that apply to all three:

- **No PIN where the bearer token suffices.** A PIN is added only where the server
  demands operator proof.
- **No reuse beyond what the server grants.** The only reuse is adapter (b) within
  the server's own session lifetime. The console never turns one typed PIN into
  approval for a different action. This is a deliberate change from the legacy
  pairing card, which held the raw PIN for the whole page (`dashboard/pairing.js:14`,
  `:225`): native pairing actions are adapter (c) and ask each time.
- **Money and feedback commits keep their plan binding.** Where the server renders a
  plan (spending limits, opening or closing a paid route, unfreezing, turning the
  money layer on or off, restarting for it, turning feedback ignores live, accepting
  approver dependence, publishing a held fix), the sheet shows the server's exact
  rendered text under "Exact wording you are approving" and sends the server's
  `planId` and `nonce` (and, for the restart, the hash of the shown text) with the
  PIN. The console may add a plain-words summary above it, never in place of it.
- **"One unlock per visit" is not part of this plan.** Letting one unlock cover
  routes that today require a body PIN would be a separate server change (each such
  route accepting the operator-session header, the way `requireReloginOperatorPin`
  does at `src/server/routes.ts:34524`). It is listed as optional in the README and
  needs the operator's yes. Until then, adapter (c) routes ask every time.

## 5. States

| State | When | Look |
|---|---|---|
| Loading | first fetch in flight | skeleton shapes in place of the content |
| Empty | the source answered, nothing there | one calm sentence saying what would appear here and why it is empty |
| Can't tell | the source failed, timed out, is switched off, or answered without needed fields | dashed slate outline, "Can't tell" + the reason |
| Partial | some machines did not answer | content shown + "No answer from <machine>" |
| Stale | data older than its freshness limit | content shown + "as of <age>" |
| Slow | a request past 5 s that has not failed | "Still checking…" in place, never a frozen spinner |

Each feature plan names its own freshness limit and any feature-specific failure
(for example a session that is alive but stuck).

## 6. Multi-machine

Every list that can span machines shows the machine as context on each row and a
machine filter chip when there is more than one. An unreachable machine is named in
the page, never silently missing. A single-machine install (where `GET /pool`
answers `enabled: false` with an empty machine list, `src/server/routes.ts:21517`)
still gets every per-machine view, as **This machine**.

## 7. Live updates

Pages refresh in place every 30 s while visible (or stream where the source
streams). A refresh never closes an open sheet, never discards typed input, and
keeps focus where it was. A poll never calls a write route.

## 8. Words

Plain language, no internal names as primary content, no raw JSON. Dates as
"3 h ago" with the exact time on tap. Every page passes the Dashboard UX
Standard's glance word budget at its top. A renamed page keeps its old name as a
search alias (the console search and the URL adapter both accept it).

## 9. Maintainer mode is visibility, not authority

The console's maintainer mode (see `under-the-hood.md`) only decides which pages are
shown. Every write keeps its server gate; a hidden page is never the protection.
