---
title: "Every design mistake the owner points out becomes a rule, and every screen change shows its screens against the rules before it merges"
slug: design-standard-enforcement
author: echo
eli16-overview: docs/specs/design-standard-enforcement.eli16.md
parent-principle: "Structure beats Willpower"
tier: 2
origin: "The owner, Chief of Staff conversation, 2026-11-21 12:12 PST [source: telegram 141385/146785 2026-11-21]: 'when I point out a bad UI/UX aspect of our designs, I would like to have a standard/requirement in which you officially diagnose what went wrong (what aesthetic or UI/UX best practices were violated) and then update our required UI/UX design standards (that should be infrastructurally enforced for ALL development that we do) such that we no longer make those mistakes. The goal should be better and better results in our designs that align with our goal to delight the user.' The agent's summary of the Chief of Staff's brief the same day (a paraphrase, not the owner's words): every change touching a user interface shows screenshots at the standard sizes and a checklist against the standard before merge, checked by a gate; machine-checkable rules get automatic checks; every piece of design feedback is a tracked card with a diagnosis, a fix, a rule change and a record linking the feedback to the rule; write it as a spec and converge it before building."
lessons-engaged:
  - "Structure beats Willpower (the dashboard quality standard already says 'the PR says which screens were loaded and at which widths'; nothing checks it, and DF-0001 shipped anyway)"
  - "Verify the State, Not Its Symbol (the gate renders the tree that lands; nobody submits a picture on the instar side, and native captures are checked by their pixels, not their file names)"
  - "Signal vs. Authority and Judgment Within Floors (measurements are signals; one decision table, certified in the verify status, turns them into a merge decision)"
  - "Counts are signals, not gates (a change is compared with its own base in the same run; no stored count decides anything)"
  - "No Silent Degradation to Brittle Fallback (a step that could not run says so by name, and the pair of commits is retried by the next sweep)"
  - "Delivery and cost outrank gate strictness (a broken renderer cannot stop merges; the off switch is recorded, signalled and expires)"
  - "Close the Loop: Untracked = Abandoned (feedback is a card that closes only on verified captures; the gate's own leftovers are one standing card)"
  - "The Agent Carries the Loop; Approval Only Where Required (the owner is asked for the constitution article and for his earned rules, nothing else)"
  - "Operator handoff: verified authority (an earned-rule waiver is a phone presence tap; the dashboard PIN, which the agent can read, never counts)"
  - "Attributed Statements Trace to Their Source (the origin cites the message; the earned-rule reservation is marked as the agent's wording)"
  - "Private evidence never enters the public repository"
  - "Always a Multi-Machine Entity; Updates never restrict existing agents; Migration Parity; Agent Awareness"
---

# Every design mistake the owner points out becomes a rule, and every screen change shows its screens against the rules before it merges

## Problem statement

On 2026-11-21 the owner compared two screenshots and saw that the Mac app's accounts screen was clearly worse than the web dashboard's. The diagnosis (`docs/design-feedback/DF-0001-accounts-usage-mac-vs-web.md`) found fifteen problems. For twelve of them no rule existed anywhere. For the rest a rule existed for the web only. `docs/DESIGN-STANDARD.md` now holds 65 rules for all six surfaces, 27 of them marked machine-checkable, and a table of standard screenshot sizes. Three things are still missing, and each is structural:

1. **Nothing makes a screen change show its screens.** The standard says captures are taken at the standard sizes before anyone is asked to look. Nothing produces them or checks that anyone read them.
2. **No machine-checkable rule has a machine check that runs at merge.**
3. **The feedback loop is a paragraph.** Whether a diagnosis, a rule and a fix follow the owner's remark depends on the session that hears it remembering to do it.

This spec makes all three structural, and it carries the server and web half of the DF-0001 fix as its first build stage.

**What changed after review round 1.** The first draft had the author commit pictures and a hand-filled manifest, had a browser lane gate every merge, and made the owner the only way past any failing rule. The revision had the gate make the pictures itself, compared a change with its own base in one run, and asked the owner only about rules his own feedback earned.

**What changed after review round 2.** Round 2 found that the revision rendered and gated the wrong pair of trees, that its decision could be skipped on the Actions floor or by a raw merge, that its Work Board claims did not match the code, and that its native side measured nothing visual. This revision fixes those by removing surface rather than adding it. "Base" and "head" are now the two trees Local Verify already verifies, and the gate's code comes from the base. The decision is part of the `instar/local-verify` status, so every merge path reads the same answer, and a UI change cannot use the Actions floor at all. A head that crashes while its base renders is the change's failure. The reviewer sees base and head side by side and may answer "inherited". The gate starts the reviewer itself. The off switch is recorded, tells the owner, and expires. Cards use the server-owned mechanism the Work Board already has. The daily sweep runs inside the main verify on a machine that can render, and retries each skipped change by its commits. The detector uses only the live message seams, with no catch-up over the log. The native side drops its static scans and requires real captures and a review at each release. Shared files and pages rendered from TypeScript are now covered. Counts and citations are corrected.

## Words used here

