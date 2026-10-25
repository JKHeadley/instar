---
title: "Telegram callback class map — an annotated map of every button and dispatch site, checked by a unit test"
slug: "telegram-callback-class-map"
author: "echo"
eli16-overview: "telegram-callback-class-map.eli16.md"
parent-spec: "docs/specs/telegram-button-approval.md"
parent-principle: "Structure beats Willpower"
status: draft
---

# Telegram callback class map

## Problem statement

`docs/specs/telegram-button-approval.md` §1 fixes a rule: a Telegram (or Slack) button may authorise only
S-class acts (less action, undoable, audited) or an explicitly specified R-class re-grant; everything else is
P and stays on the dashboard; unclassified means P. That spec ships the rule as documentation (lessons-index
L15) and states that it binds through spec review. But spec review does not see every path that adds a tap
handler — feedback-executor pull requests, ordinary fix PRs, a phase of an already-approved spec — and most
button payloads have no fixed prefix. This spec specifies the structural carrier: a checked-in class map of
every button-building and dispatch site, and a unit test that fails when a site is unclassified.

**Not load-bearing for the parent build.** The parent ships no code for the classification rule; it binds
through L15 and review until this test lands. This spec was split out because, across twelve review rounds of
the parent, the test's mechanics were the only part still changing (rounds 10–12). Rounds 11 and 12's findings
are applied in the design below but have not themselves been reviewed; this spec goes through `/spec-converge`
on its own.

## Proposed design

Spec review does not see every path that adds a tap handler (feedback-executor PRs,
ordinary fix PRs, a phase of an already-approved spec), and most button payloads have no fixed prefix. So
every **site** carries an annotation comment `// callback-site: <site-id>`, and the map
`src/data/telegramCallbackClasses.json` lists each site id with the actions it produces or handles, each
classed S, R, P or `none` (a branch that only answers, declines, or rejects malformed data). The test
discovers sites of two kinds, by TypeScript-parser walk over `src/**/*.ts` (comments and type positions never
count):
- **Button-building sites:** a construction of `callback_data` or `inline_keyboard` (Telegram) or a Block Kit
  `action_id` inside a button element (Slack); a call of a listed generic button method (today
  `sendPairingPrompt`, `CallbackRegistry.register`); or the `{text, data}` literal passed to one (today in
  `PairingInviteTelegram`). A multi-line construction is one site, annotated on its first line.
- **Dispatch sites:** every conditional branch (`if`/`else if`/`case`/early return) in the body of a listed
  dispatch entry point, whatever value it branches on — the data itself or a record looked up from it —
  because in three of the four Telegram handlers the action is chosen on server-side state. Entry points
  today: `TelegramAdapter.processCallbackQuery`, the `/internal/telegram-callback` route handler,
  `PairingInviteTelegram.onCallback`, `BurnAlertButtons.handle`, `SlackAdapter._handleInteraction`.
A P action carries either an exception record — reason, ending **event**, granted date — or the status
`unwired`, defined as: a handler exists but **no button-building site produces the action and no production
code calls its entry point** (today burn-alert Release and Snooze: `BurnAlertButtons.handle` exists, nothing
constructs the class). Branches inside an `unwired` handler are annotated like any other and do not fail;
the test fails the moment a button-building site produces an `unwired` action or a production caller of its
entry point appears. Exceptions: `pi:` approve/finish and `tc:g` until dashboard-pin-structural item 2;
prompt-gate answers (Telegram and Slack, every authority-bearing prompt type) until sibling item 7, which
names them. The test fails when: a discovered site has no annotation; a map id has no annotation or an
annotation has no map entry; a P action is neither `unwired` nor excepted; an `unwired` action gains a
button site or a production caller; or a listed method or entry point in the map is absent from the code.
An exception older than 90 days from its granted date makes the test print a warning on its own line; that
is best-effort only — a passing test's output reaches nobody by itself — and the real end of each exception
is the named event in the sibling spec, which must delete the record. Honest limits: the map, the
annotations and the lists of generic methods and entry points are files the agent can edit, so the test
catches *forgetting* to classify, not *misclassifying* — review of the diff does that; a replaced action
under an unchanged annotation passes; and a **new** generic button method or dispatch entry point is
invisible until a human adds it to the lists — the test cannot discover one, and promises nothing there.
The recommended way to give the map teeth is to make it a code-owned path (operator decision, one GitHub
review per reclassification).

## Decision points touched

| Decision point | Classification | Justification / floor |
|---|---|---|
| An unannotated or unmapped button/dispatch site, a P action neither `unwired` nor excepted, or an `unwired` action that gains a button site or production caller fails the class-map test | **invariant** | A closed allowlist on an authority surface; unclassified defaults to P, so the conservative outcome is a failing build that a human classifies. |

## Verify the State, Not Its Symbol

Symbol: every discovered button-building or dispatch site carries a site annotation present in the map, and
every P action is `unwired` or excepted. Claimed state: no tap handler acts on a P-class operation outside the
recorded exceptions. Gaps both ways: a misclassified action passes (review of the map's diff is the check); a
replaced action under an unchanged annotation passes; a new generic button method or dispatch entry point is
invisible until a human lists it. Unmeasurable (a file cannot be read): the test fails rather than passes.

## Multi-machine posture

Repository files only (map, annotations, test); no runtime state on any machine.

## Maturation plan

- **test-agent-live:** the test runs in the unit tier of a `/test-as-self` throwaway build's suite — it passes on the annotated tree (burn-alert handler branches included), fails on each seeded case in its own unit test, and warns (not fails) on an aged exception.
- **dev-agent-live:** the test runs in Echo's suite from the merge of the `/instar-dev` build; it has no runtime surface.
- **fleet:** not applicable — nothing is installed on agents; the test runs in instar's own CI and pre-push tiers.
- **graduation criterion:** the test is green on main, and its own unit test shows it failing on each seeded case.
- **dark-window:** none — nothing ships dark.

## Tests

- **Unit:** the class-map test; its own test seeds every failure case listed above (an unannotated button
  construction, an unannotated Slack `action_id` button, an unannotated `{text, data}` literal, an unannotated
  branch inside a listed entry point, a map id without an annotation, an annotation without a map entry, a P
  action neither `unwired` nor excepted, an `unwired` action with a button site, a listed entry point missing
  from the code) and expects each to fail, seeds a 91-day-old exception and expects a warning without failure,
  and expects the annotated current tree — including `BurnAlertButtons.handle`'s branches — to pass.
- **Integration / E2E:** not applicable — no route, job or runtime path changes.

## Frontloaded Decisions

1. Sites are discovered by a TypeScript-parser walk, never by regex over raw lines.
2. Dispatch discovery is every conditional branch inside a listed entry point, whatever it branches on.
3. `unwired` means no button-building site produces the action and no production code calls its entry point.
4. Exceptions end on named events; age only warns.
5. The lists of generic button methods and dispatch entry points are hand-maintained; the test promises nothing
   about an unlisted one.
6. Making the map a code-owned path is an operator decision, recommended.

## Open questions

*(none)*
