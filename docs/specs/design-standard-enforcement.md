---
title: "Every design mistake the owner points out becomes a rule, and every screen change shows its screens against the rules before it merges"
slug: design-standard-enforcement
author: echo
eli16-overview: docs/specs/design-standard-enforcement.eli16.md
parent-principle: "Structure beats Willpower"
tier: 2
origin: "Justin, Chief of Staff conversation, 2026-11-21 12:12 PST: 'when I point out a bad UI/UX aspect of our designs, I would like to have a standard/requirement in which you officially diagnose what went wrong (what aesthetic or UI/UX best practices were violated) and then update our required UI/UX design standards (that should be infrastructurally enforced for ALL development that we do) such that we no longer make those mistakes. The goal should be better and better results in our designs that align with our goal to delight the user.' The Chief of Staff's brief the same day adds: every change touching a user interface shows screenshots at the standard sizes and a checklist against the standard before merge, checked by a gate; machine-checkable rules get automatic checks; every piece of design feedback is a tracked card with a diagnosis, a fix, a rule change and a record linking the feedback to the rule; 'write it as a spec and converge it before building'."
lessons-engaged:
  - "Structure beats Willpower (the dashboard quality standard already says 'the PR says which screens were loaded and at which widths'; nothing checks it, and DF-0001 shipped anyway)"
  - "Verify the State, Not Its Symbol (the gate makes the pictures itself from the code being merged; nobody submits a picture and nobody reads a size from a file name)"
  - "Signal vs. Authority and Judgment Within Floors (measurements are signals; one decision table turns them into a merge decision; waivers, promotions and 'is this feedback' are judgments with stated floors)"
  - "Counts are signals, not gates (a change is compared with its own base in the same run; no stored count and no run count decides anything)"
  - "No Silent Degradation to Brittle Fallback (a step that could not run says so by name on the record and is swept the next day; it is never a silent pass and never a red verdict caused by a missing tool)"
  - "Delivery and cost outrank gate strictness (a broken renderer cannot stop merges; a runtime switch outside the tree turns the step off)"
  - "Close the Loop: Untracked = Abandoned (design feedback is a card that closes only on verified facts; every staged piece cites a tracked card)"
  - "The Agent Carries the Loop; Approval Only Where Required (the owner is asked for the constitution article and for waiving a rule his own feedback earned, nothing else)"
  - "Operator handoff: verified authority (the owner's waiver is a phone presence tap; the dashboard PIN, which the agent can read, never counts)"
  - "Private evidence never enters the public repository (captures and the owner's screenshots stay in the agent's private store)"
  - "Always a Multi-Machine Entity (every new piece of state declares its posture from the closed list)"
  - "Updates never restrict existing agents; Migration Parity; Agent Awareness"
---

# Every design mistake the owner points out becomes a rule, and every screen change shows its screens against the rules before it merges

## Problem statement

On 2026-11-21 Justin compared two screenshots and saw that the Mac app's accounts screen was clearly worse than the web dashboard's. The diagnosis (`docs/design-feedback/DF-0001-accounts-usage-mac-vs-web.md`) found fifteen problems. For twelve of them no rule existed anywhere. For the rest a rule existed for the web only and nothing applied it to the Mac. `docs/DESIGN-STANDARD.md` now holds 65 rules for all six surfaces, 27 of them marked machine-checkable, and a table of standard screenshot sizes. Three things are still missing, and each is structural:

1. **Nothing makes a screen change show its screens.** The standard says captures are taken at the standard sizes before anyone is asked to look. Nothing produces them or checks that anyone read them.
2. **No machine-checkable rule has a machine check that runs at merge.** The 27 machine rules are descriptions of checks, not checks.
3. **The feedback loop is a paragraph.** Whether a diagnosis, a rule and a fix follow the owner's remark depends on the session that hears it remembering to do it.

This spec makes all three structural, and it carries the server and web half of the DF-0001 fix as its first build stage.

**What changed after review round 1.** The first draft had the author commit pictures and a hand-filled manifest, had a browser lane gate every merge, and made the owner the only way past any failing rule. Round 1 found about 65 design problems with that shape. This revision replaces it with a smaller one: the gate makes the pictures itself and keeps them outside git; a change is compared with its own base in the same run, so no stored baseline exists; one decision table says what merges; a step that cannot run never turns a change red; and the owner is asked only about rules his own feedback earned.

## Words used here

- **Local Verify**: the verifier on the agent's own machines that runs the tests for a pull request and writes a *verify record* for exactly (pull request, head, base). **safe-merge** reads that record and merges or refuses. A *merge floor* is the set of things safe-merge requires: the `local` floor reads the verify record, the `actions` floor reads GitHub check results.
- **The lead**: the one machine in the agent's pool that currently runs scheduled work.
- **Maturation review**: the existing weekly review of features still proving themselves.
- **Earned rule**: a rule in the standard marked "Earned from: DF-NNNN", meaning the owner's feedback created or sharpened it. Today 24 rules carry the mark.
- **Development agent**: an agent with `developmentAgent: true` in its config, today Echo.

## Ground truth from the code (branch `echo/design-standards` at 0bf18894d)

Read in this worktree, in the apps checkout at `/Users/dabombstudio/.instar/agents/echo/apps/instar-ios`, and in the second rule book through the GitHub API, on 2026-11-21.