- **Local Verify**: the verifier on the agent's own machines that runs the tests for a pull request and writes a *verify record*. The **coordinator** is the machine that dispatches the run and posts the `instar/local-verify` commit status; the run itself may execute on a peer verifier. **safe-merge** reads the status or record and merges or refuses. A *merge floor* is what safe-merge requires: `local` reads Local Verify, `actions` reads GitHub check results.
- **Base**: the verify record's `baseSha`, the tip of main that Local Verify verified against (it is refreshed to main's current head before each run, never the pull request's fork point). **Head**: the merge tree Local Verify actually tests, the merge of the pull request onto the base. The tree that lands is the head. The gate's own code, rule modes and decision table are always taken from the base.
- **Rendering verifier**: a verifier machine that has the pinned renderer installed and reports it.
- **The lead**: the one machine in the agent's pool that currently runs scheduled work.
- **Maturation review**: the existing weekly review of features still proving themselves.
- **Earned rule**: a rule in the standard marked "Earned from: DF-NNNN". Today 22 rules carry the mark (the phrase also appears twice in the standard's own explanatory text, which the parser does not count).
- **Upkeep list**: the gate's own list of things to fix (inherited earned-rule violations, screens that render inconsistently, merges the sweep could not render, handoffs to app sessions). It is rows in the `design-feedback` store, carried by one standing Work Board card.
- **Development agent**: an agent with `developmentAgent: true` in its config, today Echo.

## Ground truth from the code (branch `echo/design-standards`)

Read in this worktree, in the apps checkout, and in the second rule book through the GitHub API, on 2026-11-21.

| Existing piece | Where | State today | How this spec uses it |
|---|---|---|---|
| Design Standard | `docs/DESIGN-STANDARD.md` | 65 rules `DS-*`, each with Rule, Why, Bad, Good, Surfaces, Check (`machine` or `review`), Source or Earned from. 22 rules carry "Earned from". `DS-DATA-2` already states its 1-unit tolerance (lines 62 and 203) and `DS-LAYOUT-3` its 20% gap (line 106). No parser reads the file. | The single source. One parser reads it. Check tolerances are the rules' own text. |
| First feedback entry | `docs/design-feedback/DF-0001-…md` | Header table, the owner's words, 15 numbered problems, the fix, a table of 22 rules, a status block saying it closes when side-by-side captures pass. No images. | The format the lint enforces. |
| Repository visibility | `gh repo view` | instar is PUBLIC; the apps repository is private. | No capture and no owner screenshot is committed to instar. |
| What Local Verify verifies | `src/localVerify/LocalVerifyService.ts:1847`, `orchestrator.ts:512-538` | "Verify against the base branch's current head, never the PR's stale baseRefOid." The run fetches `baseSha` and `headSha`, runs `merge-tree --write-tree`, commits the result with `baseSha` as parent, adds one worktree and runs one `npm ci`. Policy deadlines (`policy.ts:1-8, 30-37`) are reviewed constants inside `policyHash`. A post-merge verify of main exists (`kind: 'main'`). | Base and head are these two trees. The gate adds a second, cached tree for the base. |
| Harness classifier | `src/localVerify/harnessClassifier.ts` | `HARNESS_GLOBS` and `TOOLCHAIN_PACKAGES` make a change *harness-changing*, which needs an independent-review trace. | The gate's files and its two packages join them. |
| Status projection | `src/localVerify/statusProjection.ts:115-140` | `success` needs a successful record, passing gating lanes, the independent review when flagged, and main health. No design term. The GitHub ruleset requires `instar/local-verify`. | The design decision becomes a term of this projection. |
| Floor selection | `scripts/safe-merge.mjs:556-571` | The Actions floor is chosen by `INSTAR_MERGE_FLOOR=actions`, by no agent config, by another repository, or by the server's `effective: 'actions'`. The Actions floor never contacts the server. On the local floor an unreachable server refuses. | A UI change is refused on the Actions floor. |
| Green-PR watcher | `src/monitoring/GreenPrAutoMerger.ts` | Handles each refusal class explicitly; `needs-independent-review` waits for a new head. | Gains classes for the design results (section 3). |
| Leftover reaper | `src/localVerify/leftoverReaper.ts:9-42` | Owns orphaned processes by a run-folder prefix in their command line, never by process name. | The browser and its profile live under the run folder. |
| Disk Steward | `src/monitoring/DiskSteward.ts:10-11` | Deletes only from a fixed list of tool caches, never widened. | It does not delete captures. The capture store prunes itself. |
| Work Board cards | `src/core/WorkCardStore.ts`, `src/core/WorkBoardService.ts` | `certify` is exactly `owner-confirms` or `agent-may-certify`. `links` is material. `covers` accepts `plan:` and `pr:` from any writer, and `cos:waiting:` only from the in-process server writer (`SERVER_COVERABLE_PREFIXES`). A card covering any `cos:` key is server-owned (`isServerOwnedCard`): only the server writer writes its records, other writers get `server-owned-card`, a person's taps still work. Only the server writer may choose a deterministic record key (`serverKey`). The server writer is `{kind:'agent', server:true}` and is stored as `{kind:'agent'}`; a `system` writer is refused on created, edited, evidence and claimed-done records. Under the live policy `every-agent-card` an agent-written card is `needs-approval`, in the owner's waiting lane, until he taps Approve, and no done claim counts before that. A card the owner carries needs no approval, and when it is server-owned it can be closed on the server's own evidence; that is how the Chief of Staff wait cards work (`ChiefOfStaffWaitCards.ts:348`). The server writer opens no more cards once the owner's waiting lane holds `softOpenCards` (30). | Feedback cards, waiver cards and the upkeep card use exactly these mechanisms (section 5). |
| Owner-request approval | Pull request 3596, agent work cards slice 1, **open, not merged** | Adds `requestApproved`: a card the server writer creates from the owner's sender-verified message, with `need` locked to that message's text, carried by the agent and not outward, counts as approved under either policy. It also adds the durable-row read that verifies a message's sender per channel. | The design-feedback card is built on it (stage 3 follows its merge). |
| Owner taps | `src/server/workBoardRoutes.ts`, `src/server/routes.ts` | The console tap records `proof: 'pin'`, and the code says "the PIN is available to the agent". The phone tap records `proof: 'presence'`. `phoneOnlyCard` refuses a PIN approval for one family of cards. | An earned-rule waiver is a phone presence tap. |
| Owner-message seams | `src/commands/server.ts`, `src/core/ownerWords.ts`, `src/core/AppConversationStore.ts:497`, `src/messaging/slack/SlackAdapter.ts:290` | Features chain wrappers on `telegram.onMessageLogged`. Native app conversations have their own seam, `AppConversationStore.addAppendListener`, which fires for local and replicated events. `isOwnersOwnWords` passes `senderRole: 'owner'`, passes `via: 'mobile-device'` whatever the owner id, and passes any verified Telegram sender when no owner id is set. Slack has its own `onMessageLogged`. | The detector listens on the Telegram and app seams; Slack is proven or tracked. |
| Config writes | `src/core/TrustRaiseGuard.ts` | `PATCH /config` checks only external-operation and evolution settings for widening, and a session can also write its config file directly. | The off switch cannot be prevented, so it is recorded where it is read (section 3). |
| Account usage, server | `src/server/mobileCapacityRoutes.ts` | `usageWindows()` ends with a sort by percentage (line 228). The top limit is `windows[0]` at lines 332, 335 and 414. Tone uses the rounded percentage. A limit past its reset keeps its percentage; only `resetsAt` is cleared (line 427). `usageLine` is built from the top limit (line 428). | Changed in stage 1. |
| Account usage, web | `dashboard/console/accounts-model.js` | `windowRow()` tone uses the unrounded percentage (line 112), and so does the account row's tone (line 256). A reset limit is `rolledOver` and is left out of the tightest limit. Accounts sort with no name tie-break. | Changed in stage 1. |
| Apps that read the accounts list | apps checkout | iPhone and Mac draw `windows` in the order received and sort for the headline themselves (`CapacityViews.swift:390`, `MacOpsScreens.swift:926`, `CapacityData.swift:123`). Windows sorts its own headline (`CapacityPagesData.cs:289`, `ByUse`). Android's only reader (`WordsScreens.kt:60`) reads `name`, `email`, `kind` and `usageLine`, never `windows`. Linux has no reader. | Removing the server's sort is safe for every installed app. |
| Native apps repository | private apps repository | Branch families `apple/*`, `android/*`, `windows/*`, `linux/main`. No workflows, hooks, tags or pull requests. Releases are scripts; Apple ships iPhone (`ship.sh`) and Mac (`ship-mac.sh`, `publish-mac-feed.sh`) separately. | The unit of change there is a release of one product. |
| Pages outside the console | `dashboard/docs/` (the Documents page), `src/publishing/PrivateViewer.ts`, `src/server/SecretDrop.ts`, `src/recovery/RecoveryPhonePage.ts`, `src/server/documentPageRoutes.ts`, and the legacy dashboard pages | Owner-facing pages. Some are HTML produced inside TypeScript. | Registered as screens marked `uncaptured` (section 1). |
| Awareness entries | `src/data/awareness/README.md` | An entry can vary only by `requires: telegram`. | One new value, `developmentAgent`. |
| Skill updates | `src/core/PostUpdateMigrator.ts:4121-4126` | A fingerprinted, idempotent migration patches the installed `instar-dev` and `build` skills. | The same pattern delivers the new skill note. |
| Constitution | `docs/STANDARDS-REGISTRY.md` (code-owned by the owner); `JKHeadley/instar-2` `docs/01-the-rules.md` | The second book has 123 rules, a summary table ("Needs building 79", "Total 123") and four headings reading "of 123". Each new rule carries a "Value" paragraph and an approval line with its source. | One article and one rule row, paired. |

## Threat model

The agent is cooperating but forgetful, and under time pressure it takes the shortest path. The shortcuts designed against:

- **A picture from another version, or of tidy data.** On the instar side nobody submits pictures: the gate renders the base and the head itself, with seeded data passed through production code. On the native side the release checker reads each capture's pixel size and hash and binds the review to them.
- **Changing the gate in the change being gated.** The gate's code, modes, lint and decision table come from the base, and its files are harness files.
- **Skipping the decision.** The decision is a term of the `instar/local-verify` status that GitHub requires, so a standby's safe-merge, the watcher and a raw merge all read the same answer. The Actions floor refuses UI changes.
- **A waiver the agent grants itself on the owner's rules.** Waiving an earned rule needs the owner's presence tap on his phone. The off switch is the agent's, so it is recorded, it tells the owner, it expires within a day, and while it is on, a change touching a screen with an earned-rule violation still needs the owner's card.
- **Feedback attributed to the owner that he did not give.** The server reads the message itself and checks its sender.
- **A check that passes because it could not run.** That result has its own name, `unavailable`, and the sweep retries it.

Not prevented: an admin merge that bypasses the ruleset, or an app build uploaded by hand. The sweep finds the first the next day (a UI commit on main with no measured design result).

## Frontloaded Decisions

### Yours to decide

1. **Scope is Instar's own development, now.** The gate and the feedback loop run on the development agent, for instar and the apps. *Recommended*: holding other agents' projects through an update would restrict them. Offering it to users is DSE-T1 <!-- tracked: CMT-2165 -->.
2. **Who can let a change through with a rule failing.** For a rule your feedback earned: only you, by a Face ID tap on your phone, for that exact change. For any other rule: a reviewer that did not write the change, with a written reason, listed in the weekly review. *Recommended*. Alternative: you approve every waiver.
3. **You are never asked to approve or close a design-feedback card.** The card is approved by your own message, the way the agent-work-cards change (pull request 3596, not yet merged) makes your own requests count as approval; the feedback loop is built after that change merges, so no card waits on you in between. The card closes when the server has verified the entry, the rules, the fix on every surface, and the new check. You are shown the before and after pictures where you raised it. "Still wrong" in the same conversation continues the entry. *Recommended*. Alternative: a confirming tap on every card.
4. **Loosening an earned rule needs you.** Removing a surface from it, changing its check from machine to review, retiring it, or turning its check from blocking back to reporting needs your phone tap. Adding and tightening rules is the agent's. The standard's sentence saying so ("How this standard grows", step 3) was written by the agent; your approval of this decision is what makes it your rule, and the approval message will be cited there. *Recommended*.
5. **One constitution article, in both books.** Approving this spec approves both wordings. The standards registry is code-owned by you, so its pull request needs your approval on GitHub, which opens from a link on your phone.

### Decided by the agent; say if you disagree

6. **The gate makes the pictures; nothing visual is committed to instar.** Captures live in the capture store on the verifier, outside git and outside backups, because they can be re-rendered from the commits.
7. **A tool failure never refuses a merge.** A missing renderer, a crashed harness that also fails on the base, a timeout, an unreachable capture, or an older verifier records `unavailable` and the pair of commits joins the next sweep. A head that fails where the base rendered is not a tool failure (decision 9). Cost: a change can merge unseen for up to a day.
8. **A change may not add violations; it need not clear old ones.** The exception is a change that says it fixes a feedback entry: that entry's cited rules must pass on the screens it names.
9. **Day one.** From the day the step lands, these refuse: a UI change on the Actions floor, a changed UI file that no screen lists or loads, a visible difference with no review bound to it, a head that fails to render where the base rendered, a change that weakens the standard, and a feedback fix that leaves its rule failing. Every rule check starts in `report`. Pull requests already open are gated on their next verify, because the base is main's current tip.
10. **Promotion to blocking is a judgment** of the maturation review, on evidence: screens, sizes, themes and verifier machines covered, the negative control, every false failure traced. Each check's row carries a date by which it is promoted, changed or retired.
11. **Renderer.** `playwright-core` with the Chromium build the base's lockfile pins, fonts bundled with the harness, installed by each rendering verifier into a run-owned directory. `axe-core` for contrast, names and target size.
12. **The gate starts the reviewer.** A fresh one-shot session started by the coordinator reads the paired base and head evidence for one screen at a time. The server accepts answers only from the session it started for that evidence. Its model is recorded.
13. **Design feedback is noticed by one fast model call per owner message** on the live seams. The result is only a candidate; the session in that conversation confirms it.
14. **Apps: the release of one product is the unit.** Each release script runs a vendored checker that requires, for every changed registered screen, captures at the standard sizes and an independent reviewer's answers in the private apps repository. Until a family's capture tool exists, captures come from the app's own debug capture mode, as the Apple app session already does for DF-0001. Native automatic checks stay tracked items.
15. **`docs/DESIGN-STANDARD.md` is not code-owned.** Decision 4 and the base-copy lint protect earned rules instead.
16. **DF-0001 stage, three points beyond the brief.** (a) Both sides colour a limit and an account from the rounded percentage that is displayed, so 89.6% shows "90%" in red everywhere. (b) The server adopts the web's handling of a limit that has already reset. (c) The server lists accounts needing sign-in first and the web does not; stage 1 adds the name tie-break only and records the difference on DF-0001 as DSE-T7 <!-- tracked: CMT-2171 -->.
17. **The UX impact lint's dead path is corrected** from `src/dashboard/` to `dashboard/` in the lint. Its workflow's own `paths:` filter has the same dead path and is a protected file, so that change, and whether wording in agent-written messages gets a merge gate at all, is DSE-T6 <!-- tracked: CMT-2170 -->.

### Not cheap to change later

The `design` field on the verify record and its term in the status projection; the fields `name`, `tone` and `rolledOver` on each limit in `/mobile/accounts`; the routes `POST /design-feedback/cards`, `GET /design-feedback`, `POST /local-verify/design-review`, `POST /local-verify/design-waiver` and `GET /local-verify/design/<pr>/captures/<hash>`; the covers prefixes `cos:design-feedback:`, `cos:design-waiver:` and `cos:design-upkeep:`; the replicated kind `design-feedback`; the vendored folder `design-gate/` and the tag `shipped/<product>/<build>` in the apps repository; the awareness value `requires: developmentAgent`.

## Open questions

*(none)*

## Proposed design

### 1. The gate's files and who may change them

| File | Purpose |
|---|---|
| `scripts/design/parse-standard.mjs` | The one parser for `docs/DESIGN-STANDARD.md`. |
| `scripts/design/ui-surface.mjs` | `classifyUiPath(repoKind, path)`: pure, tested on both sides of every boundary. |
| `scripts/design/gate.mjs` | The checker and the decision table (section 3). |
| `scripts/design/modes.mjs` | `DESIGN_GATE_MODES`: one row per check and per structural refusal, `report` or `block`. |
| `scripts/design/lint.mjs` | The standard and entry lint (section 5). |
| `docs/design/screens.json` | The screen registry. |
| `docs/design/coverage.json` | One row per rule per surface: what checks it, or `staged` with a tracked card. |
| `tests/design/harness/**`, `tests/design/seeds/**`, `tests/design/fonts/**` | The renderer harness, the seeded inputs and the fonts. |

**Trust boundary.** All of these join `HARNESS_GLOBS`, and `playwright-core` and `axe-core` join `TOOLCHAIN_PACKAGES`, so a change to any of them needs the independent-review trace. The design step runs every one of them, the lint included, **from the base**. The changed paths are still computed from the merge base to the pull request head, as Local Verify does today, and a path is UI if the base's classifier says so or a registered screen at base or head lists it. When a change edits the gate, the head's copy is also run and its result is shown to the independent reviewer; it decides nothing. If the base has no gate yet (only before stage 2 merges), the step does not apply.

**The classifier.** A path in instar is `ui` when it is under `dashboard/**` (including `dashboard/docs/**`, the Documents page) or `dashboard-pair/**` and is not a test, or when a registered screen lists it. A unit test walks the tree and fails with `ui-path-unclassified` for any `.html` or `.css` file, and any source file that emits a whole HTML document, that is outside these roots and not on a written allow-list. The native families' rules (SwiftUI, AppKit or UIKit imports; `@Composable`; `.xaml` and `.axaml`; asset and string folders) live in each family's vendored copy.

**The screen registry.** Each screen has an id, a title, its main question (`DS-DELIGHT-1`), its surfaces, how to open it, its seed, and its source files. Sources may name server files: the accounts screen lists `src/server/mobileCapacityRoutes.ts` and `dashboard/console/accounts-model.js`. A source may be marked `shared` (stylesheets, shared components, fonts, helpers): a change to it renders every captured screen that loaded it in the base render, which the harness records from its own request log. A screen with no seed yet is `status: "uncaptured"` and cites a tracked card. Stage 2 registers every console route, the legacy dashboard pages, the pairing page, the Documents page and the pages rendered from TypeScript (`PrivateViewer`, `SecretDrop`, `RecoveryPhonePage`, `documentPageRoutes`); only the accounts screen is seeded at first, and the rest are `uncaptured` under DSE-T5 <!-- tracked: CMT-2169 -->, which also carries seeding the remaining console routes, in order of use and feedback history, with the number of captured screens reported at each maturation review.

### 2. How a screen is rendered

**Pinned renderer.** The harness drives the Chromium build that the base's locked `playwright-core` pins, with the bundled fonts, a fixed clock, animations off, a fresh profile, and every network request refused except those to the harness. A rendering verifier installs that build on demand into a directory under its run folder, keeps the current and previous builds and removes older ones, and reports its build in the peer status read. If the build is missing and cannot be installed, the step is `unavailable: renderer-missing`.

**Data comes through production code.** A seed is a small file of synthetic raw inputs. The harness mounts the real route handlers and model functions over those inputs, with a throwaway state directory and home, no agent token in its environment, and no reads of the host's pool, config or machine name. Seeds contain invented people only: the lint refuses an email address that does not end in `@example.com`.

**Stress content is checked, not declared.** For each seed the gate reads the produced API response and verifies the `DS-DELIGHT-6` cases that data can show: a zero, a value at the maximum, a missing value, every optional row present on at least one item, and a name at least as long as the registry's longest name. The busiest realistic count is the one case the registry declares.

**Sizes.** Each affected web screen is rendered at 1280 x 728, 390 x 844, 768 x 1024 and 1440 x 900 in dark, at 1280 x 728 in light, and at 200% zoom of 1280 x 728, plus the named states the seed defines (empty, error, loading). The harness also writes an interaction trace as text: tab order and whether focus survives a refresh.

**Twice, for determinism.** Every screen is rendered twice on each side. If the two renders of one side differ, that screen is `unavailable: nondeterministic`, which allows, and the screen goes on the upkeep list to be made deterministic. It is never read as "no visible difference".

**The base tree and its cache.** The head is the run's own merge tree. The base is a second worktree of `baseSha` from the verifier's clone; it reuses the run's installed dependencies when the lockfile is unchanged and installs its own otherwise, then builds. Base captures, base violation keys, base traces and base load lists are cached per (`baseSha`, renderer build) on that verifier and shared by every pull request verified against that tip there. Cost bound: at most one base build and one base render per screen per main tip per rendering verifier; each pull request adds only the head renders of its affected screens. A base that cannot be built is `unavailable: base-unbuilt`.

**The capture store** is a new piece: `.instar/local-verify/design-captures/` on each verifier, named by content hash. It keeps the base cache for main's last three tips and the newest set of each open pull request. It has a byte budget (default 4 GB, set from the stage 2 measurement) and prunes oldest first when it writes, deleting through `SafeFsExecutor`. `GET /local-verify` reports its size. It is excluded from backups. Captures are read through `GET /local-verify/design/<pr>/captures/<hash>` (the pull request an integer, the hash checked against a fixed hex pattern before any file access), proxied over the mesh-authenticated read to the machine named on the record. The pull request body carries rule ids, screen ids, hashes and counts only, never element text.

### 3. The design step and the one decision table

**When it runs.** After the three lanes pass, and only when the base's classifier says the change touches a `ui` path, a registered source, the standard, or a gate file. Other changes never start a browser.

**What it does.** For each affected screen it renders the base (or reads the cache) and the head, with the base's seeds, harness and renderer (the head's seed only for a screen that is new), then:

