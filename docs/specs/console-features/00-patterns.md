# Console patterns — the shared pieces every feature is built from

Every feature plan in this folder is built from the same small set of parts, so the
console feels like one product rather than 29 pages. A feature may not invent a new
pattern for something one of these already covers; if it needs one, the pattern is
added here first.

All patterns use the tokens in `dashboard/console/console.css` (the instar.sh
identity) and follow the design rule in `../console-makeover.md`: a value that could
not be read says so.

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
  ("27 copies"). Old untouched items move to a visible "older" group that is not
  counted in the headline.
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
- **Operator proof.** Where the server requires a recent PIN (operator-session
  routes), the action opens a PIN sheet in place; after one PIN the proof is held in
  memory for its server-set lifetime, never stored. No PIN is added where the
  bearer token already suffices.
- An action never navigates away from the page it was started on.

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
the page, never silently missing.

## 7. Live updates

Pages refresh in place every 30 s while visible (or stream where the source
streams). A refresh never closes an open sheet, never discards typed input, and
keeps focus where it was.

## 8. Words

Plain language, no internal names as primary content, no raw JSON. Dates as
"3 h ago" with the exact time on tap. Every page passes the Dashboard UX
Standard's glance word budget at its top.