| Existing piece | Where | State today | How this spec uses it |
|---|---|---|---|
| Design Standard | `docs/DESIGN-STANDARD.md` | 65 rules `DS-*`, each with Rule, Why, Bad, Good, Surfaces, Check (`machine` or `review`), Source or Earned from. Markdown only; no parser reads it. | The single source. One parser reads it. |
| First feedback entry | `docs/design-feedback/DF-0001-…md` | Header table, the owner's words, 15 numbered problems, the fix, a table of 22 rules added or sharpened, a status block. No images: they are in the agent's private store. | The format the lint enforces. |
| Repository visibility | `gh repo view JKHeadley/instar` | PUBLIC. The apps repository `EchoOfDawn/instar-desktop-apps` is private. | No capture and no owner screenshot is ever committed to instar. |
| Harness classifier | `src/localVerify/harnessClassifier.ts` | `HARNESS_GLOBS` lists the merge machinery, `vitest*.config.ts` and `tests/setup/**`. A change matching it is *harness-changing* and needs an independent-review trace before its green record is posted. `TOOLCHAIN_PACKAGES` does the same for test-toolchain versions. | The gate's own files join `HARNESS_GLOBS`; `playwright-core` and `axe-core` join `TOOLCHAIN_PACKAGES`. |
| Merge path | `scripts/safe-merge.mjs`, `src/localVerify/` | safe-merge runs its body checks "from THIS (trusted) copy". Lanes are `unit`, `integration`, `e2e`; all gating. Live switches exist under `monitoring.localVerify` (`mergeLine`, `mainRedHold`, `failFast`), read at run time, absent meaning on. | The design step is not a lane. It is one step after the lanes, with its own live switch in the same family. |
| Browser tooling | `package.json` | `jsdom` only. No Playwright, no `axe-core`. | `playwright-core` with its pinned Chromium build, and `axe-core`, become dev dependencies. |
| Console pages | `dashboard/console/nav-model.js` | A route table of about 30 routes, already walked by tests. | Web screens are seeded from it. |
| Other dashboard pages | `dashboard/index.html`, `desktop.html`, `recovery.html`, `proposals.html`, `dashboard/project-app/`, `dashboard/maturation/`, `dashboard-pair/pair.html` | Not console routes. | Listed in the registry as `uncaptured` under tracked item DSE-T5. |
| Work Board cards | `src/core/WorkCardStore.ts`, `src/core/WorkBoardService.ts` | `DoneWhenItem.certify` is exactly `'owner-confirms' \| 'agent-may-certify'`; any other value rejects the whole card. `links` is a material field, so writing a link voids earlier evidence. `covers` accepts only `plan:`, `pr:` and, for the server, `cos:waiting:`. Evidence records carry `by`, which is `system` for the in-process server writer. A person's `reopen` tap makes the card need the owner's confirmation afterwards. | Feedback cards use the existing shapes only: no new `certify` value, no `covers`, no links after creation, no reopen tap. |
| Owner taps | `src/server/workBoardRoutes.ts`, `src/server/routes.ts` | The console tap route accepts the dashboard PIN and records `proof: 'pin'`; the code's own comment says "the PIN is available to the agent". The phone route records `proof: 'presence'` (Face ID on the owner's phone). `phoneOnlyCard(cardId)` already refuses a PIN approval for one family of cards. An approve tap is accepted on any card whose material hash matches, and an edit to title, need or done items voids it. | The owner's waiver is a phone presence tap on a phone-only card. A PIN tap never counts. |
| Owner-message seam | `src/commands/server.ts`, `src/core/ownerWords.ts`, `src/messaging/slack/SlackAdapter.ts` | Features chain their own wrapper on `telegram.onMessageLogged`; entries from the Instar app arrive on the same callback with `via: 'mobile-device'`. `isOwnersOwnWords(entry, ownerId)` excludes forwarded text and team members, and returns true for any sender when no owner id is configured. The Slack adapter has its own `onMessageLogged`. | The detector chains its own wrapper and refuses to act when no verified owner is configured. Slack is proven in stage 3 or carded (DSE-T9). |
| Account usage, server | `src/server/mobileCapacityRoutes.ts` | `usageWindows()` ends `return wins.sort((a, b) => b.pct - a.pct)`. The account's top limit is read as `windows[0]` at lines 332, 335 and 414. Tone is computed on the rounded percentage. A limit whose reset time has passed keeps its old percentage; only `resetsAt` is cleared (line 426). | Changed in stage 1. |
| Account usage, web | `dashboard/console/accounts-model.js` | Fixed order. `windowRow()` sets tone from the unrounded percentage. A limit whose reset time has passed is `rolledOver`: it shows "—", has no tone, and is left out of the tightest limit. Accounts sort with no tie-break. | Changed in stage 1. |
| Apps that read the accounts list | apps checkout | iPhone and Mac draw `windows` in the order received and sort for the headline themselves (`InstarApp/CapacityViews.swift:390`, `InstarMac/MacOpsScreens.swift:926`, `InstarApp/CapacityData.swift:123`). Windows reads the list (`InstarWindows/Core/CapacityPagesData.cs`, `App/CapacityPages.cs`). `linux/main` has no match. On `android/main` a search matched three files that were not opened. | Removing the server's sort is safe for installed Apple apps. Stage 5 opens the three Android files before the note goes out. |
| Native apps repository | `EchoOfDawn/instar-desktop-apps` | Branch families `apple/*`, `android/*`, `windows/*`, `linux/main`. No workflows, no hooks, no tags, no pull requests, no rulesets on its plan. Releases are made by scripts (`scripts/ship.sh`, `ship-mac.sh`, `publish-mac-feed.sh`, `play-publish.mjs`, the Windows and Linux release scripts). Apple builds run on the Laptop under a one-build lock. | The unit of change there is the release. The gate is a step in the release scripts. |
| What ships in the package | `package.json` `files` | `scripts/`, `src/data/`, `dashboard/`, `skills/`. Not `docs/`. | The apps repository depends on nothing in the installed package. It carries a vendored copy. |
| Awareness entries | `src/data/awareness/README.md` | An entry can vary only by `requires: telegram`. A row under a core heading still needs a template edit and a migration. | One new `requires` value, `developmentAgent`, is part of this build. No core-table row is added. |
| Skill updates | `src/core/PostUpdateMigrator.ts` lines 4121 to 4126 | A fingerprinted, idempotent migration already patches the installed `instar-dev` and `build` skills and skips customised copies. | The same pattern delivers the new skill step. |
| Constitution | `docs/STANDARDS-REGISTRY.md` (code-owned by Justin); `scripts/check-constitution-pairing.mjs` | The second book is another repository, `JKHeadley/instar-2`: `docs/01-the-rules.md` holds 123 numbered rules as table rows (rule 80 Operator-Surface Quality, rule 81 Dashboard UX Standard). A change to either book carries a `Constitution counterpart:` line naming the other pull request. | One article and one rule row, paired. |

## Threat model

The agent is cooperating but forgetful, and under time pressure it takes the shortest path. The failures this prevents are omissions: nobody looked at the screen, the data was tidy, feedback was acknowledged in chat and never diagnosed. The shortcuts designed against:

- **A picture from another version, or of tidy data.** Nobody submits pictures. The gate renders the head of the change itself, with data it generates itself.
- **Changing the gate in the change being gated.** The verifier runs the base commit's copy of the gate, and the gate's files are harness files, so changing them needs an independent review.
- **A waiver the agent grants itself on the owner's rules.** Waiving an earned rule needs the owner's Face ID tap on his phone. The dashboard PIN, which the agent can read, is refused.
- **Feedback attributed to the owner that he did not give.** The server reads the message from its own log and tests the sender itself. A session cannot supply the words.
- **A check that passes because it could not run.** That result has its own name, `unavailable`, on the record. It is never written as a pass.

Not prevented, as for every merge gate today: a session that merges with an admin merge, or builds and uploads an app by hand outside the release scripts. The daily sweep (section 6) finds the first the next day.

## Frontloaded Decisions

### Yours to decide

1. **Scope is Instar's own development, now.** The gate and the feedback loop run on the development agent, for the instar repository and the apps repository. *Recommended*: "all development that we do" is Instar's development today, and a hold on other agents' projects would restrict them through an update. Offering the same tools to users for their own projects is tracked item DSE-T1 <!-- tracked: CMT-2165 -->, not left implied.
2. **Who can let a change through with a rule failing.** For a rule your feedback earned: only you, by a Face ID tap on your phone, for that exact change. For any other rule: a reviewer that did not write the change, with a written reason, recorded and listed in the weekly review. *Recommended*: your rules are never waived without you, and a false failure of a new browser check never becomes your task. Alternative: you approve every waiver.
3. **You are never required to tap to close design feedback.** The card closes when the server has verified the diagnosis, the rules, the fix and the new check. You are shown the before and after pictures in the conversation where you raised it. If you say it is still wrong, that opens a continuation of the same entry. *Recommended*. Alternative: a confirming tap from you on every card.
4. **Loosening an earned rule needs you.** Removing a surface from it, changing its check from machine to review, retiring it, or turning its check from blocking back to reporting needs your phone tap. Adding rules and tightening rules is the agent's. *Recommended*.
5. **One constitution article, in both books.** Approving this spec approves both wordings (section "Constitution wording"). The registry is code-owned by you, so that pull request needs your review on GitHub.

### Decided by the agent; say if you disagree