1. **Compares the evidence.** A screen whose captures and interaction trace are identical on both sides has *no visible difference* and needs no review.
2. **Runs each rule check on both sides.** A violation is keyed by rule, screen, size, theme and element path (text only as a tie-break). Present at the head and absent at the base is **added**. Where paths are not stable, a higher count at the head is added.
3. **Proves each check first.** Every check has a violating fixture. A check that does not fail on it is `unavailable: control-failed`.
4. **Treats a head failure as the change's.** If the base rendered a screen and the head crashes, hangs past the per-screen limit, or fails to mount, the result is `render-failed`, a measured failure. Only when the base or the controls also fail is it `unavailable: harness-failed`.

**Time limits** live in the Local Verify policy, inside `policyHash`, as reviewed constants like the lane deadlines: at most four pages at a time, 60 seconds per screen render, 20 minutes for the whole step. Stage 2 measures the worst case (a change to a shared stylesheet, every captured screen) on the slowest rendering verifier and, if twice that exceeds 20 minutes, raises the total by a reviewed policy change. Screens finished when the total runs out are decided; only the rest are `unavailable: timeout`. The step's duration is on every record.

**Review.** For each screen with a visible difference, the coordinator starts one fresh reviewer session through the server's one-shot session path, at most two at a time. The reviewer gets that screen's paired base and head captures, traces and the wording of every applicable review rule, and answers each rule: `pass`, `fail` (present at the head and not at the base), `inherited` (present at the base too), `not-applicable` with a reason, or `not-observable`. A reviewer told its input was cut answers `not-observable`, never `pass`. A rule whose evidence the harness cannot produce yet is `staged` under DSE-T8 <!-- tracked: CMT-2172 -->. The answers are posted with `POST /local-verify/design-review`; the server accepts them only from the session it started for that evidence and records that session's id and model. Answers are bound to one hash over the base and head captures, both traces, and the wording of each answered rule. A change to any of those (a merge from main that moves the base, a new head, an edited rule) re-triggers review of that screen automatically. If the reviewer fails twice, that screen is `unavailable: reviewer-failed`. The `/instar-dev` and `/build` skills may run the step locally first as an early look; that result decides nothing.