6. **The gate makes the pictures; nothing visual is committed to instar.** Captures live in the verifier's artifact store, outside git. The verify record carries a small manifest of hashes, sizes and rule results. *Recommended*: this removes repository growth, stale pictures and private content in a public repository at once.
7. **A step that cannot run never refuses a merge.** A missing renderer, a crashed harness or the off switch records `unavailable`, raises one degradation signal, and the change is rendered by the next daily sweep. *Recommended*: a broken tool must not stop every merge. Cost: a change can merge unseen for up to a day (see Under-block).
8. **A change may not add violations; it need not clear old ones.** Violations already present at the base do not block. If one of them breaks an earned rule, one tracked card for that screen is opened or refreshed. The exception is a change that says it is the fix for a feedback entry: it must leave none of that entry's violations on that entry's screens. *Recommended*.
9. **Day one: structural checks refuse, rule checks report.** From the day the step lands, a UI change with a visible difference and no review is refused, and so is a changed UI file that belongs to no registered screen. Every rule check starts in `report`. A pull request whose base predates the gate is not gated until it merges main, because the gate runs the base's copy. *Recommended*.
10. **Promotion to blocking is a judgment.** The maturation review moves a check to `block` on evidence: which screens, sizes, themes and verifier machines it has run on, its negative control, and every false failure traced. No run count is the test. Each check's row carries a date by which it is promoted, changed or retired.
11. **Renderer.** `playwright-core` with the Chromium build it pins, and fonts bundled with the harness, installed by the verifier into its own directory. `axe-core` for contrast, names and target size. *Recommended* over the machine's own Chrome, which updates itself and differs by machine.
12. **Review rules are answered by a reader who did not write the change**: a fresh subagent given the standard and the gate's captures. Its name and model are recorded as reported. This is self-reported and stated as such.
13. **Design feedback is noticed by one fast model call per owner message.** The result is only a candidate. The session in that conversation confirms it before a card opens, so a wrong guess costs the owner nothing. *Recommended*.
14. **Apps repository: the release is the unit.** The gate is a step in each family's release script, using a copy of the checker and the standard vendored into that family at a pinned version. Evidence is stored in the private apps repository. Native captures and native automatic checks are tracked items with named owners (DSE-T2 to DSE-T4) and block nothing until their capture tool exists. *Recommended*.
15. **`docs/DESIGN-STANDARD.md` is not code-owned.** Decision 4 protects earned rules instead.
16. **DF-0001 stage, three points beyond the brief.** (a) Both sides compute a limit's colour from the rounded percentage that is displayed, so 89.6% shows "90%" in red everywhere. (b) The server adopts the web's handling of a limit that has already reset: no colour, and it is not the account's top limit. (c) The server lists accounts needing sign-in first and the web does not; stage 1 adds the name tie-break only and records the difference on DF-0001 as tracked item DSE-T7 <!-- tracked: CMT-2171 -->.
17. **The UX impact lint's dead path is corrected** from `src/dashboard/` to `dashboard/`. That lint applies only to commits by the literal author `jkheadley` and is not in the merge floor, so wording in messages and notices written by agents has no merge gate today. This spec says so plainly and tracks the decision as DSE-T6 <!-- tracked: CMT-2170 -->.

### Not cheap to change later

The `design` field on the verify record; the fields `name`, `tone` and `rolledOver` on each limit in `/mobile/accounts`; the routes `POST /design-feedback/cards`, `GET /design-feedback`, `POST /local-verify/design-review`, `POST /local-verify/design-waiver` and `POST /design/waiver-cards`; the vendored folder `design-gate/` and the tag `shipped/<family>/<build>` in the apps repository; the awareness `requires: developmentAgent` value.

## Open questions

*(none)*

## Proposed design

### 1. The gate's files and who may change them

| File | Purpose |
|---|---|
| `scripts/design/parse-standard.mjs` | The one parser for `docs/DESIGN-STANDARD.md`. |
| `scripts/design/ui-surface.mjs` | `classifyUiPath(repoKind, path)`: pure, unit-tested on both sides of every boundary. |
| `scripts/design/gate.mjs` | The checker and the decision table (section 3). |
| `scripts/design/modes.mjs` | `DESIGN_GATE_MODES`: one row per check and per structural refusal, `report` or `block`. |
| `scripts/design/lint.mjs` | The standard and entry lint (section 5). |
| `docs/design/screens.json` | The screen registry. |
| `docs/design/coverage.json` | One row per rule per surface: what checks it, or `staged` with a tracked card. |
| `tests/design/harness/**`, `tests/design/seeds/**`, `tests/design/fonts/**` | The renderer harness, the seeded inputs and the bundled fonts. |

**Trust boundary.** All of these join `HARNESS_GLOBS`, and `playwright-core` and `axe-core` join `TOOLCHAIN_PACKAGES`. Two consequences follow from code that exists today: a change to any of them is harness-changing and needs the independent-review trace, and a renderer version bump is treated the same way. On top of that, **the verifier runs the base commit's copy** of the parser, classifier, gate, modes, coverage map and harness, checked out from the merge base into a temporary directory. A change cannot declassify its own paths, soften its own modes or weaken its own check. The registry and the seeds are read at both base and head: a path is UI if either says so, and a screen present at either is in scope. When a change edits the gate, the head's copy is also run and its result is recorded for the independent reviewer; it decides nothing.

**The classifier.** A path in the instar repository is `ui` when it is under `dashboard/**` or `dashboard-pair/**` (not tests, not `dashboard/docs/**`), or when a registered screen lists it as a source. The rules for the four native families (Swift files importing SwiftUI, AppKit or UIKit; Kotlin files with `@Composable`; `.xaml` and `.axaml` files; asset and string folders) live in the vendored copy each family carries. A unit test walks the instar tree and fails with `ui-path-unclassified` for any `.html` or `.css` file outside the declared roots that is not on a written allow-list.

**The screen registry.** Each screen has an id, a title, its main question (`DS-DELIGHT-1`), the surfaces that show it, how to open it, its seed, and its source files. Sources may name server files: the accounts screen lists `src/server/mobileCapacityRoutes.ts` and `dashboard/console/accounts-model.js`, which is how the cause of DF-0001's third problem, a sort in a server file, counts as a UI change. Web screens are seeded from the console route table. A screen with no seed yet has `status: "uncaptured"` and must cite a tracked card; the lint enforces the citation. Native screens are rows in each family's own vendored registry, so adding a native screen never waits for an instar release.

### 2. How a screen is rendered

**Pinned renderer.** The harness drives the Chromium build that the locked `playwright-core` version pins, with the fonts in `tests/design/fonts/`, a fixed clock, animations off, a fresh temporary profile, and every network request refused except those to the harness itself. The verifier installs that build into its own directory the first time the step runs. If the build is missing and cannot be installed, the step reports `unavailable: renderer-missing`. The build's revision is written on the verify record.

**Data comes through production code.** A seed is a small file of synthetic raw inputs (pool readings, account rows, machine names). The harness mounts the real route handlers and model functions over those inputs and serves the real console files. A server change that alters what a screen shows therefore changes the render. Seeds contain invented people only: the lint refuses an email address that does not end in `@example.com`.

**Stress content is checked, not declared.** For each seed the gate reads the produced API response and verifies the `DS-DELIGHT-6` cases that can be read from data: a zero, a value at the maximum, a missing value, every optional row present on at least one item, and a name at least as long as the registry's stated longest name. The one case that stays a declaration is "the busiest realistic count", which the registry states as a number per screen.

**Sizes.** Each affected web screen is rendered at 1280 x 728, 390 x 844, 768 wide and 1440 x 900 in dark, at 1280 x 728 in light, and at 200% zoom. Named states the seed defines (empty, error, loading) are rendered as further captures.

**Where captures go.** Into the verifier's artifact store, outside git, named by content hash. The verify record carries the manifest: for each screen and size the hash and byte size, and for each rule the measurement. The session, the reviewer and the owner read captures through an authenticated route on the agent's server (`GET /local-verify/design/<pr>/captures/<hash>`), or the private viewer. The pull request body gets the manifest's text only.