**The decision table.** The verifier evaluates it once, from the base's copy of `gate.mjs` and `modes.mjs`, and writes the decision, the modes hash and every measurement into the record's `design` field. The status projection reads that recorded decision: a refusal posts `failure` with the reason, a review in progress or an open owner waiver posts `pending`, anything else lets the existing terms decide. safe-merge, the green-PR watcher and GitHub's ruleset all read that status, so no merge path can skip it.

| Measurement for a rule on a screen | Decision |
|---|---|
| Pass | Allow. |
| Fail, every violation already at the base, or review answer `inherited` | Allow. An earned rule's violation goes on the upkeep list. |
| Fail with an added violation, check in `report` | Allow. Recorded, and counted in the maturation review. |
| Fail with an added violation, check in `block`, or review answer `fail` | Refuse `design-rule` or `design-review-fail`, unless waived. |
| Waived by a valid waiver for this rule and this evidence | Allow. Listed in the weekly review. |
| `staged` | Allow. Listed with its tracked card. |
| `unavailable` (renderer missing, base unbuilt, harness failed on both sides, nondeterministic, timeout, control failed, reviewer failed, captures unreachable, older verifier, switched off) | Allow, except while switched off as below. One degradation, keyed by cause and renderer build so one broken renderer is one report; the pair of commits is retried by the next sweep. |

Structural results sit beside the table. Each is deterministic, the author can always fix it, and each has its own row in `DESIGN_GATE_MODES`, all at `block` from day one:

- `screen-unregistered`: a changed `ui` file that no screen lists, that is not `shared`, and that no captured screen loaded in the base render.
- `review-missing`: a visible difference with no review bound to its current evidence. This is `pending` while the gate's reviewer runs.
- `render-failed`: the head failed where the base rendered.
- `standard-weakened`: the base's lint, run over base and head, finds a removed rule id, a removed "Earned from" mark, or an earned rule loosened (section 5, lint item 5) without the owner's phone-approved card. If that card cannot be read, this refuses rather than allows.
- `fix-incomplete`: the body says `Design-Feedback: DF-NNNN` and a rule that entry cites still fails, added or inherited, on a screen the entry lists. An optional `(screens: …)` after the entry number limits the check to the screens this change fixes; the feedback card still needs all of them.

**The Actions floor.** On the Actions floor safe-merge runs the classifier from main's current tip over the pull request's changed paths. A UI change is refused with `design-needs-local-floor` and a plain reason ("this change touches a screen, and screens are checked only by Local Verify; it will merge when Local Verify is back"). No server read is added to that path.

**The watcher.** `review-missing` and an open owner waiver are waits: the watcher re-reads them when a review or waiver is posted or every 15 minutes, and spends no attempt. `design-rule`, `design-review-fail`, `render-failed`, `screen-unregistered`, `standard-weakened` and `fix-incomplete` are terminal for that head. `GET /green-pr-automerge` shows them.

**Waivers.**

- *A rule that was not earned.* The reviewer posts `POST /local-verify/design-waiver` with the rule, the screen, the evidence hash and a reason of at most 500 characters. The fix goes on the upkeep list. Self-reported, and every waiver is in the weekly review.
- *An earned rule.* The server opens a waiver card itself. It is carried by the owner and covers `cos:design-waiver:<repo>:<pr>:<evidence hash>`, so it is server-owned, and `phoneOnlyCard` is extended to it, so the console refuses a PIN approval. The server writes the text: the pull request, the screens, each rule's wording beside the reason given, and the evidence hash. At most one open waiver card per pull request. The gate accepts the waiver only when `approvalValid` is true, `approvedBy.by.proof` is `presence`, and `approvedBy.by.personKey` is the owner's. Changing the evidence voids it, because the hash is in the card. When the waiver is used or no longer needed (the change merged or closed, or its evidence changed), the server closes the card on its own evidence, as the Chief of Staff wait cards are closed. If the owner's waiting lane is at its soft budget, no card opens and the change stays `pending` with that reason.

**The off switch.** `monitoring.localVerify.designStepOff: { until, reason }` in the coordinator's config, read live by the coordinator when a run starts and again when it posts the status, and written on the record. It is honoured only until the earlier of `until` and 24 hours after the coordinator first saw that value. Every new value seen is recorded in the `design-feedback` store (machine, time, reason, value) and raises a degradation, which reaches the owner's attention topic, saying in plain words that screen checks are off, why, and until when. While it is honoured, UI changes are `unavailable: switched-off`, except a change that touches a screen which the latest main render shows with an earned-rule violation: that change waits for the owner's waiver card as above, or for the switch to lapse and the change to be rendered normally. When it lapses the step runs again, whatever the file still says, and the record of the off period stays and is listed in the weekly review with every change merged during it. The 24 hours is one sweep cycle, so every off period is covered by the next sweep's retries. An unparseable value is treated as on.

### 4. DF-0001: the server and web changes (build stage 1)

These go first because the Apple app session's fix depends on them. They do not depend on the gate.

1. **Fixed order.** `usageWindows()` returns 5-hour, weekly, Fable weekly, by an explicit rank. The sort by percentage is removed.
2. **A limit that has reset.** `usageWindows(q, now)` takes the clock. A limit past its reset gets `rolledOver: true` and `tone: null`. Its percentage is still sent.
3. **The top limit is computed.** `topWindow(windows)` returns the highest limit that has not rolled over and replaces `windows[0]` at lines 332, 335 and 414, so the "nearly out" notices, the account's tone, `usageLine` and the account sort no longer react to a limit that already reset.
4. **Three new fields per limit.** `name` ("5-hour", "Weekly", "Fable weekly"), `tone` (`null` below 75, `'attn'` from 75 to 89, `'bad'` from 90) and `rolledOver`. One exported `usageTone(pct, rolledOver)` serves the limit and the account. `label` and `schemaVersion` are unchanged because the change is additive.
5. **Same rounding on both sides.** The web computes both the limit tone in `windowRow()` and the account tone (line 256) through the same shared tone rule on `Math.round(pct)`, the figure it displays. The literals 75 and 90 move to one shared constant file.
6. **Web tie-break.** The web's account sort gains a name tie-break.
7. **One boundary test for both sides.** `src/data/design/usage-tone-vectors.json` holds (percentage, reset state, expected tone, counts as top): 74, 75, 89, 89.6, 90, 100, and 100 with a reset in the past. One test feeds them to the server and the web, for the limit tone and the account tone, and checks that the server's `name` equals the web's for each label.
8. **Tests that pin the old order are updated**: the unit test "usage windows: … highest first", the integration test's `windows` expectation, and the end-to-end "alive" test.

**The note to the app sessions.** Draw limits in the order received; show `name`; paint `tone` as sent; treat `rolledOver` as "no figure, no colour"; an older server sends none of the three, so fall back to `label` with a capital and the same bands. Echo's design-standards session sends it to the Apple app session and to the session that owns the Windows family when stage 1 merges, and records that on DF-0001's status block. Android and Linux draw no limits and need nothing. Follow-through is the DF-0001 feedback card's `fix` item, which cannot close until each product's release evidence passes.

### 5. The design-feedback loop

**Noticing.** Two live seams: a wrapper chained on `telegram.onMessageLogged`, and a listener on `AppConversationStore.addAppendListener` that acts only on events committed locally (not replicated copies), so each message is seen once, on the machine that received it. Each entry is tested for the owner's own words by the same per-channel sender check the agent-work-cards change uses (Telegram: the configured owner id, not forwarded; app: the sender recorded as the owner person). With no owner identity configured for that channel, nothing is judged and the log says so once. For the owner's own words, one fast-tier call through the shared LLM funnel as component `design-feedback-detector`, never awaited, with ceilings of 60 calls an hour and 300 a day (about three times the owner's busiest day of messages, re-measured in stage 3). The call sees the message (first 4,000 characters, the card's own text limit), whether it has an image, and the three previous turns (last 1,000 characters each), told when anything was cut, all inside the data boundary. It answers `design-feedback`, `more-about` an open entry, `other` or `unknown`. Slack has its own seam; it is proven in stage 3 or carried by DSE-T9 <!-- tracked: CMT-2173 -->.

**Verdicts, honestly.** Each judged message gets one verdict row keyed by its message id in the replicated `design-feedback` store. A message the detector could not judge (ceiling reached, call failed) gets an `unjudged` row with the reason. There is no catch-up pass over the message log. Rows are kept 30 days; the weekly review lists the unjudged rows still inside that window and replays a sample of 20 owner messages a week through a stronger tier to measure misses. When a row expires the message is no longer counted. The session's own path below stays open for anything the detector missed.

**The session confirms.** A `design-feedback` or `more-about` verdict is a candidate, handed to the session serving that conversation, which confirms it with `POST /design-feedback/cards` or dismisses it with a reason. Dismissals are counted and sampled weekly. When the owner gives design feedback and no candidate arrived, the session uses the same route.

**The route trusts nothing from the caller.** `POST /design-feedback/cards` accepts only `{ conversationKey, messageId }`. The server reads that message through the durable-row read added by the agent-work-cards change, checks the sender with the same rule, and copies the words and attachments itself (`no-verified-owner` or `not-owners-words` otherwise). For `more-about`, the message is added to the open entry's row instead of opening a new card.

**The card.** The in-process server writer creates an ordinary Work Board card with an id derived from the source message, so one message never makes two cards. It is carried by the agent, `outward: false`, and covers `cos:design-feedback:<message key>`, which makes it server-owned: sessions cannot write its evidence, claim it or edit it. Its `need` is the owner's message text, locked to that message, with `requester` set from the verified sender, so under pull request 3596's rule it is approved by the owner's own request and never waits on him. The date and the attachment list are on its `design-feedback` row. Before 3596 merges, stage 3 is not built, so no such card exists in a state that waits on him. The card is visible to the owner, the agent, and any device that can read that conversation. Its four done items are `agent-may-certify`, and the server writes each item's evidence under a fixed record key (`wc:<id>:dfe:<item>`), so a retry or a second machine writes the same record:

| Item | Done when |
|---|---|
| `entry` | `docs/design-feedback/DF-NNNN-*.md` is on main, names this card and this message, and lists every problem with the rule it broke or "no rule existed". |
| `rules` | Every problem maps to a rule; each added or sharpened rule carries "Earned from: DF-NNNN"; the changelog has the row; the lint passes on main. |
| `fix` | On every surface the entry lists, every cited rule passes on the entry's screens: on the web, in the latest main render (machine rules measured, review rules answered `pass` on evidence identical to that render); on each native product, in a shipped release whose evidence folder holds that screen's captures and passing answers. `staged` never satisfies it. A surface whose evidence does not exist yet keeps the item open. |
| `check` | For every cited rule that already existed, the entry names one of `new-check`, `fixed-check` or `registry-change` with the file that makes it, or `not-checkable` for a rule whose Check is `review`; the lint checks the form. |

**Closing is the server's.** Card status is computed inside the daily sweep (section 6) from main's tree, main's render and the apps mirror, by a pure script, and written to the `design-feedback` store. A server module on the lead writes the evidence from those results, claims the card when all four hold, and sends the before and after captures for each verified surface to the conversation the feedback came from. A card read never triggers a pass. `GET /design-feedback` is the authoritative answer; if a card reads complete while the latest result says an item no longer holds, the module opens a continuation card for the same entry and records why.

**"Still wrong."** The owner says so in the conversation. A `more-about` verdict, or the session, links it to the entry; the server opens a continuation card and the entry gains a numbered round.

**Entry numbers** are the next free number on main; the lint refuses two entries with one number.

**The lint** (`scripts/design/lint.mjs`) is pure and tree-only. It runs from the base inside the design step (where items 2, 3 and 5 decide `standard-weakened`), as an ordinary unit test on the head as the author's early warning, and in the instar-dev pre-commit gate when the standard or an entry is staged.

1. Every rule has a unique id, every required field, and a Check of `machine` or `review`. The "at a glance" table lists exactly the machine rules.
2. **Ids are permanent.** `docs/design/rule-ids.lock.json` lists every id ever issued; the head's lock contains the base's.
3. **Rule and entry agree both ways**, and an "Earned from" mark or an entry's rules row present at the base still exists at the head.
4. Every numbered problem cites a rule or names the rule added. Every entry that changed rules has one changelog row naming exactly those rules.
5. **An earned rule is not loosened without the owner.** It lists every earned rule whose Rule line changed, that lost a surface, whose Check went from `machine` to `review`, that was retired, whose coverage row went from a test to `staged`, or whose mode went from `block` to `report`. A reduction needs a changelog row citing a waiver-family card the owner approved by presence that names the rule and the reduction. A changed Rule line alone goes to the gate's reviewer, shown both wordings: "does the new wording permit anything the old one refused?" `no` is recorded and passes; `yes` or `unsure` is treated as a reduction.
6. **Entries are safe to publish.** An entry has Card and Source message rows and a unique number. Nothing but `DF-*.md` is under `docs/design-feedback/`. Any email ends in `@example.com`. The owner's words appear only in the session's redacted version, each removal marked; the unedited words stay on the card.
7. **Gate misses are closed.** An entry's "why it was not caught" line that names the gate cites the change that fixes it.
8. **Coverage is complete.** Every machine rule has a row per surface: a test, or `staged` with a tracked card. Every review rule names its evidence kind. Every `uncaptured` screen cites a card.

### 6. Background work

| Piece | Where it runs | Interval and bound | On failure | Supervision |
|---|---|---|---|---|
| Detector | The machine that received the message | One call per owner message, 60 an hour, 300 a day | `unjudged` row with the reason | Tier 1: an LLM call inside a deterministic floor; only ever a candidate |
| Renderer install | Each rendering verifier, inside the run | On demand; one attempt, then hourly backoff on that machine | `unavailable: renderer-missing`, one degradation | Tier 0 |
| Daily sweep | Inside a post-merge verify of main, on a rendering verifier, never on the lead | The first main verify more than 24 hours after the last sweep success | Results not written; degradation when the last success is older than two days | Tier 0: pure functions of trees and renders |
| Card writer | The lead | After each sweep result arrives; at most 50 cards per pass, oldest-checked first | Items stay unverified | Tier 0 |

Each is behind the development-agent gate (none is a default job, so other agents get nothing), registered in the self-action registry with a pure decision function, and has a sustained-failure test.

**The daily sweep** renders every captured screen at main's tip, twice, and does three things:

1. **Retries skipped changes by commit.** For each first-parent commit on main since the last sweep that the classifier at its parent marks as UI and that has no measured design result (merged as `unavailable`, merged while switched off, or merged with no record at all), it renders the pair (parent, commit), runs the checks and the reviewer, and records the result for that pair. A pair that fails three sweeps in a row is recorded as `could-not-render` with its cause.
2. **Computes card status** for open feedback cards (section 5).
3. **Stores one aggregate count document** per sweep (per rule, screen, size and theme) for the maturation review, kept 90 days.

What it finds goes on the upkeep list, keyed by (repository, commit pair, rule, screen), so the same finding never appears twice. The upkeep list is carried by one standing Work Board card, created once at stage 2, carried by the agent and covering `cos:design-upkeep:<agent>`. Its one done item ("the upkeep list in `GET /design-feedback` is empty") never changes as rows come and go, so it is not re-approved each time; under the live board setting it waits for the owner's approve tap once, like every agent-written card today, and not at all under the lighter setting. The owner sees nothing else from the sweep, except one thing: an added violation of an earned rule found in a retried pair opens a waiver card for that commit, carried by him, saying it reached main without a check; his tap accepts it as waived, and otherwise the fix proceeds from the upkeep list and the server closes the card when the rule passes. Everything else still open at the weekly maturation review is listed there.

Self-heal declaration for the sweep:

- `remediation-actions`:
  - retry each skipped commit pair's render and review
  - put each finding on the upkeep list for the agent to fix
- `max-attempts`: three sweeps per commit pair, then `could-not-render`
- `max-wall-clock`: the step's policy total for each main verify that carries the sweep
- `backoff`: one sweep per day, after the first main verify more than 24 hours after the last success
- `dedupe-key`: (repository, commit pair, rule, screen); one open upkeep card per agent
- `breaker`: two days without a successful sweep raises one degradation and keeps one open until a sweep succeeds
- `max-notification-latency`: 192h
  - eight days for the weekly review; an added earned-rule violation reaches the owner's waiver card within 48h (at most two sweeps)
- `audit-location`: the `design-feedback` store and `GET /design-feedback`
- `class`: recoverable