### 3. The design step and the one decision table

**When it runs.** After the three lanes pass, and only when the base's classifier says the change touches a `ui` path, a registered source, the standard, or a gate file. A change that touches none of these never starts a browser. This bounds the cost to UI changes and means an unrelated pull request cannot be affected by the renderer.

**What it does.** For each affected screen it renders the base and the head in the same run, on the same machine, with the same renderer and the same seeds (the base's seeds; the head's only for a screen that is new, or when the seed itself changed, which is a harness change). It then:

1. **Compares the pictures.** A screen whose base and head captures are identical at every size has *no visible difference* and needs no review. Nothing is declared by the author.
2. **Runs each rule check on both.** A violation is identified by rule, screen, size, theme and the element's path and text. A violation present at the head and absent at the base is **added**. Where element paths are not stable, counts are compared instead: a higher count at the head is added.
3. **Proves each check first.** Every check has a small violating fixture. If a check does not fail on it in this run, that check reports `unavailable: control-failed` and decides nothing.
4. **Does the card part**, reading waiver cards and tracked cards in process on the agent's machine.

There is no stored baseline. The comparison is always base against head in one run, so a renderer update or a different machine cannot move a count against a recorded number.

**Cost bound.** One browser process, at most four pages at a time, a hang limit per screen and a total limit for the step, all in the Local Verify policy beside the lane limits; a screen that exceeds its limit is `unavailable: timeout`. The step's duration is recorded on every record. The leftover reaper gains the browser's process name. A shared stylesheet change renders every captured screen; that is the worst case and its measured duration is reported at the first rung.

**Review.** When any screen has a visible difference, the session starts a fresh subagent that reads the standard and the head captures and answers each applicable review rule: `pass`, `fail`, `not-applicable` with a reason, or `not-observable`. The coverage map says what each review rule needs: a still capture, a named state capture, or an interaction trace the harness produces as text (tab order, focus kept across a refresh). A rule whose evidence the harness cannot yet produce is `staged` under DSE-T8 <!-- tracked: CMT-2172 --> and the reviewer answers `not-observable`. The answers are posted with `POST /local-verify/design-review` and are bound to the hash of the head captures they were read from. A merge from main that leaves those captures identical keeps the review; any changed capture needs that screen read again.

**The decision table.** Measurements and the merge decision are separate. This table is the only place a measurement becomes a decision, and safe-merge applies it identically under both merge floors, reading the design record from the agent's own server.

| Measurement for a rule on a screen | Decision |
|---|---|
| Pass | Allow. |
| Fail, every violation already present at the base | Allow. For an earned rule, open or refresh the one tracked card for that screen and rule. |
| Fail with an added violation, check in `report` | Allow. Recorded, and counted in the maturation review. |
| Fail with an added violation, check in `block` | Refuse `design-rule`, unless waived. |
| Review answer `fail` | Refuse `design-review-fail`, unless waived. |
| Waived, by a valid waiver for this rule and these captures | Allow. Recorded on the verify record and listed in the weekly review. |
| `staged` (no check exists yet for this surface) | Allow. Listed with its tracked card. |
| `unavailable` (renderer missing, harness crash, timeout, control failed, server unreachable, step switched off, record written by an older verifier) | Allow. One degradation signal; the change joins the daily sweep's list. |

Three structural refusals sit beside the table. Each is deterministic, the author can always fix it, and each has its own row in `DESIGN_GATE_MODES`:

- `screen-unregistered`: a changed `ui` file belongs to no registered screen and no `uncaptured` listing.
- `review-missing`: a screen has a visible difference and no review is bound to its head captures.
- `fix-incomplete`: the pull request body says `Design-Feedback: DF-NNNN`, and a rule that entry cites still fails on a screen that entry lists.

**Waivers.**

- *A rule that was not earned from feedback.* The reviewer, not the author, posts `POST /local-verify/design-waiver` with the rule, the screen, the capture hash and a reason. The server opens an agent-carried card for the eventual fix. This is self-reported; every waiver is listed in the weekly review the owner can read.
- *An earned rule.* The session asks the server for a waiver card (`POST /design/waiver-cards`). The server composes the card text itself: the repository, the pull request, the capture hash, the rule ids and the reason given. The card belongs to a phone-only family (`phoneOnlyCard` is extended to it), so the console refuses a PIN approval. The gate accepts the waiver only when the card's `approvalValid` is true and `approvedBy.by.proof` is `presence`. It never reads card status or "approval not required". Editing the card or changing the captures voids the approval. On a pool machine running an older build the console would still take a PIN tap on this card; the gate rejects it because the proof is `pin`.

**Where the card part cannot run.** The card part needs the agent's server. It runs in Local Verify on the agent's machine. A unit test, a GitHub runner or a pre-push hook does only the tree part and reports the card part as unmeasurable. No new GitHub workflow and no new required context is added: the lint, the parser and the classifier tests are ordinary unit tests in the existing unit lane.

**The off switch.** `monitoring.localVerify.designStep` in the agent's config, read live, absent meaning on for a development agent. Set to `false`, every decision is `unavailable: switched-off`, which the record and `GET /local-verify` show. It lives outside the tree, so a broken step can never block the change that fixes it.

### 4. DF-0001: the server and web changes (build stage 1)

These go first because the Apple app session's fix depends on them. They do not depend on the gate.

1. **Fixed order.** `usageWindows()` returns limits in the order 5-hour, weekly, Fable weekly, by an explicit rank. The final sort by percentage is removed.
2. **A limit that has reset.** `usageWindows(q, now)` takes the clock. A limit whose reset time has passed gets `rolledOver: true` and `tone: null`, as the web already does. Its percentage is still sent, so installed apps keep drawing.
3. **The top limit is computed.** A new `topWindow(windows)` returns the highest limit that has not rolled over. It replaces `windows[0]` at lines 332, 335 and 414, so the "nearly out" notices, the account's tone, the usage line and the account sort no longer react to a limit that already reset.
4. **Three new fields per limit.** `name` (the label with its capital: "5-hour", "Weekly", "Fable weekly"), `tone` (`null` below 75, `'attn'` from 75 to 89, `'bad'` from 90) and `rolledOver`. One exported `usageTone(pct, rolledOver)` serves the limit and the account. `label` is unchanged and `schemaVersion` stays 1 because the change is additive.
5. **Same rounding on both sides.** The web's `windowRow()` computes tone from `Math.round(pct)`, the figure it displays. The literals 75 and 90 on both sides move to one shared constant file.
6. **Web tie-break.** The web's account sort gains a name tie-break after the percentage.
7. **One boundary test for both sides.** `src/data/design/usage-tone-vectors.json` holds cases as (percentage, reset state, expected tone, expected to count as top): 74, 75, 89, 89.6, 90, 100, and 100 with a reset time in the past. One test feeds them to the server's function and the web's and expects the same answers, and checks that the server's `name` equals the web's for each label.
8. **Tests that pin the old order are updated**: the unit test "usage windows: … highest first", the integration test's `windows` expectation, and the end-to-end "alive" test.

**The note to the app sessions.** Draw limits in the order received; show `name`; paint `tone` as sent; treat `rolledOver` as "no figure, no colour"; an older server sends none of the three, so fall back to `label` with a capital and the same bands. Echo's design-standards session sends it to the Apple app session and to the session that owns the Windows family when stage 1 merges, and to the Android app session after reading the three Android files. A Work Board card "DF-0001: app sessions told about the new account fields" is opened in stage 1 and closes when each family's branch reads `name`.

### 5. The design-feedback loop