**The apps mirror** is a new machine-local cache on each rendering verifier: a fetch-only clone of the private apps repository's tags and `design-evidence/` folder, fetched with the GitHub credential the agent already holds for that repository, once per sweep, with no API calls. It is counted in the capture store's budget. Missing or unreadable, it leaves native items unverified and raises one degradation.

### 7. The apps repository

The unit is the **release of one product**: everything between that product's last shipped mark and the commit being shipped. The products are `ios`, `mac`, `android`, `windows` and `linux`; iPhone and Mac ship separately, so each has its own mark.

- **Vendored checker.** Each family carries `design-gate/`: the checker, that family's classifier rules, a machine-readable copy of the standard, that family's screen registry (with `shared` sources) and coverage rows, and a `VERSION` file with the instar release it came from and a hash of the folder. `scripts/design/vendor.mjs` in instar produces it; a unit test proves the machine-readable standard equals the Markdown. Nothing depends on an installed Instar package. The sweep reports a folder that is behind.
- **The release step.** Each release script first runs the vendored checker **from the commit at that product's last mark**, over the range to the commit being shipped. The mark is the tag `shipped/<product>/<build>`, read with `ls-remote`; an unreadable remote stops the release with a plain reason. "No mark" is accepted as a first run only when the remote has none for that product, and the first run's range starts at the current tip and says so. The tag is written after the upload succeeds.
- **What it requires.** For every registered screen whose sources changed in the range (a `shared` source counts for every screen that lists it), `design-evidence/<product>/<build>/` must hold captures at that platform's standard sizes, and an independent reviewer's answers for every applicable rule, bound to the capture hashes. The checker reads each capture's pixel size from the image itself, never from its name. A `fail` refuses the release; `inherited` is accepted when it cites that screen's capture in the previous release's evidence, or, where none exists yet, an open feedback entry or upkeep row that tracks it. A changed UI file in no registered screen refuses the release as `screen-unregistered`. The shipping session fixes and ships again; an owner tap is never the repair for a release, and the step has no off switch of its own.
- **Where the captures come from.** Until a family's capture tool exists (DSE-T2 <!-- tracked: CMT-2166 -->, DSE-T3 <!-- tracked: CMT-2167 -->, DSE-T4 <!-- tracked: CMT-2168 -->), the shipping session takes them in the app's own debug capture mode with seeded data, as the Apple app session already does for DF-0001, and starts a fresh reviewer subagent. This is trusted as taken and self-reported, and stated so. Native automatic checks are part of those same tracked items and block nothing until they exist.
- **Required from the first release after the step lands** in that family's release scripts. There is no grace period after that.
- **Evidence** stays in the private apps repository and is never copied into instar.
- **Who builds it.** Echo's design-standards session prepares `design-gate/` and the release-script change for each family on a branch named `design-gate/<family>`, proves it on a throwaway clone, and sends it with a brief to that family's session: the Apple app session, the Android app session, and for Windows and Linux the session the Chief of Staff's project list names. Where none is named, Echo's session applies it itself. Each handoff is an upkeep row, which the sweep clears when that family's main branch calls the checker (read from the apps mirror).

### 8. Reaching every development session

| Change | Path |
|---|---|
| Gate files, design step, record field, status term, routes, modules | Code in the release. The server pieces resolve `designStandard.enabled` through `resolveDevAgentGate`: on a development agent they are live, elsewhere the routes answer 503 and nothing listens on the seams. An explicit value wins and is the off switch for the detector and the cards. |
| Replicated store | Kind `design-feedback`, registered in `ReplicatedKindRegistry` and `JOURNAL_KINDS`, emission gated by the same resolved flag. Each origin writes its own records; readers union them: one verdict per message id (the earliest), one result per commit pair (the newest), switch records appended. An older peer does not pull the unknown kind, which only means it shows no design state. |
| Agent awareness | One entry, `src/data/awareness/design-standard-gate.md`, with `requires: developmentAgent`. The awareness reader learns that value (parser, README, test), and every builder of the instructions (init, the instructions migration, the Codex and Gemini copies) passes it. It says: screen changes are rendered and checked at merge, and the gate starts the reviewer; where the standard and the registry are; owner design feedback is a card with an entry, never only a reply; read `GET /design-feedback` for what is open. |
| `/instar-dev` and `/build` | One note before the commit phase: for a UI change, the step can be run locally as an early look (`node scripts/design/gate.mjs --local`); the verifier's result is the one that counts. Delivered to installed copies by a fingerprinted, idempotent migration in `PostUpdateMigrator`, as at lines 4121 to 4126; customised copies are left alone. |
| Rollout | The new verifier version changes `verifierVersion` and `policyHash`, so open pull requests re-verify once. A record without the `design` field reads `unavailable: older-verifier`, never a refusal. Updating the verifier machines is coordinated first with the session that owns verifier capacity and with any update hold the Chief of Staff has in force. When stage 2 merges, the session tells the owners of open UI pull requests that their next verify is gated. |
| Visibility | `GET /local-verify` shows the switch and its record, each machine's renderer build, the capture store's size, the modes table and waivers per record. `GET /design-feedback` shows candidates, unjudged rows, open cards with their last result and its age, the upkeep list, and the last sweep. Both are agent-scoped reads proxied to the lead. |

## Verify the state, not its symbol

| What is claimed | Symbol read | State it stands for | Corroboration | When it cannot be measured |
|---|---|---|---|---|
| These captures show the code being merged | The design field of the record for (pull request, head, base) | The gate rendered the merge tree that lands, against main's tip | Base's harness and seeds; renderer build on the record; two renders per side | `unavailable`, by name, retried by the sweep |
| Nothing visible changed | Base and head captures and traces are identical | The change alters no captured state or keyboard order of any registered screen | Same run, renderer and seeds; determinism shown by two renders | States the seed does not render are not compared |
| A machine rule passes | The step's measurement | The rendered screen satisfies it at every size | The check failed on its fixture in the same run | `unavailable: control-failed` |
| A review rule passes | The posted answers | A session the gate started, not the author, read paired evidence | Bound to the hash of both sides' captures, traces and rule wording; session id from the server's own record | `not-observable` is `staged` with a card |
| The merge respects the design decision | The `instar/local-verify` status | The decision recorded by the verifier from the base's table | GitHub's ruleset requires the status; the Actions floor refuses UI changes | An admin merge, found by the sweep |
| The owner agreed to waive his rule | `approvalValid`, `proof: presence` and the owner's person key on a server-composed waiver card | He tapped on his phone for this evidence | The card holds the evidence hash and rule wording; changed evidence voids it | Card unreadable: the waiver is not established and the change does not merge as waived |
| This message is the owner's design feedback | The message row the server read itself | The owner wrote it | Per-channel sender check, run by the server | No owner identity for the channel: no card |
| This feedback is fully handled | Evidence under the server's fixed record keys on four items | Entry, rules and new check on main, and passing captures on every surface | Recomputed each sweep from trees, renders and release evidence | An unreadable tree or mirror leaves the item open |

## Multi-machine posture

- **Gate files, standard, registry, coverage map, lock file:** `unified`. Git-tracked.
- **Pinned renderer:** `unified`. A provisioned prerequisite each rendering verifier installs on demand under its run folder; no verdict depends on which machine ran.
- **Capture store and base cache:** `proxied-on-read`. Operational and re-creatable from the commits, the seeds and the renderer build. The record names the machine that holds them; if that machine is gone, the capture is re-rendered from the commits or the result is `unavailable: captures-unreachable`.
- **Apps mirror:** `unified`, provisioned on every rendering verifier with the credential the agent already holds; rebuilt from the remote at any time.
- **Verify records with the `design` field:** as Local Verify has them today.
- **The off switch:** the coordinator's value governs, read at run start and at status posting and written on the record. The verifier running the run reads nothing from its own copy. Its change history is in the replicated store.
- **Verdict rows, unjudged rows, pair results, sweep counts, upkeep rows, switch records:** `unified`, the replicated kind `design-feedback` (section 8). Verdict and unjudged rows 30 days; pair results and upkeep rows until resolved plus 30 days; count documents 90 days; switch records 1 year.
- **Feedback, waiver and upkeep cards:** `unified`. Work Board records in the existing format.
- **The detector:** runs on whichever machine receives the message; verdicts collapse by message id.
- **The card writer:** the lead only; a takeover continues from the replicated results.
- **Native captures:** taken on whichever machine ships that product, with the family's own tool. Apple captures need Xcode on Apple hardware; Apple builds run today on one machine under its build lock.
  machine-local-justification: hardware-bound-resource
- **Single machine:** everything works with no peer. A machine that cannot install the renderer merges UI changes as `unavailable`, and the sweep cannot run, which raises the two-day degradation.

## Decision points touched