**Noticing.** A wrapper chained on `telegram.onMessageLogged` (which also carries messages from the Instar app) tests each entry with `isOwnersOwnWords` and a *defined* verified owner; with no owner configured it does nothing and says so once in the log. For the owner's own words it makes one fast-tier call through the shared LLM funnel as component `design-feedback-detector`, with its own rate ceiling, never awaited, so it cannot delay or drop a message. The call sees the message (first 4,000 characters), whether it carries an image, and the three previous turns (1,000 characters each), all inside the data boundary, and is told when anything was cut. It answers `design-feedback`, `more-about` an open entry, `other` or `unknown`. Text is data: "do not open a card" inside a message changes nothing.

**No backlog store.** The verdict for each message is one row in the replicated `design-feedback` store. A message with no row has not been judged. A catch-up pass every ten minutes reads the owner's messages of the last seven days from the message log and judges those with no row, twenty per pass, with backoff on failure and a breaker that raises one degradation after five failed passes. The message log is the backlog, so nothing is lost when a machine leaves. Messages older than seven days with no row are counted as `unjudged` in the weekly review.

**The session confirms.** A `design-feedback` or `more-about` verdict is a candidate. The server hands it to the session serving that conversation, which either confirms with `POST /design-feedback/cards` or dismisses it with a reason. The owner is not involved. Dismissals are counted and a sample is read in the weekly review. An unresolved candidate is listed in `GET /design-feedback` and handed over again once a day until the weekly review lists it as missed. The session's own path is the same route: when the owner gives design feedback and no candidate arrived, it opens the card itself.

**The route trusts nothing from the caller.** `POST /design-feedback/cards` accepts only `{ conversationKey, messageId }`. The server loads that row from its own message log, requires `isOwnersOwnWords` with a defined verified owner (otherwise `no-verified-owner` or `not-owners-words`), and copies the words and attachments itself. For `more-about`, the message is added to the open card's record instead of opening a new one.

**The card** is an ordinary Work Board card in the existing format, opened by the in-process server writer with an id derived from the source message, so one message can never produce two cards. It is agent-carried and `outward: false`, so it never appears in the owner's Needs-you list. It has no `covers` and no links are written after creation. Its `need` holds the owner's words, the date and the attachments; the card store is private. Its four done items are all `agent-may-certify`:

| Item | Done when |
|---|---|
| `entry` | `docs/design-feedback/DF-NNNN-*.md` is on main, names this card and this message, and lists every problem with the rule it broke or "no rule existed" |
| `rules` | Every problem maps to a rule; each added or sharpened rule carries "Earned from: DF-NNNN"; the changelog has the row; the lint passes on main |
| `fix` | For every surface the entry lists, a change citing DF-NNNN is merged (instar) or shipped (apps) whose design record shows every cited rule passing, or `staged` with its tracked card |
| `check` | For every cited rule that already existed, the entry names what now catches it: a new check, a fixed check, a registry change, or one sentence on why none is possible |

**Closing is the server's.** A server module, `DesignFeedbackCards`, makes one pass an hour. It fetches each tree once (instar main and the apps families, from local mirrors), evaluates at most fifty open cards against them with a pure script, and for each item that holds writes the evidence itself as `system`. When all four hold it claims the card done and sends the before and after captures to the conversation the feedback came from. A card read never triggers a pass; it shows the last result and its age. On the same build, an agent's own evidence on these cards is refused `server-checked-item`. The authoritative answer is `GET /design-feedback`, recomputed each pass: if a card is found done while its status is not complete (for example, claimed on an older build), the module opens a continuation card and records why. Cards replicate unchanged to every machine because no new field or value is used.

**"Still wrong."** The owner says so in the conversation. The detector's `more-about` verdict, or the session, links it to the entry; the server opens a continuation card for the same entry, and the entry gains a new numbered round. The owner does not reopen anything by tap.

**Entry numbers** are not allocated by the server. An entry takes the next free number on main, and the lint refuses two entries with one number, so the second of two parallel pull requests renumbers when it merges main.

**The lint** (`scripts/design/lint.mjs`) is pure and tree-only. It runs as a unit test on every change and at pre-commit when the standard or an entry is staged.

1. Every rule has a well-formed, unique id, every required field, and a Check of `machine` or `review`. The "at a glance" table lists exactly the machine rules.
2. **Ids are permanent.** `docs/design/rule-ids.lock.json` lists every id ever issued; with a base, the head's lock contains the base's.
3. **Rule and entry agree both ways**, and with a base, an "Earned from" mark or a row in an entry's rules table that exists at the base still exists at the head.
4. Every numbered problem in an entry cites a rule, or says none existed and names the rule added. Every entry that changed rules has one changelog row naming exactly those rules.
5. **An earned rule is not loosened without the owner.** With a base, the lint lists every earned rule whose Rule line changed, that lost a surface, whose Check went from `machine` to `review`, that was retired, whose coverage row went from a test to `staged`, or whose mode went from `block` to `report`. For a reduction, the changelog row must cite a waiver-style card; the card part verifies it is phone-approved by the owner and names the rule and the reduction. For a changed Rule line only, a reviewer shown both wordings answers "does the new wording permit anything the old one refused?"; `no` is recorded and merges, `yes` or `unsure` is treated as a reduction.
6. **Entries are safe to publish.** An entry has Card and Source message rows and a unique number. No file other than `DF-*.md` exists under `docs/design-feedback/`. Any email address in an entry ends in `@example.com`. The session removes names and account details from the owner's quoted words and marks each removal; the unedited words stay on the card.
7. **Gate misses are closed.** An entry's "why it was not caught" line that names the gate cites the change that fixes it.
8. **The coverage map is complete.** Every machine rule has a row per surface: a test, or `staged` with a tracked card id. Every review rule has its evidence kind. Every `uncaptured` screen cites a card.

### 6. Background work

Four repeating behaviours exist. The intervals and bounds below are operating brakes held in config, set from the first measured runs; none of them decides a merge or what counts as feedback. Each is a server module behind the development-agent gate (none is a default job, so none is installed on other agents), runs on the lead only, is registered in the self-action registry with a pure decision function, and has a sustained-failure test.

| Module | Interval | Bound per pass | On failure | When it reaches a person |
|---|---|---|---|---|
| Detector catch-up | 10 minutes | 20 messages | Backoff, breaker after 5 failed passes, one degradation | Never; `unjudged` count in the weekly review |
| Card status pass | 1 hour | 50 cards, each tree fetched once | Items stay unverified, backoff, one degradation | Never; the card stays open |
| Renderer install | On demand | One attempt, then hourly backoff | `unavailable: renderer-missing`, one degradation | Never by itself |
| Daily sweep | 1 day | Every captured screen once, at main's tip | Cursor does not advance; degradation when the last success is older than two days | See below |

**The daily sweep** renders every captured screen at main's tip with the pinned renderer and stores the per-rule counts as history for the maturation review. It reports three things: violations on main that the previous sweep did not see, changes that merged as `unavailable` since the last sweep, and UI changes that reached main with no design record at all. Self-heal comes first: it opens **one** agent-carried, `outward: false` card per sweep listing all of them, and the session fixes them. Only items still open at the following weekly maturation review appear in that review, which the owner can read; nothing is pushed to him. Its first run starts from the current tip and records that it did.

### 7. The apps repository

There are no pull requests there, so the unit is the **release**: everything between a family's last shipped mark and the commit being shipped.

- **Vendored gate.** Each family carries `design-gate/`: the checker, the classifier rules for that family, a machine-readable copy of the standard, that family's own screen registry and coverage rows, and a `VERSION` file with the instar release it was taken from and a hash of the folder. A script in instar, `scripts/design/vendor.mjs`, produces the folder; a unit test proves the machine-readable standard equals the Markdown. Nothing in a release depends on an installed Instar package. A new rule reaches a family when its folder is refreshed, which the daily sweep reports when it is behind.
- **The release step.** Each release script runs the vendored gate first, **from the commit at the last shipped mark**, over the range up to the commit being shipped. The mark is the tag `shipped/<family>/<build>`, read from the remote with `ls-remote`; an unreadable remote is `unavailable`, and "no mark at all" is accepted as a first run only when the remote has none for that family, and is recorded. The tag is written after the upload succeeds.
- **What it measures today.** Shared test vectors (colour boundaries, the label table, the internal-terms list, a list with ties, the date forms), which each app's unit tests read from the vendored folder; and static scans of the range for fixed colour values outside shared components (`DS-DELIGHT-4`), internal terms and label capitals in string literals (`DS-WORDS-2`, `DS-TYPE-3`), font sizes under the floor (`DS-TYPE-2`) and missing assets (`DS-STATE-6`). An added violation of a blocking check refuses the release; the shipping session fixes it at the head. An owner tap is never the repair for a release.
- **What is staged.** Native captures and native automatic checks. Until a family's capture tool exists, every native rule that needs a render reads `staged` in that family's coverage rows and blocks nothing. Each is a tracked item with a named owner (section "Tracked next steps").
- **Evidence.** The release manifest and, once a capture tool exists, the captures are committed under `design-evidence/<family>/<build>/` in the private apps repository. They are never copied into instar. A side-by-side with the web is assembled by the reviewer from the two private sources.
- **Who builds it.** Echo's design-standards session prepares the `design-gate/` folder and the release-script change for each family on a branch named `design-gate/<family>`, and hands each to that family's session with a brief and a Work Board card: the Apple app session, the Android app session, and for Windows and Linux the session the Chief of Staff's project list names for that family. Where it names none, Echo's design-standards session applies the change to that family itself. The card closes when the family's main branch calls the gate, which the daily sweep reads.

### 8. Reaching every development session

| Change | Path |
|---|---|
| Gate files, design step, record field, routes, modules | Code in the release. The server pieces sit behind `resolveDevAgentGate`: with it off the routes answer 503 and nothing listens on the seam. The explicit config value always wins, so it is also the off switch for the detector and the cards. |
| Agent awareness | One entry, `src/data/awareness/design-standard-gate.md`, with `requires: developmentAgent`. The awareness reader learns that one new value in this build (parser, README, test). Other agents never see the text. It says: a change to an Instar screen is rendered and checked at merge; where the standard and the registry are; design feedback from the owner is a card with an entry, never only a reply; read `GET /design-feedback` for what is open. No row is added to a core table. |
| `/instar-dev` and `/build` | One step before the commit phase: if the change touches a UI path, run the design step locally (`node scripts/design/gate.mjs --local`), read the captures, start the reviewer. Delivered to installed copies by a fingerprinted, idempotent migration in `PostUpdateMigrator`, as the existing one at lines 4121 to 4126 does; customised copies are left alone. |
| Rollout order | Verifier machines are updated together before safe-merge's new reading ships, because the change alters `verifierVersion` and every open pull request re-verifies once. A record from an older verifier reads `unavailable`, never a refusal. |
| Visibility | `GET /local-verify` shows the step's switch, the renderer build, the modes table and waivers per record. `GET /design-feedback` shows candidates, open cards with their last status and its age, and the last sweep. Both are agent-scoped reads that proxy to the lead. |

## Verify the state, not its symbol

| What is claimed | Symbol read | State it stands for | Corroboration | When it cannot be measured |
|---|---|---|---|---|
| These captures show the code being merged | The design record for (pull request, head, base) | The gate rendered that head itself | Seeds run through production code; renderer build on the record | `unavailable`, by name |
| Nothing visible changed | Base and head captures are identical | The change alters no captured state of any registered screen | Same run, machine, renderer and seeds | States the seed does not render are not compared (Under-block) |
| A machine rule passes | The step's measurement | The rendered screen satisfies it at every size | The check failed on its violating fixture in the same run | `unavailable: control-failed` |
| A review rule passes | The posted review | A reader other than the author answered from the gate's captures | Bound to the capture hash; self-reported, and stated so | `not-observable` is `staged` with a card |
| The owner agreed to waive his rule | `approvalValid` and `proof: presence` on a server-composed card | The owner tapped on his phone for this change | Card text holds the capture hash and rule ids; an edit voids it | Server unreachable: unmeasurable, and the rule is not waived |
| This message is the owner's design feedback | The row in the server's own message log | The owner wrote it | `isOwnersOwnWords` with a defined owner, run by the server | No verified owner: no card |
| This feedback is fully handled | Evidence written by `system` on four items | Entry, rules, fix and check exist on main or in a shipped release | Recomputed from the trees every pass | A tree that cannot be read leaves the item unverified |

## Multi-machine posture

- **Gate files, standard, registry, coverage map, lock file:** `unified`. Git-tracked.
- **Pinned renderer:** `unified`. It is a provisioned prerequisite that every verifier installs on demand; a machine without it reports `unavailable`, and no verdict depends on which machine ran.
- **Captures in the verifier's artifact store:** `proxied-on-read`. They are operational, not memory: any machine can re-create them from the commit, the seeds and the renderer build. They are read through the route of the machine that made them. Retention is declared: the newest set per screen on main and the sets of open pull requests are kept; the rest are removed oldest first when the store passes its byte budget, a config value the Disk Steward reads.
- **Verify records, with the new `design` field:** as Local Verify has them today.
- **Detector verdict rows, the sweep cursor and the sweep's count history:** `unified`, one replicated store named `design-feedback`. Verdict rows are kept 30 days. A lost cursor restarts the sweep from the current tip and says so. There is no detector backlog and no entry-number ledger; both were removed from the design.
- **Design-feedback cards, waiver cards and tracked cards:** `unified`. Work Board records in the replicated store, in the existing format.
- **`GET /design-feedback` and the design part of `GET /local-verify`:** agent-scoped; a machine that is not the lead proxies the read to it.
- **The four modules:** run on the lead only; a takeover continues from the replicated cursor.
- **Apple captures and checks (tracked item DSE-T2):** they need Xcode, which runs only on Apple hardware; in this pool that is the Laptop. They are not part of Local Verify.
  machine-local-justification: hardware-bound-resource
- **Apps release step:** runs on whichever machine ships that family, from the vendored folder in that checkout. It reads no per-machine state.
- **Single machine:** everything works with no peer. A single machine without the renderer installs it; if it cannot, changes merge as `unavailable` and the sweep reports them.

## Decision points touched