| Decision | Kind |
|---|---|
| Is this path a user-interface file? | invariant; basis: enumerable-domain; evidence: the path rules, the registry's source lists and the base render's load lists are closed lists, read from the base |
| Which trees are compared, and which copy of the gate decides? | invariant; basis: enumerable-domain; evidence: base is the record's `baseSha` and head is the verified merge tree; the gate, modes and table are read from `baseSha` and their hash is on the record |
| Did anything visible change? | invariant; basis: enumerable-domain; evidence: both sides' captures and traces from one run are identical or not, and each side's two renders agree |
| Is a render failure the change's? | invariant; basis: enumerable-domain; evidence: the base rendered that screen in the same run and the head did not |
| Is a violation added by this change? | invariant; basis: enumerable-domain; evidence: its key is at the head and not at the base, or the head's count is higher |
| What does a measurement mean for the merge? | invariant; basis: enumerable-domain; evidence: every measurement falls in exactly one row of the table or one structural result, and the status projection reads the recorded decision |
| Does a review rule pass, and is a failure inherited? | judgment-candidate. Floor: every applicable review rule has an answer bound to the paired evidence and the rule's wording; an added `fail` refuses unless waived; `inherited` needs the base evidence to show it; `not-observable` needs a tracked card. Arbiter: a reviewer session the gate started |
| May a non-earned rule be waived for this change? | judgment-candidate. Floor: never by the author; a written reason; bound to the rule and the evidence; the fix on the upkeep list; listed weekly. Arbiter: the reviewer session |
| May an earned rule be waived or loosened? | invariant; basis: external-constraint; evidence: the owner asked that feedback change the standard "such that we no longer make those mistakes" [source: telegram 141385/146785 2026-11-21]; reserving waivers and loosening to him is the agent's wording (decision 4), which binds once he approves this spec and that approval is cited; in the tap code only `proof: presence` cannot be produced by the agent |
| Does a new Rule line loosen an earned rule? | judgment-candidate. Floor: any Rule-line edit to an earned rule needs a recorded verdict; `yes` or `unsure` goes to the owner. Arbiter: the reviewer session, shown both wordings |
| How long may the step stay switched off? | judgment-candidate. Floor: every off value is recorded and signalled to the owner, it lapses at most 24 hours after it was first seen (one sweep cycle), and a change touching a screen with an earned-rule violation still needs the owner's card. Arbiter: the session that sets it chooses a shorter `until` |
| Which machine's off switch governs? | invariant; basis: enumerable-domain; evidence: the coordinator's value, read at run start and at posting, written on the record |
| Is this owner message design feedback? | judgment-candidate. Floor: only the owner's own words, checked per channel by the server; the outcome is only a candidate; never delays a message; an unjudged message is recorded as such. Arbiter: the detector proposes, the session in the conversation confirms |
| Is a feedback card done? | invariant; basis: enumerable-domain; evidence: four pure functions of main's tree, main's render and the release evidence, with the `check` reason from a closed list, written by the server under fixed record keys |
| Should a check block yet? | judgment-candidate. Floor: a mode change is a harness change with an independent review that sees coverage of screens, sizes, themes and machines, the negative control and every traced false failure. Arbiter: the maturation review |
| Is a step result `unavailable`? | invariant; basis: enumerable-domain; evidence: a closed list of causes, each produced by code |

## Over-block and under-block

- **Over-block.** A new screen must come with a seed and be clean of blocking rules, because all of its violations are added. Registering a screen or editing a seed is a harness change. A check can be wrong; that is why every check starts in `report`, and why a false failure of a non-earned rule can be waived by the reviewer. A repeated false failure of an earned check in `block` can be demoted by one owner tap under decision 4 instead of a waiver per change. A UI change cannot merge while only the Actions floor is available. A screen that renders differently twice is `unavailable` until fixed, not refused. A release of an app needs captures and a review for every changed screen; a change to a shared component needs them for every screen that lists it.
- **Under-block.** An `unavailable` step lets a change merge unseen until the next sweep retries its pair. Non-earned waivers and native captures are self-reported. States the seed does not render (hover, an open dialog) are not compared. A server file that affects a screen and is in no source list is caught only by the sweep. A screen marked `uncaptured` has no checks; at the first rung only the accounts screen is captured. Feedback on Slack is caught only by the session's own path until DSE-T9 is closed. A detector outage leaves messages `unjudged` and only the session's path catches them. A waiver card cannot open while the owner's waiting lane is at its soft budget, so that change waits. A message longer than the card's text limit is not request-approved, so the session reads the full words from the row. An admin merge or a hand-uploaded app build is seen only afterwards. While switched off, only screens the latest main render shows with an earned-rule violation are held; a screen never rendered is not.
- **Cost.** The step adds a base render per main tip per rendering verifier and a head render of the affected screens per UI change, plus one reviewer session per changed screen. The detector adds one fast call per owner message, within its ceilings. Each is measured at each rung and reported beside the lanes.
- **What is not measured.** The headline number measures recurrence. Nothing here measures delight, and the spec does not claim to.

## Maturation plan

- **test-agent-live:** each stage is proven on a throwaway agent and throwaway clones: a UI pull request with no review (the gate starts one); a review bound to evidence that then changed; an added violation in `report` and in `block`; an inherited review failure; a head that crashes where the base renders; a screen made nondeterministic; a shared stylesheet change; a change that edits the classifier or the lint to hide itself; a UI change forced onto the Actions floor; a raw merge attempt against the status; a valid owner phone waiver and a PIN tap on the same card; the renderer removed; the switch on, including a change to a screen with an earned-rule violation and the switch lapsing; a detector run over real past owner messages, including DF-0001's, and over messages that mention a screen without criticising it.
- **dev-agent-live:** then on the development agent with real UI changes and the owner's real feedback. The DF-0001 fix is the first full pass through the loop.
- **fleet:** no fleet turn-on in this version. Other agents receive the code dark and no awareness text. Opening it to users' projects is DSE-T1.
- **graduation criterion:** judged by the maturation review on real use: every piece of owner design feedback since stage 3 has a card and an entry; every closed card closed on server-written evidence; how often the owner pointed out something an existing rule already covered, each traced to a check that was then added; the stronger-tier replay's misses; dismissed candidates, sampled; unjudged rows; waivers, each listed; merges as `unavailable` and whether their retries passed; off periods; the upkeep list's size and age; the number of owner taps the loop caused; per-rule counts on main; the step's added verify time; captured screens against registered screens. Missing evidence records `incomplete`, never a pass. No minimum duration.
- **dark-window:** not applicable to the fleet. On the development agent each check's `report` period is its dark window, and each has a date by which it is promoted, changed or retired.
- **ladder:** the switch `designStandard.enabled`, resolved by `resolveDevAgentGate`; the stage 2 change adds its ladder entry with these evidence rows
- **Owner:** Echo.

The north-star measure: **how often the owner points out something a rule already covered.** That number going to zero is what "we no longer make those mistakes" means.

## Build stages with live proof

1. **DF-0001 server and web** (section 4). Proof: the tests named there; the shared boundary test failing when either side's threshold or rounding is changed, for limit and account tone; a live read of `/mobile/accounts` on a throwaway agent showing fixed order, `name`, `tone`, and a reset limit with no tone that is not the top; an older app build still drawing its list.
2. **The gate** (sections 1 to 3): parser, classifier, registry with every console route and the other pages, coverage map, modes, lint, harness with the pinned renderer, the accounts seed, the base cache, the capture store, the design step, the status term, the Actions-floor refusal, the watcher classes, the reviewer start, the review and waiver routes, the waiver card family, the off switch and its record, the `HARNESS_GLOBS` additions, and the measured worst case for the policy limits. Proof on a throwaway repository with the local floor on: each case in the test-agent list gives its named result; a non-UI pull request never starts a browser; DF-0001 and the current standard pass the lint unchanged.
3. **The feedback loop** (section 5), built after pull request 3596 merges: detector on both seams, candidates, the card family, the card writer, routes, awareness value, skill note. Proof through real Telegram and an app conversation on a throwaway agent: a design remark with a screenshot produces one candidate and, once confirmed, exactly one request-approved card that never enters the owner's waiting lane; the same message again produces none; a forwarded message and a team member's message produce none; with no owner configured nothing opens; a session cannot supply words through the route, nor write evidence on the card; the card closes only when the four items verify; "still wrong" opens a continuation. Slack is proven the same way, or DSE-T9 records what was found. DF-0001 gets its card.
4. **The daily sweep and the upkeep card** (section 6). Proof: a change merged as `unavailable` is retried by its commits on the next sweep and its result recorded; an admin-merged UI commit is found; a repeat finding does not duplicate; a failed sweep writes nothing and the degradation fires after two days.
5. **Apps repository** (section 7), per family: the vendored folder, the per-product mark and the release step. Proof per family on a throwaway clone: a release whose range changes a registered screen with no captures stops; one whose captures are the wrong size stops; a clean range with captures and passing answers ships and writes its mark after upload. Stage 5 is complete when each family's branch is prepared and proven, each brief is sent with its upkeep row open, and the families Echo carries itself are merged; the other families' merges are followed by the sweep.
6. **Constitution**, both books, last.

Each stage ships unit, integration and end-to-end tests under the Testing Integrity Standard, with both sides of every decision row above, and wiring checks for the detector, the card writer, the record field and the status term. The run's completion condition is stages 1 to 6 complete as defined and every item under "Tracked next steps" open with its named owner.

## Tracked next steps

The lint requires every `staged` coverage row and every `uncaptured` screen to cite one of these.