| Decision | Kind |
|---|---|
| Is this path a user-interface file? | invariant; basis: enumerable-domain; evidence: the path rules and the registry's source lists are closed lists, read at base and head |
| Did anything visible change? | invariant; basis: enumerable-domain; evidence: base and head captures from one run are byte-identical or not |
| Is a violation added by this change? | invariant; basis: enumerable-domain; evidence: the violation's key is present at the head and absent at the base, or the head's count is higher |
| What does a measurement mean for the merge? | invariant; basis: enumerable-domain; evidence: the decision table has eight rows and every measurement falls in exactly one |
| Does a review rule pass? | judgment-candidate. Floor: every applicable review rule has an answer bound to the head captures; a `fail` refuses unless waived; `not-observable` needs a tracked card. Arbiter: a reviewer subagent that did not write the change |
| May a non-earned rule be waived for this change? | judgment-candidate. Floor: never by the author; a written reason; bound to the rule and the captures; a card for the fix; listed weekly. Arbiter: the reviewer subagent |
| May an earned rule be waived or loosened? | invariant; basis: external-constraint; evidence: the owner's recorded rule in the standard's "How this standard grows" ("A rule earned this way is not removed or loosened without the owner's agreement") reserves it to him, and in the tap code only `proof: presence` cannot be produced by the agent |
| Does a new Rule line loosen an earned rule? | judgment-candidate. Floor: any Rule-line edit to an earned rule needs a recorded verdict; `yes` or `unsure` goes to the owner. Arbiter: the reviewer subagent, shown both wordings |
| Is this owner message design feedback? | judgment-candidate. Floor: only the owner's own words with a defined owner; the only outcome is a candidate; never delays a message; an unjudged message is retried from the log. Arbiter: the detector proposes, the session in the conversation confirms |
| Is a feedback card done? | invariant; basis: enumerable-domain; evidence: four pure functions of repository trees, written by the server |
| Should a check block yet? | judgment-candidate. Floor: a mode change is a harness change with an independent review; the review sees coverage of screens, sizes, themes and machines, the negative control, and every traced false failure. Arbiter: the maturation review |
| Is a step result `unavailable`? | invariant; basis: enumerable-domain; evidence: a closed list of causes, each produced by code |

## Over-block and under-block

- **Over-block.** A new screen must come with a seed and be clean of blocking rules, because all of its violations are added. Registering a screen or editing a seed is a harness change and needs the independent review; that is deliberate friction on the files that define the gate. A check can be wrong (a contrast reading through a gradient); that is why every check starts in `report`, and why a wrong failure of a non-earned rule can be waived by the reviewer without the owner. A capture that differs by one pixel after a merge from main needs that screen read again.
- **Under-block.** An `unavailable` step lets a change merge unseen until the next daily sweep. Review answers and non-earned waivers are self-reported. A change that fixes one violation and adds another with the same key passes; counts catch most of these and nothing blocks the rest. States the seed does not render (hover, an open dialog) are not compared. A server file that affects a screen and is in no registry source list is caught only by the daily sweep. Native surfaces have static scans and vectors only until their capture tools exist. A screen marked `uncaptured` has no checks. A release built by hand outside the scripts is not seen. Feedback on a channel with no seam is caught only by the session's own path. The first release of each apps family starts from its current tip.
- **Cost.** The step adds a browser run to verifies of UI changes only, rendering base and head. The detector adds one fast call per owner message. Both are measured at each rung and reported beside the lanes.
- **What is not measured.** The headline number below measures recurrence. Nothing here measures delight, and the spec does not claim to.

## Maturation plan

- **test-agent-live:** each stage is proven on a throwaway agent and throwaway clones: a UI pull request with no review, with a review bound to older captures, with an added violation in `report` and in `block`, with a change that edits the classifier to hide itself, with a valid owner phone waiver, with a PIN tap on the same card, with the renderer removed, and with the switch off; a detector run over real past owner messages including DF-0001's and over messages that mention a screen without criticising it.
- **dev-agent-live:** then on the development agent with real UI changes and Justin's real feedback. The DF-0001 fix is the first full pass through the loop.
- **fleet:** no fleet turn-on in this version. Other agents receive the code dark and no awareness text. Opening it to users' projects is DSE-T1.
- **graduation criterion:** judged by the maturation review on real use: every piece of owner design feedback since stage 3 has a card and an entry; every closed card closed on server-written evidence; how often the owner pointed out something an existing rule already covered, each traced to a check that was then added; a weekly replay of a sample of owner messages through a stronger tier, reporting misses; dismissed candidates, sampled; waivers, each listed; merges as `unavailable`; open earned-rule cards and their age; per-rule counts on main from the sweep; the step's added verify time. Missing evidence records `incomplete`, never a pass. No minimum duration.
- **dark-window:** not applicable to the fleet. On the development agent each check's `report` period is its dark window, and each has a date by which it is promoted, changed or retired.
- **ladder:** not applicable: no flag of its own until the stage 2 change adds the design-standard-gate entry, gated by developmentAgent, and points this line at it
- **Owner:** Echo.

The north-star measure: **how often the owner points out something a rule already covered.** That number going to zero is what "we no longer make those mistakes" means.

## Build stages with live proof

1. **DF-0001 server and web** (section 4). Proof: the tests named there; the shared boundary test failing when either side's threshold or rounding is changed; a live read of `/mobile/accounts` on a throwaway agent showing fixed order, `name`, `tone`, and a reset limit with no tone that is not the top; an older app build still drawing its list.
2. **The gate** (sections 1 to 3): parser, classifier, registry, coverage map, modes, lint, harness with the pinned renderer, the accounts screen's seed, the design step, the review and waiver routes, the off switch, the `HARNESS_GLOBS` additions. Proof on a throwaway repository with the local floor on: each case in the test-agent list gives its named result; a non-UI pull request never starts a browser; the green-PR watcher applies the same table; DF-0001 and the current standard pass the lint unchanged.
3. **The feedback loop** (section 5): detector, candidates, card module, status pass, routes, awareness value, skill steps. Proof through real Telegram and an app conversation on a throwaway agent: a design remark with a screenshot produces one candidate and, once confirmed, exactly one card; the same message again produces none; a forwarded message and a team member's message produce none; with no owner configured nothing opens; a session cannot supply words through the route; the card closes only when the four items verify; "still wrong" opens a continuation. Slack is proven the same way, or DSE-T9 <!-- tracked: CMT-2173 --> is opened with what was found. DF-0001 gets its card.
4. **The daily sweep** (section 6). Proof: a violation pushed to main around the step appears on the next sweep's single card; a failed sweep does not advance its cursor.
5. **Apps repository** (section 7): the vendored folder, vectors, static scans and the release step, per family. Proof per family: a release over a range that adds a blocking violation stops; a clean range ships and writes its mark after upload; a family whose folder is behind is reported.
6. **Constitution**, both books, last. Nothing in this run comes after it.

Each stage ships unit, integration and end-to-end tests under the Testing Integrity Standard, with both sides of every decision row above, and wiring checks for the detector, the card module and the record field. The run's completion condition is stages 1 to 6 merged and every item under "Tracked next steps" existing as an open Work Board card with its named owner.

## Tracked next steps

Each item below is opened as a Work Board card under the design standards project when this spec is approved. The lint requires every `staged` coverage row and every `uncaptured` screen to cite one of them, so none can sit unowned.

> **CMT-2165** — "DSE-T1: Offer the design gate to users' own projects: the checker, lint, capture step and detector read the standard path, the registry path and the evidence location from one project file, and turn on only by the explicit flag `resolveDevAgentGate` already honours." Owner: Echo's design-standards session.
>
> **CMT-2166** — "DSE-T2: Apple capture tool and automatic checks: a design-audit test in `InstarAppUITests` that launches each registered screen with seeded data at the standard sizes, reads frames and names from the accessibility tree, and writes captures into the private apps repository." Owner: the Apple app session. Runs on the Laptop under the one-build lock.
>
> **CMT-2167** — "DSE-T3: Android capture tool and automatic checks with Compose UI tests at the standard sizes and font scale 1.3." Owner: the Android app session.
>
> **CMT-2168** — "DSE-T4: Windows and Linux capture tools and automatic checks. Each begins as its own spec through spec-converge." Owner: the session the Chief of Staff's project list names for each family; Echo's design-standards session carries either one for which none is named.
>
> **CMT-2169** — "DSE-T5: Seeds and harness support for the dashboard pages that are not console routes, and the pairing page." Owner: Echo's design-standards session.
>
> **CMT-2170** — "DSE-T6: Decide the merge gate for wording in messages and notices written by agents: widen the UX impact lint beyond its one author and move it into the floor, or bring notices under the design gate." Owner: Echo's design-standards session.
>
> **CMT-2171** — "DSE-T7: Decide whether accounts needing sign-in sort first on every surface; the server does this and the web does not." Owner: Echo's design-standards session, recorded on DF-0001.
>
> **CMT-2172** — "DSE-T8: Interaction traces the harness does not yet produce, for the review rules that need them." Owner: Echo's design-standards session.
>
> **CMT-2173** — "DSE-T9: Design-feedback detection for owner messages that arrive through Slack, if stage 3 does not prove it." Owner: Echo's design-standards session.

## Rollback

The fast rollback is the runtime switch `monitoring.localVerify.designStep: false` in the agent's config: no pull request is needed, so a broken step cannot block its own removal. The detector and the cards are turned off by their dev-agent gate value in the same config; open cards stay on the board. Setting rows of `DESIGN_GATE_MODES` back to `report` is the slower, reviewed path. Stage 1's fields are additive and are not rolled back with the gate. The gate files are inert without the step, and because the step is not a lane, removing it leaves no unlaned test files. In the apps repository the rollback is removing the gate call from a release script, which the daily sweep reports.

## Out of scope

- Other agents' own projects, tracked as DSE-T1.
- The public website (`site/`), and the wording of messages and notices, tracked as DSE-T6.
- Deciding what good design is. That is `docs/DESIGN-STANDARD.md`; this spec only makes it apply.
- Golden-image visual regression. The gate compares a change only with its own base.
- The native side of the DF-0001 fix, which the Apple app session is building.
- A GitHub plan change or a continuous-integration service for the apps repository.
- Rewriting the legacy dashboard's existing floors and jsdom tests. The coverage map points at them.

## Left behind

Precision findings from round 1 that this revision did not settle in passing. None changes the design.

- Which existing server-to-session path hands a candidate to the session in a conversation; named at build and proven in stage 3.
- The exact default values of the detector's rate ceiling, the per-screen hang limit, the step's total limit and the artifact store's byte budget; each is a config value set from the first measured runs.
- Whether two remarks a few minutes apart are better joined by the detector or by the session; both paths exist, and the weekly review reads the result.
- The standard does not state the 1 px tolerance used for `DS-DATA-2` or the 0.2 gap used for `DS-LAYOUT-3`; the coverage map records them as the check's tolerance, not as the rule.
- Expected size of an apps release range after a long gap between releases; the static scans need no browser, and the duration is measured at stage 5.
- A cap on the length of dismissal reasons and of the card title's first words.

## Constitution wording

Two pull requests, opened by Echo's design-standards session, each naming the other on a `Constitution counterpart:` line so `scripts/check-constitution-pairing.mjs` passes. The registry is code-owned, so that pull request needs Justin's review on GitHub. Whether the `instar-2` pull request needs it too is read live by safe-merge (`refused:approval-required`), not assumed.

**Second book** (`JKHeadley/instar-2`, `docs/01-the-rules.md`, a new row in "Needs building"; the two headings' totals change from 123 to 124):

> | 124 | Design Mistakes Become Rules | Every design mistake the owner points out is diagnosed in writing and becomes a rule in the Design Standard or sharpens one. Every change to a screen is rendered by the gate at the standard sizes with realistic data and measured against the rules before it merges or ships. A rule the owner's feedback earned is waived or loosened only by the owner. | A design step in the merge path that renders base and head and applies one decision table; a lint tying each feedback entry to its rules; a tracked card per piece of feedback that closes on verified facts. Whether a screen is genuinely good stays the mind's (#80). |

**First book** (`docs/STANDARDS-REGISTRY.md`, under *Operator-Surface Quality*):

> ### Design Mistakes Become Rules; Screens Are Measured Against the Rules Before They Merge
> **Rule.** Every design mistake the owner points out is diagnosed in writing, naming the practice that was broken, and becomes a rule in the Design Standard or sharpens one; the feedback, the diagnosis, the rule and the fix are linked by a tracked card that closes only when the server has verified each. Every change to a screen is rendered by the gate itself, at the standard sizes, with realistic data, and measured against the applicable rules before it merges or ships. Rules that can be measured are measured by machine.
> **Fails.** A change may not add a violation of a blocking rule. A screen change with a visible difference that nobody independent has read does not merge. A check that cannot run is recorded as unavailable by name and is swept the next day; it is never recorded as a pass and never refuses a merge by itself. A rule the owner's feedback earned is waived or loosened only by the owner, by a tap on his own phone bound to that exact change. Any other rule may be waived only by a reviewer who did not write the change, with a recorded reason.
> **In practice.** `docs/DESIGN-STANDARD.md` is the one standard and its rule ids are permanent. The design step in Local Verify runs the base commit's copy of the gate, renders base and head with a pinned renderer, and applies one decision table on both merge floors. Captures stay in the agent's private store. The app release scripts run a vendored copy of the same gate. Owner design feedback becomes a Work Board card that the owner is never required to tap.
> **Earned from.** 2026-11-21: the owner compared the Mac app's accounts screen with the web dashboard's and found the Mac one clearly worse. The diagnosis found fifteen problems; for twelve no rule existed, and the rest were covered by a rule that applied to the web only. The existing quality standard already said a pull request names the screens that were loaded and at which widths, and nothing checked it.
> **Traces to the goal.** A coherent agent does not make its person point out the same kind of mistake twice, and does not ask them to look at a screen it has not looked at itself.
> **Applied through.** `scripts/design/gate.mjs`; `scripts/design/lint.mjs`; the design step of Local Verify; `DesignFeedbackCards`; `docs/specs/design-standard-enforcement.md`. **Parent principle:** *Structure beats Willpower*.

## Constitution alignment

- **Structure beats Willpower (parent).** A paragraph in a standard becomes a step in the merge path, a lint, a release-script step and a card the server closes.
- **Verify the State, Not Its Symbol.** The gate makes the pictures; nothing submitted is trusted. Each remaining symbol is declared with its unmeasurable case.
- **Signal vs. Authority; Judgment Within Floors.** Measurements are signals. The decision table holds the authority to merge. Five judgments sit inside stated floors with named arbiters. No fixed count, age or size limit decides anything.
- **Intelligent Prompts: An LLM Gate Must Not String-Match.** Whether a message is design feedback is judged by meaning.
- **No Silent Degradation to Brittle Fallback; the User Experience Is the Product.** `unavailable` is named, signalled and swept. A broken tool cannot stop delivery.
- **Close the Loop.** Feedback is a card from the moment it is confirmed; every staged piece cites a tracked card; the sweep brings back anything that went around.
- **Agent Proposes, Operator Approves; Approval Only Where Required; The Agent Carries the Loop.** The owner is asked for the constitution article and for his own earned rules. He is never asked to close a card, dismiss a wrong guess or approve a waiver of an ordinary rule.
- **Always a Multi-Machine Entity.** Every new piece of state has a posture; the one machine-local item uses a key from the closed list.
- **Self-Hosting.** Scope today is Instar's own development. The path to users' projects is a tracked item, not a sentence.
- **Updates never restrict existing agents; Migration Parity; Agent Awareness.** Nothing here holds or instructs any agent but a development agent.
- **One Constitution, Two Books Aligned.** Both wordings are above, paired.
- **Occam's Razor.** One parser, one classifier, one gate and one decision table serve the verifier, the release scripts, the sweep and the feedback card. The revision removed the committed evidence folder, the stored baseline, the fourth lane, the GitHub workflow, the repository hooks, the entry-number ledger and the detector backlog.