> **CMT-2165** — "DSE-T1: Offer the design gate to users' own projects: the checker, lint, capture step and detector read the standard path, the registry path and the evidence location from one project file, and turn on only by the explicit flag `resolveDevAgentGate` already honours." Owner: Echo's design-standards session.
>
> **CMT-2166** — "DSE-T2: Apple capture tool and automatic checks: a design-audit test in `InstarAppUITests` that launches each registered screen with seeded data at the standard sizes, reads frames and names from the accessibility tree, and writes captures into the private apps repository." Owner: the Apple app session.
>
> **CMT-2167** — "DSE-T3: Android capture tool and automatic checks with Compose UI tests at the standard sizes and font scale 1.3." Owner: the Android app session.
>
> **CMT-2168** — "DSE-T4: Windows and Linux capture tools and automatic checks. Each begins as its own spec through spec-converge." Owner: the session the Chief of Staff's project list names for each family; Echo's design-standards session carries either one for which none is named.
>
> **CMT-2169** — "DSE-T5: Seeds and harness support for the dashboard pages that are not console routes, and the pairing page." This revision widens it to the Documents page, the pages rendered from TypeScript, and the remaining console routes in order of use and feedback history. Owner: Echo's design-standards session.
>
> **CMT-2170** — "DSE-T6: Decide the merge gate for wording in messages and notices written by agents." It includes the UX impact workflow's dead `paths:` filter. Owner: Echo's design-standards session.
>
> **CMT-2171** — "DSE-T7: Decide whether accounts needing sign-in sort first on every surface." Owner: Echo's design-standards session, recorded on DF-0001.
>
> **CMT-2172** — "DSE-T8: Interaction traces the harness does not yet produce, for the review rules that need them." Owner: Echo's design-standards session.
>
> **CMT-2173** — "DSE-T9: Design-feedback detection for owner messages that arrive through Slack, if stage 3 does not prove it." Owner: Echo's design-standards session.

## Rollback

The fast rollback is the switch `monitoring.localVerify.designStepOff` in the coordinator's config: no pull request is needed, so a broken step cannot block its own removal. It is recorded, tells the owner, and lapses within a day, so a longer rollback is a reviewed change: setting rows of `DESIGN_GATE_MODES` back to `report`, or a release without the step. The detector and the cards are turned off by `designStandard.enabled: false`; open cards stay on the board. Stage 1's fields are additive and are not rolled back with the gate. The status term reads only a recorded design decision, so with the step off nothing refuses; the one thing still held is a change to a screen with an earned-rule violation, which waits for the owner's card or for the switch to lapse. In the apps repository the rollback is removing the checker call from a release script, which the sweep reports.

## Out of scope

- Other agents' own projects (DSE-T1).
- The public website, and the wording of messages and notices (DSE-T6).
- Deciding what good design is; that is `docs/DESIGN-STANDARD.md`.
- Golden-image visual regression; a change is compared only with its own base.
- The native side of the DF-0001 fix, which the Apple app session is building.
- Native automatic checks (DSE-T2 to DSE-T4).
- A GitHub plan change or a continuous-integration service for the apps repository.
- Rewriting the legacy dashboard's existing floors and jsdom tests; the coverage map points at them.

## Left behind

Precision points that do not change the design.

- Which existing server-to-session path hands a candidate to the session in a conversation; named at build and proven in stage 3.
- The reviewer session's default model; set in config at stage 2 and recorded on every review.
- Whether a design remark that also produced a request card through the agent-work-cards path should be merged into the feedback card; stage 3 checks for the duplicate and the session closes one.
- A cap on the length of dismissal reasons.
- The standard's Mac "Smallest window" row mentions a capture's file name; it is corrected when the Mac capture tool is specified.
- The second rule book's "Value" paragraph and approval line for the new rule are written once the owner's approval message exists.

## Constitution wording

Two pull requests, opened by Echo's design-standards session, each naming the other on a `Constitution counterpart:` line so `scripts/check-constitution-pairing.mjs` passes. The registry is code-owned, so its pull request needs the owner's approval on GitHub, sent to him as a link. Whether the `instar-2` pull request needs it is read live by safe-merge, not assumed.

**Second book** (`JKHeadley/instar-2`, `docs/01-the-rules.md`, a new row under "Needs building"). The figures it changes: the summary table's "Needs building" from 79 to 80 and "Total" from 123 to 124; the headings "Checkable now — 22 of 123", "Free from the core — 9 of 123" and "Held by the mind — 13 of 123" to "of 124"; and "Needs building — 79 of 123" to "80 of 124". It also gets a "Value — rationale for Rule 124" paragraph and the approval line with its source.

> | 124 | Design Mistakes Become Rules | Every design mistake the owner points out is diagnosed in writing and becomes a rule in the Design Standard or sharpens one. Every change to a screen is rendered at the standard sizes with realistic data and measured against the rules before it merges or ships, and the decision is part of the merge's own verification. A rule the owner's feedback earned is waived or loosened only by the owner. | A design step in Local Verify that renders the base and the merge tree and applies one decision table; a lint tying each feedback entry to its rules; a release step in each app; a tracked card per piece of feedback that closes on verified captures. Whether a screen is genuinely good stays the mind's (#80). |

**First book** (`docs/STANDARDS-REGISTRY.md`, under *Operator-Surface Quality*):

> ### Design Mistakes Become Rules; Screens Are Measured Against the Rules Before They Merge
> **Rule.** Every design mistake the owner points out is diagnosed in writing, naming the practice that was broken, and becomes a rule in the Design Standard or sharpens one; the feedback, the diagnosis, the rule and the fix are linked by a tracked card that closes only when the server has verified each, including passing captures on every surface the feedback concerns. Every change to a screen is rendered at the standard sizes with realistic data and measured against the applicable rules before it merges or ships. Rules that can be measured are measured by machine.
> **Fails.** A change may not add a violation of a blocking rule, and a change that breaks a screen it touches does not merge. A screen change with a visible difference that nobody independent has read does not merge. A check that cannot run is recorded as unavailable by name and retried the next day; it is never recorded as a pass. Turning the check off is recorded, the owner is told, and it lapses within a day. A rule the owner's feedback earned is waived or loosened only by the owner, by a tap on his own phone bound to that exact change. Any other rule may be waived only by a reviewer who did not write the change, with a recorded reason.
> **In practice.** `docs/DESIGN-STANDARD.md` is the one standard and its rule ids are permanent. The design step in Local Verify runs main's copy of the gate, renders main's tip and the merge tree with a pinned renderer, and records its decision in the verification status every merge path reads. Captures stay in the agent's private store. Each app's release script runs a vendored checker that requires captures and an independent review. Owner design feedback becomes a Work Board card approved by his own message and closed by the server.
> **Earned from.** 2026-11-21: the owner compared the Mac app's accounts screen with the web dashboard's and found the Mac one clearly worse. The diagnosis found fifteen problems; for twelve no rule existed, and the rest were covered by a rule that applied to the web only. The existing quality standard already said a pull request names the screens that were loaded and at which widths, and nothing checked it.
> **Traces to the goal.** A coherent agent does not make its person point out the same kind of mistake twice, and does not ask them to look at a screen it has not looked at itself.
> **Applied through.** `scripts/design/gate.mjs`; `scripts/design/lint.mjs`; the design step of Local Verify and its status term; the release step in each app; `docs/specs/design-standard-enforcement.md`. **Parent principle:** *Structure beats Willpower*.

## Constitution alignment

- **Structure beats Willpower (parent).** A paragraph in a standard becomes a term of the merge status, a lint, a release step and a card the server closes.
- **Verify the State, Not Its Symbol.** The gate renders the tree that lands; native captures are checked by their pixels; each remaining symbol is declared with its unmeasurable case.
- **Signal vs. Authority; Judgment Within Floors.** Measurements are signals. The recorded decision holds the authority to merge. Each judgment sits inside a stated floor with a named arbiter.
- **Intelligent Prompts: An LLM Gate Must Not String-Match.** Whether a message is design feedback, and whether a review rule passes, are judged by meaning.
- **No Silent Degradation; the User Experience Is the Product.** `unavailable` is named, signalled and retried by commit; the off switch is signalled and lapses.
- **Close the Loop.** Feedback is a card from the moment it is confirmed; the gate's own leftovers are one standing card; every staged piece cites a tracked commitment.
- **Agent Proposes, Operator Approves; Approval Only Where Required; The Agent Carries the Loop.** The owner is asked for the constitution article and for his earned rules. His own message approves his feedback card; he is never asked to close one or to approve a waiver of an ordinary rule.
- **Attributed Statements Trace to Their Source.** The origin cites the owner's message; the reservation of earned rules is marked as the agent's wording until he approves it.
- **A Dark Feature Guards Nothing.** The native release step requires real captures and a review now, instead of resting on tools that do not exist yet.
- **Always a Multi-Machine Entity.** Every new piece of state has a posture; the one machine-local item uses a key from the closed list.
- **Updates never restrict existing agents; Migration Parity; Agent Awareness.** Nothing here holds or instructs any agent but a development agent.
- **One Constitution, Two Books Aligned.** Both wordings are above, paired, with every figure that changes.
- **Occam's Razor.** One parser, one classifier, one gate and one decision table serve the verifier, the status, the release scripts and the sweep. This revision removed the merge-base copy, the separate Actions-floor reading, the detector's catch-up over the message log, the per-screen tracked cards, the native static scans and vectors, and the local mirrors of instar.
