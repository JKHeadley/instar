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
  - "Verify the State, Not Its Symbol (evidence is tied to the fingerprint of the screen files it was captured from; image sizes are read from the image bytes, never from a file name)"
  - "Signal vs. Authority and Judgment Within Floors (machine checks and records are signals read by one gate; whether a message is design feedback is a judgment with a stated floor)"
  - "Intelligent Prompts: An LLM Gate Must Not String-Match (design feedback is recognised by meaning)"
  - "Counts are signals, not gates (the ratchet compares against a recorded baseline; no count ends or passes a review)"
  - "No Silent Degradation to Brittle Fallback (a verifier with no browser fails the lane and says so; it never passes blind)"
  - "Close the Loop: Untracked = Abandoned (each piece of design feedback is a card that cannot be claimed done until its entry, its rule and its fix are verified)"
  - "Someone Else's Work trap (a parity gap on another surface is a named card, never a scope note)"
  - "Operator handoff: verified authority (an override is a person's tap on a card bound to the exact change, never a line an agent writes)"
  - "Approval Only Where Required (the owner approves the constitution article and overrides; nothing else in this loop waits for him)"
  - "Local Verify is the merge floor; GitHub Actions is often saturated (a gate that lives only in a GitHub workflow is weak)"
  - "Updates never restrict existing agents (the gate governs Instar's own screens on the development agent; other agents receive awareness text and no hold)"
  - "Migration Parity and Agent Awareness"
---

# Every design mistake the owner points out becomes a rule, and every screen change shows its screens against the rules before it merges

## Problem statement

On 2026-11-21 Justin compared two screenshots and saw that the Mac app's accounts screen was clearly worse than the web dashboard's. The diagnosis (`docs/design-feedback/DF-0001-accounts-usage-mac-vs-web.md`) found fifteen problems. For twelve of them no rule existed anywhere. For the rest a rule existed for the web only and nothing applied it to the Mac. `docs/DESIGN-STANDARD.md` now holds 65 rules for all six surfaces, 27 of them marked machine-checkable, and a table of standard screenshot sizes. Three things are still missing, and each is structural:

1. **Nothing requires a screen change to show its screens.** The standard says captures are taken at the standard sizes before anyone is asked to look. No script checks that they exist, that they were taken from the code being merged, or that they are the stated size.
2. **No machine-checkable rule has a machine check that runs at merge.** The dashboard UX standard designed a headless-browser smoke test for sideways scroll and left "run it on every PR or by hand?" as an open decision. The 27 machine rules in the new standard are descriptions of checks, not checks.
3. **The feedback loop is a paragraph.** "How this standard grows" describes the diagnosis, the rule and the fix. Whether it happens depends on the session that hears the feedback remembering to do it.

This spec makes all three structural, and it carries the server and web half of the DF-0001 fix as its first build stage.

## Ground truth from the code (branch `echo/design-standards` at 468966b68)

Read in this worktree and in the apps checkout at `/Users/dabombstudio/.instar/agents/echo/apps/instar-ios` on 2026-11-21.

| Existing piece | Where | State today | How this spec uses it |
|---|---|---|---|
| Design Standard | `docs/DESIGN-STANDARD.md` | 65 rules `DS-*`; each has Rule, Why, Bad, Good, Surfaces, Check (`machine` or `review`), Source or Earned from. A table of 27 machine rules, a table of standard sizes, a changelog. Markdown only; no parser reads it. | The single source. One shared parser reads it (section 2). Nothing copies the rule list into another file. |
| First feedback entry | `docs/design-feedback/DF-0001-…md`, `media/` | A header table, the owner's words, 15 numbered problems each naming a rule or "no rule existed", the fix, a table of 22 rules added or sharpened, a status block. No card id. | The format the lint enforces (section 6). Gains two header rows. |
| UX impact lint | `scripts/ux-impact-lint.mjs`, `.github/workflows/ux-impact-pr-gate.yml` | Requires a "## UX Impact" section in the PR body for `src/server/routes.ts`, `src/commands/server.ts`, `src/scaffold/templates.ts`, `src/messaging/**`, `src/dashboard/**`, `src/templates/**`. The dashboard's real folder is `dashboard/` at the repo root; `src/dashboard/` does not exist, so no dashboard file is in its scope. It applies only when the pusher or a commit author matches the literal scope `jkheadley`. It is a GitHub workflow only, and its context is not in safe-merge's pinned floor. | Left as the gate for message wording. Its dead path is corrected in stage 2 (decision 17). It is not the design gate. |
| Operator-surface classifier | `scripts/lib/operator-surface.mjs`, read by `scripts/instar-dev-precommit.js` | `OPERATOR_SURFACE_RE` matches `dashboard/*.js` and `*.html` plus approval and secret-drop files. The commit gate requires the side-effects artifact to mention operator-surface quality. | The pattern for a pure, unit-tested path classifier. The new classifier sits beside it. |
| Merge path | `scripts/safe-merge.mjs`, `scripts/local-verify-floor.mjs`, `src/localVerify/` | Under the `local` floor safe-merge reads the server's verify record for exactly (pr, head, base), requires every gating lane to have `failed == 0 && tests > 0 && files > 0`, and runs three body checks from its own trusted copy (`eli16`, `decision-audit`, `release-fragment`). Lanes are `unit`, `integration`, `e2e` (`src/localVerify/inventory.ts`); a test file in no lane fails the run. Anything unmeasurable is a refusal, never an Actions fallback. Under the `actions` floor the code-pinned `REQUIRED_CONTEXTS_FLOOR` is enforced with producer binding. A record flagged `harnessChanging` needs an independent-review trace. | The gate's authority lives here (section 4). A fourth lane and one record field are added; both are harness changes and take the independent review the predicate already demands. |
| Hooks | `.husky/pre-commit` (`set -e`, lint, instar-dev trace check), `.husky/pre-push` (gates, smoke tests, path-scoped e2e) | Live. | Pre-push gains the evidence check as the fast early signal. |
| Skills | `skills/instar-dev/SKILL.md` (phases 0 to 7), `.claude/skills/build/SKILL.md` | Neither mentions screens, captures or the Design Standard. | Each gains one step (section 7). |
| Dashboard standards | `docs/specs/dashboard-ux-standard.md` "Enforcement design", `docs/specs/dashboard-ui-quality-standard.md` | Static floors and jsdom tests for the legacy dashboard; the viewport smoke test in headless Chromium is designed with its run point undecided (FD-2 there). The quality standard's "check before calling it done" is prose. | This spec decides that open point: the browser checks run in Local Verify and in CI on every PR. The existing jsdom floors stay and are mapped to rule ids. |
| Browser tooling | `package.json` | `jsdom` is a dev dependency. Playwright is not a dependency; `scripts/documents-live-proof.ts` loads it from a global install when present. | `playwright-core` and `axe-core` become dev dependencies (decision 12). |
| Console pages | `dashboard/console/` (`nav-model.js` exports `NATIVE_PAGES`, `resolveRoute`, "tested over every route"); `src/server/dashboardPreview.ts` | A route table exists and is already walked by tests. Pages talk to the server API with the operator's token. | The list of web screens is read from the route table, not kept by hand. |
| Work Board | `src/server/workBoardRoutes.ts`, `src/core/WorkBoardService.ts`, `src/core/WorkCardStore.ts`, `src/core/ChiefOfStaffWaitCards.ts` | A card has `title`, `need`, `doneWhen` (items with `certify: 'owner-confirms' \| 'agent-may-certify'`), `projectKey`, `source: { conversationKey, messageId }`, `covers`, `mirror`. `claimDone` refuses `evidence-missing` until every item has counting evidence. A tap is a person's only (dashboard PIN or phone presence signature); "The agent cannot tap." The server itself opens cards as principal `SERVER` with a derived card id (Chief of Staff wait cards). | The design-feedback card is a server-opened card of the same kind (section 6). Overrides are owner taps (section 4). |
| Owner-message seam | `src/commands/server.ts` (the wrapper on `telegram.onMessageLogged`) | Every logged message is tested with `isOwnersOwnWords(entry, telegram.getVerifiedOwner())`; forwarded text and team members' words are excluded; the correction loop is then called with `void` so it can never delay delivery. | The design-feedback detector hangs on the same seam under the same rules. Only the Telegram seam was read; Slack and app conversations are proven in stage 4 or listed as gaps. |
| Account usage, server | `src/server/mobileCapacityRoutes.ts` | `usageWindows()` ends `return wins.sort((a, b) => b.pct - a.pct)`. `MobileAccountWindow` is `{ label, pct, resetsAt }` with labels `5-hour`, `weekly`, `Fable weekly`. The account's top window is read as `windows[0]` at three places (the two notice checks near line 332 and 335, and `top` near line 414). Account tone is `>= 90 ? 'bad' : >= 75 ? 'attn' : null` on a rounded percentage. Accounts sort by needs-sign-in, kind, percentage, name. | Changed in stage 1. |
| Account usage, web | `dashboard/console/accounts-model.js` | `usageWindows()` returns a fixed order. `windowRow()` capitalises the label into `name` and sets `tone` from the unrounded percentage with `NEAR_OUT_PCT = 90` and a literal 75. Accounts sort by framework name then percentage, with no tie-break. | Changed in stage 1. |
| Tests that pin the old order | `tests/unit/mobile-native-capacity-screens.test.ts` ("usage windows: … highest first"), `tests/integration/mobile-native-capacity-screens.test.ts` (the `windows` array of the second account), `tests/e2e/mobile-native-capacity-screens-alive.test.ts` | Live. | Updated in stage 1. |
| Native apps | `EchoOfDawn/instar-desktop-apps` (private) | One repository holding unrelated branch families: `apple/*` (SwiftUI, `project.yml`, `InstarApp`, `InstarMac`, `Tests/InstarAppUITests` with 16 XCUITest files), `android/*` (Kotlin, Jetpack Compose, `ui-test-junit4` already a test dependency), `windows/*` (WinUI 3 on the Windows App SDK, `InstarWindows/App`), `linux/main` (Avalonia 12, `src/App`). All four apps exist. The repository has no workflows, no git hooks, no tags and no pull requests. Its GitHub plan does not offer rulesets (`GET …/rulesets` answers 403 "Upgrade to GitHub Pro"). Its default branch is a Windows work branch. Releases are made by scripts: `scripts/ship.sh` (TestFlight), `scripts/ship-mac.sh` (signed Mac download), `scripts/publish-mac-feed.sh`, `scripts/play-publish.mjs` (Android), the Windows family's `scripts/sign-release.ps1` and `scripts/pack-test-release.ps1`, and the Linux family's `scripts/`. Apple builds run on the Laptop under a one-build lock, because the Studio has no Xcode (`apps/ios-wt/BRIEF.md`). Work is merged by an integrating session, branch to branch. | The gate there cannot rest on GitHub. It rests on the release scripts, repository hooks and a daily audit (section 4). |
| Shipped scripts | `package.json` `files` | `scripts/` and `src/data/` ship in the npm package. | The checker and the shared test vectors reach every machine that has Instar installed, so the apps repository calls a trusted copy it does not carry. |
| Constitution | `docs/STANDARDS-REGISTRY.md` ("Operator-Surface Quality", with "Dashboard UX Standard" as a named subsection), `.github/CODEOWNERS` | The registry is code-owned by Justin. | One article is added (section "Constitution wording"); that pull request needs his review on GitHub. |

### What is new

1. A **screen registry** and a **path classifier** that decide what counts as a user-interface change.
2. A **design evidence folder** per change, and a checker that verifies it.
3. A **design lane** of automatic checks in headless Chromium, a ratchet for existing violations, and a staged plan for native apps.
4. The gate's **run points** in both repositories, the **override**, and a **daily audit**.
5. The **design-feedback card**, its detector, and a **lint** that keeps the standard, the entries and the changelog consistent.
6. The **DF-0001 server and web changes** (build stage 1).
7. One **constitution article**.

## Threat model

The agent is cooperating but forgetful, and under time pressure it takes the shortest path. The failures this prevents are omissions: no captures, captures of tidy data, a checklist ticked without looking, feedback acknowledged in chat and never diagnosed. Shortcuts designed against:

- **Evidence from another version.** The folder records a fingerprint of the screen files it was captured from; the gate recomputes it from the merge head.
- **A file named `1280x728.png` that is not.** Width and height are read from the image header.
- **"Not applicable" as a way out.** Every applicable rule needs an entry; a not-applicable entry needs a reason; machine rules are filled by the checker, not by hand.
- **"Refactor, nothing visible changed."** For the web the gate renders the affected screens at the base and at the head itself and compares them. A difference refuses the exemption.
- **An override typed by the agent.** An override is an owner's tap on a card whose text binds the exact change. The agent cannot tap.
- **A check that passes because it could not run.** No browser, no fixture, no registered screen: each is a failure with its own name.

Out of scope, as for every merge gate today: a session that deliberately bypasses the merge path with an admin merge, or builds and uploads an app by hand outside the release scripts. The daily audit (section 4) finds both afterwards and opens a card.

## Frontloaded Decisions

Every decision here is one Justin may want to change. Each gives the recommendation the rest of the spec assumes.

1. **Scope is Instar's own six surfaces.** The gate and the feedback loop run on the development agent (`resolveDevAgentGate`), for the instar repository and the apps repository. Other agents' own projects are not gated in this version. *Recommended*, because "all development that we do" is Instar's development, and a hold on other agents' projects would restrict existing agents through an update.
2. **Which standard sizes a change must carry.** Web: Desktop 1280 x 728 dark, Phone 390 x 844 dark, Desktop light; Wide 1440 x 900 dark only when a stylesheet or a shared component changes; Tablet 768 is checked by machine and needs no committed image. Each native surface: Standard, Smallest and Large text in dark, and Standard in light where the surface has light mode. Web images are captured at scale 1, so the file is exactly the stated size. Native images are at the device's own scale and the manifest records it. *Recommended*: these are the standard's sizes with the smallest set of committed images.
3. **Evidence is committed to the repository**, in `docs/design-evidence/<slug>/` (instar) and `design-evidence/<slug>/` (each apps branch family), at most 300 KB per image. The PR body shows a rendered copy; the gate reads only the committed files. *Recommended*, because a script can then verify existence, size and freshness from the merge tree with no network. Cost: repository growth, measured at each rung; folders older than 90 days that no feedback entry cites are removed from the tip of main by a monthly chore.
4. **Day one blocks on evidence and reports on machine checks.** A UI change with no valid evidence folder is refused from the first day on the development agent. Each machine check starts in `report` mode and moves to `block` when it has run on ten real UI changes with every false failure traced and fixed. Existing violations are grandfathered by a ratchet. *Recommended*: the evidence check is deterministic and cheap; the browser checks are new and will have false failures.
5. **Only the owner can override**, by tapping a Work Board card bound to the exact change. Agents cannot. *Recommended*.
6. **Touching a screen clears its owner-earned violations.** A change to a registered screen may leave that screen's grandfathered violations of ordinary rules, and may not leave any violation of a rule marked "Earned from" a feedback entry. *Recommended*: a mistake Justin already pointed out is not grandfathered on a screen someone is editing anyway.
7. **The feedback card's last item is the owner's.** Four items are verified by the server; the fifth, "Justin has seen the fixed screen", is `owner-confirms`: one tap. *Recommended*: he raised it, and his look is the real test. Alternative: the agent certifies and he is told.
8. **Design feedback is detected automatically** by one fast model call on each of the owner's own messages, confirmed by a second call on a stronger tier before a card opens. A wrong card is closed by one owner tap. *Recommended*. Alternative: only the agent raises cards, which is the habit the brief rules out.
9. **`docs/DESIGN-STANDARD.md` is not code-owned.** Adding or sharpening a rule after feedback is the agent's. Changing or retiring a rule that was earned from feedback needs an owner-tapped card. *Recommended*: the loop must not wait for him each time, and his earned rules must not be quietly loosened.
10. **The apps repository's gate does not depend on a GitHub plan change.** It lives in the release scripts, repository hooks and a daily audit. *Recommended*. Alternative: pay for a plan with protected branches, or move the apps to a repository that has them; the same checker would then become a required status.
11. **Native automatic checks are staged: Apple first, Android second, Windows and Linux third.** Until a surface's stage lands, it is covered by evidence, static scans and shared test vectors only. *Recommended*: Apple is where DF-0001 happened and already has a UI test target.
12. **Two new development dependencies:** `playwright-core`, driving the Chrome already installed on verifier machines, and `axe-core` for contrast, names and target size. *Recommended* over writing a contrast engine.
13. **Review rules are answered by a reader who did not write the change:** a subagent on the design model, given the standard and the captures only. Its name and model are recorded. This is self-reported and stated as such. *Recommended*; it is what `DS-DELIGHT-1` and `DS-DELIGHT-5` already ask for.
14. **One constitution article is added.** Approving this spec approves the text. The registry is code-owned, so that one pull request needs Justin's review on GitHub.
15. **Out of this version:** the public website (`site/`) and message wording. Message wording stays with the UX impact lint and the outbound tone gate.
16. **DF-0001 stage, two points beyond the brief.** (a) The web computes a limit's colour from the unrounded percentage and the server from the rounded one, so 89.6% shows "90%" in amber on the web and red in the apps. Stage 1 makes both use the rounded figure that is shown. *Recommended*: `DS-COLOUR-3` says the number and its colour agree. (b) The server lists accounts that need a sign-in first; the web does not. Stage 1 adds the name tie-break only and records the difference on DF-0001 as an open point. *Recommended*: neither screenshot showed an account needing sign-in, so no one has yet decided which order is right.
17. **The UX impact lint's dead path is corrected** from `src/dashboard/` to `dashboard/`, and it keeps its author scope. *Recommended*: a one-line truth fix; widening its scope is a separate decision.

## Open questions

*(none)*

## Proposed design

### 1. What counts as touching a user interface

**The classifier.** `scripts/lib/ui-surface.mjs` exports `classifyUiPath(repoKind, path)`, pure and unit-tested on both sides of every boundary, in the manner of `operator-surface.mjs`. It answers `ui`, `ui-test` or `not-ui`.

| Repository | A path is `ui` when it matches | Never `ui` |
|---|---|---|
| instar | `dashboard/**` and `dashboard-pair/**` (markup, scripts, styles, images, fonts); any file a registered screen lists as a source (below) | `*.test.*`, `*.spec.*`, `dashboard/docs/**`, `site/**` |
| apps, `apple/*` | `InstarApp/**/*.swift` and `InstarMac/**/*.swift` that import SwiftUI, AppKit or UIKit; `**/*.xcassets/**`; `**/*.strings`, `**/*.xcstrings` | `Tests/**`, `scripts/**`, `docs/**` |
| apps, `android/*` | `app/src/main/**/*.kt` containing `@Composable` or under a `ui` package; `app/src/main/res/**` | `app/src/androidTest/**`, `app/src/test/**` |
| apps, `windows/*` | `InstarWindows/App/**/*.xaml`, their code-behind `*.xaml.cs`, and `InstarWindows/App/**/*.cs` that reference `Microsoft.UI.Xaml`; `InstarWindows/App/Assets/**` | `InstarWindows/Tests/**`, `InstarWindows/Core/**` unless a screen lists the file |
| apps, `linux/*` | `src/App/**/*.cs`, `src/App/**/*.axaml`, `src/App/Assets/**` | `test/**`, `tests/**`, `src/Core/**` unless a screen lists the file |

The apps repository's family is read from the branch name, and from a one-line `design-gate.json` at the root of each family when the branch name does not say.

**The screen registry.** `docs/design/screens.json` lists each screen once: an id, a title, its main question (`DS-DELIGHT-1`), and for each surface that shows it, the way to open it (a console route, or a native screen name) and the source files that shape it. The sources may name files the path rules would miss: for the accounts screen, `src/server/mobileCapacityRoutes.ts` and `dashboard/console/accounts-model.js`. This is how the cause of DF-0001's third problem, a sort in a server file, counts as a UI change. Web screens are seeded mechanically from the console's route table; native screens are seeded from each app's navigation list during that surface's stage. The registry is also what answers "does this screen exist on another surface?" for `DS-PARITY-1`.

**How a mis-classified change is caught.**

- **Unknown UI-looking files.** A test walks the tree: any file outside the declared roots whose type or content looks like a screen (`.html`, `.css`, `.xaml`, `.axaml`, a Swift file importing SwiftUI, a Kotlin file with `@Composable`) and that is not on a short written allow-list fails with `ui-path-unclassified`. A new UI folder cannot appear unnoticed.
- **The design lane runs on every change**, not only on changes classed `ui` (section 3). A server change that alters what a registered screen renders is caught by the checks even if no path rule saw it.
- **Feedback closes the hole.** A feedback entry records why the gate missed the problem. If the reason is that the change was not classed as UI, the lint requires that entry to cite the classifier or registry change that fixes it (section 6).

**The exemption: no visible change.** The manifest declares `visibleChange: "none"`. It is verified, not trusted:

- **Web.** The gate itself renders every screen whose sources the change touches, at the standard sizes, at the merge base and at the head, with the same fixtures, the same browser, a fixed clock and animations off, in one run on one machine, and compares the images. No difference: the exemption stands and no captures or checklist are needed. Any difference: `refused:visible-change`, and the full evidence is required. A touched file that belongs to no registered screen cannot use the exemption.
- **Native.** The folder carries a before and an after capture of each affected screen at the Standard size, taken by the capture tool on one machine in one session. The gate recomputes both hashes from the committed files and requires them to be equal. (Git stores identical files once.) This trusts the capture more than the web check does, and is named in "Under-block". It tightens when that surface's checks run in a trusted lane.

### 2. The evidence a change carries

One folder per change, `docs/design-evidence/<slug>/` (instar) or `design-evidence/<slug>/` (apps), written by the capture tool and checked by `scripts/design-evidence-check.mjs`. The pure core takes a file list, file contents and the parsed standard, and returns `{ ok, problems }`; the command-line wrapper reads them from a git tree.

**`manifest.json`:**

```json
{
  "schema": 1,
  "slug": "accounts-usage-fixed-order",
  "visibleChange": "yes",
  "uiTreeHash": "<sha256>",
  "capturedBy": "design-capture@<instar version>",
  "screens": [{
    "id": "capacity-accounts",
    "surface": "web",
    "fixture": "accounts-stress",
    "captures": [
      { "size": "desktop", "theme": "dark", "file": "web-capacity-accounts-desktop-dark.png", "width": 1280, "height": 728, "scale": 1, "sha256": "…" }
    ],
    "parity": [
      { "surface": "mac", "file": "parity-mac-capacity-accounts-default-dark.png", "from": "apple/rebuild-130@<commit>", "sha256": "…" }
    ]
  }],
  "checklist": [
    { "rule": "DS-DATA-1", "result": "pass", "by": "machine" },
    { "rule": "DS-ACTION-3", "result": "not-applicable", "by": "review", "reason": "This screen has no destructive action." },
    { "rule": "DS-PARITY-4", "result": "follow-up", "by": "review", "card": "wc_…" }
  ],
  "review": { "reviewer": "design-review subagent", "model": "<display name>" },
  "override": null
}
```

**What the checker verifies, each with its own problem name:**

1. **The folder exists** for a change that touches a `ui` path, and there is exactly one for the change.
2. **It matches the head.** `uiTreeHash` is a hash over the sorted list of (path, git blob id) of every `ui` file the change touches, relative to the merge base. The checker recomputes it from the head tree. An edit to any of those files after capture makes the evidence stale (`evidence-stale`). A merge from main that does not touch them leaves it valid.
3. **Every affected screen is captured at every required size** (decision 2). The affected screens are those whose registry sources intersect the changed files; a changed `ui` file in no screen's sources must be added to one in the same change, or declared a shared component with the screens it was captured on.
4. **The images are real and the stated size.** Each file exists, is at most 300 KB, hashes to its `sha256`, and its header width and height equal the stated size times the stated scale. For a "smallest window" size, the header dimensions must equal the smallest size the registry records for that surface. Two captures with the same hash at different sizes are refused.
5. **The fixture is a stress fixture.** Each screen names a fixture from the registry. A fixture declares which of the `DS-DELIGHT-6` cases it contains (longest name, largest value, zero, missing value, every optional row, busiest count); a screen's fixture must declare all that apply to its data.
6. **Side-by-side for other surfaces.** For a screen the registry shows on another surface, `parity` holds one capture per other surface: the newest one on record in that surface's evidence, copied into this folder with where it came from. A surface that has never been captured is captured now, or the entry reads `parity-unavailable` with one of two reasons: the screen is not built on that surface yet, or that surface cannot be captured from any pool machine today (with the machine tried).
7. **The checklist is complete.** Every rule in the standard whose Surfaces include a surface of this change has one entry. A `machine` rule's entry is written by the checker from the lane's results and is refused if written by hand. A `review` rule's entry is `pass` or `not-applicable` with a reason of at least one sentence. A parity rule (`DS-PARITY-1` to `5`) may instead be `follow-up` with the id of an open Work Board card for the other surface; the checker asks the server that the card exists. There is no `fail` result: a rule that fails is fixed, or overridden by the owner.
8. **The reviewer is recorded.** `review.reviewer` and `review.model` are present, and the model is a known registry id.

`node scripts/design-capture.mjs --screen <id>` produces the folder for the web: it starts the design harness, captures each size, runs the machine checks and writes the manifest with the machine entries filled. `--render` prints a "## Design evidence" section for the PR body with the images and the checklist. For native surfaces the capture tool wraps what each platform has (section 3).

### 3. Automatic checks

**The harness (web).** `tests/design/harness.ts` serves the real console files and answers their API calls from fixture files (`tests/design/fixtures/<screen>.json`), with a fixed clock. Each registered web screen is loaded at 1280 x 728, 390 x 844, 768 wide and 1440 x 900, in dark, and at one size in light. The same harness is used by the capture tool, the lane and the no-visible-change comparison, so there is one way to render a screen.

**Checks, by rule.**

| Rule | How it is measured |
|---|---|
| `DS-LAYOUT-1` | The document's scroll width is no greater than its client width at every size. |
| `DS-LAYOUT-2` | Every visible element's box lies inside the window and inside its nearest clipping ancestor; content inside a box that scrolls by itself is excluded. |
| `DS-LAYOUT-3` | For elements marked as a bar, width over row width is at least 0.4 at the desktop size; the widest gap between a row's parts is at most 0.2 of its container. |
| `DS-LAYOUT-7`, `DS-ACTION-5`, `DS-DATA-1` | Buttons, statuses and number cells render as one line box and their content width does not exceed their box. Number cells are found by mark, and also by content: a text node that is only a number with an optional unit. |
| `DS-DATA-2` | Number cells sharing a column mark have right edges within 1 px. |
| `DS-DATA-3` | In a marked list, the sequence of row labels, missing rows skipped, is the same in every item. |
| `DS-TYPE-2` | The smallest computed font size of any visible text is at least 12 px. |
| `DS-TYPE-3` | Marked labels start with an upper-case letter or a digit; the shared label table has one entry per meaning. |
| `DS-COLOUR-1`, `DS-COLOUR-2` | `axe-core`'s contrast rule against the element's effective background; where a background is an image or a gradient, the pixels behind the text are sampled from the capture. Run in dark and in light, and on a hovered and a selected row. |
| `DS-ACTION-1` | Every interactive element's box is at least 24 x 24 px at every size, and at least 44 px high at the phone size. |
| `DS-ACTION-6`, `DS-A11Y-2` | `axe-core`'s name rules for buttons, links, fields and images; bars must expose a value as text. |
| `DS-STATE-6` | No image or icon request fails, and every image has a natural width. |
| `DS-WORDS-2` | Rendered text is scanned against the shared internal-terms list (moved to `src/data/design/` so every surface reads one list). |
| `DS-A11Y-1` | The page is rendered at 200% zoom and the `DS-LAYOUT-1`, `2` and `7` checks are run again. |
| `DS-COLOUR-3`, `DS-PARITY-2` | A unit test over the shared boundary vectors (stage 1). |
| `DS-DELIGHT-4` | A static scan of console scripts and styles for fixed colour values and inline styles outside the token and shared-component files. |
| `DS-LAYOUT-6`, `DS-LAYOUT-9`, `DS-DATA-10`, `DS-DATA-11`, `DS-WORDS-5`, `DS-STATE-1` | The dashboard UX standard already designs these as static floors and jsdom tests for the legacy dashboard. This spec does not rebuild them. The coverage map (below) names the test that covers each, or records the rule as staged for the console. |

The marks are a small set of `data-ds` attributes (`num`, `col`, `bar`, `label`, `list`) on the console's shared components. A check that depends on a mark also has a test that the shared component emits it, so a screen cannot escape a check by omitting the mark.

**The coverage map.** `tests/design/coverage.json` has one row per machine rule per surface: the test that checks it, or `staged` with the stage that will add it. The lint fails if a rule marked `machine` in the standard has no row for a surface it applies to. This keeps the table of 27 honest: a rule cannot be called machine-checkable and have nothing behind it without that being written down.

**The ratchet.** `tests/design/baseline.json` records, for each (screen, size, theme, rule), the number of violations on main when the check was first run, with the offending elements listed for the reader. A run fails when a count rises. A run also fails when a count has fallen and the baseline was not lowered in the same change, as the skip ratchet does, so the file only ever goes down. On a screen the change touches, the baseline is treated as zero for every rule marked "Earned from" (decision 6). A web screen with no fixture yet is `grandfathered` in the registry; the number of grandfathered screens has a committed ceiling that can only be lowered, a new console route must be registered with a fixture, and touching a grandfathered screen means registering it, because evidence needs a stress fixture anyway.

**Modes.** Each check has a mode in one code-pinned table, `DESIGN_GATE_MODES`: `report` (failures are printed and recorded, the lane passes) or `block`. Moving a check to `block` is a reviewed change that cites the runs it was judged on (decision 4). There is no environment switch.

**Native apps, staged honestly.**

- **Now, for all four apps (stage 5).** Shared test vectors shipped in the instar package under `src/data/design/`: colour boundaries, the label table, the internal-terms list, a list with ties for the sort rule, and the date forms. Each app's unit tests read them. The Apple family already carries a script for shared desktop-compatibility vectors (`scripts/desktop-compat-vectors.mjs`), so the pattern is not new there. Static scans in the checker for each family: fixed colour values in view code outside the shared components (`DS-DELIGHT-4`), internal terms and label capitals in string literals (`DS-WORDS-2`, `DS-TYPE-3`), fixed font sizes under the floor (`DS-TYPE-2`), referenced assets that do not exist (`DS-STATE-6`).
- **Apple (stage 6).** A design-audit test in the existing `InstarAppUITests` target launches each registered screen with fixture data at the standard sizes (iPhone 390 x 844 and 375 x 667, the largest accessibility text size, and the Mac window at its default and smallest size). From the accessibility tree it reads each element's frame and label: nothing outside the window (`DS-LAYOUT-2`), hit areas of at least 44 pt on iPhone and 28 pt on Mac (`DS-ACTION-1`), non-empty names (`DS-ACTION-6`, `DS-A11Y-2`), marked numbers and buttons one line high (`DS-DATA-1`, `DS-ACTION-5`, `DS-LAYOUT-7`), marked column values sharing a right edge (`DS-DATA-2`), and every text frame larger at the large-text size (`DS-A11Y-1`). Where the platform's own accessibility audit is available to UI tests it is run as well, and its contrast and clipped-text findings are recorded. The same test writes the captures. It runs on the Laptop under the existing one-build lock, so it runs at integration and before a release, not on every commit. Contrast from pixels starts in `report` mode.
- **Android (stage 7).** Compose UI tests with the dependency already present: touch size assertions of 48 dp, bounds inside the root, content descriptions, and single-line layout results for marked text, at 412 x 915, 360 x 640 and font scale 1.3; the platform's accessibility checks are turned on for the test run. Captures come from the same tests.
- **Windows and Linux (stage 8).** Windows through UI Automation bounding rectangles and names; Linux through Avalonia's headless test support. Neither is designed in detail here. Their stage begins with a short design note reviewed on its own, and until then both surfaces are covered by evidence, static scans and vectors only. The coverage map says so for every rule.

### 4. Where the gate runs, and who can pass it

**Instar repository.**

1. **Pre-push** runs `design-evidence-check` against the resolved base. It needs no browser and reads only the tree. It is the early signal; it can be skipped with `--no-verify`, and nothing rests on it.
2. **Local Verify, the floor.** Two additions to the verifier:
   - A fourth gating lane, `design` (`vitest.design.config.ts`, `tests/design/**`), holding the browser checks. The predicate's existing rule applies: a lane with zero tests or any failure refuses the merge. A verifier with no usable browser fails the lane with `browser-unavailable`; it does not skip.
   - One step that runs the evidence checker over the merge tree and writes `designEvidence: { ok, problems, uiTouched, override }` on the verify record. A failing step makes the record's outcome a failure, so the `instar/local-verify` status the ruleset requires is red. `evaluateLocalPredicate` also reads the field: for a record with `uiTouched: true`, anything other than `ok: true` is `refused:design-evidence`, and a record without the field is unmeasurable.
   Because the ruleset's one required status is posted from this record, the evidence check cannot be skipped by merging with plain `gh pr merge`: without it there is no green status.
3. **The Actions floor**, for the cases the local floor does not cover (a fork, a machine with the local floor off). A workflow `design-gate.yml` runs on every pull request, exits at once when no `ui` path is touched, and otherwise runs the same checker and the same lane with a browser. Its context joins `REQUIRED_CONTEXTS_FLOOR` with producer binding. It runs on every pull request because a required context that is path-filtered never reports.
4. **The green-PR watcher** merges through the same floor selection. Stage 3 proves that it refuses a UI change with no evidence, instead of assuming it.

**Apps repository.** There is no continuous integration and no branch protection to stand on, so the gate has three layers, each calling the checker from the installed Instar package (a trusted copy, never the branch under test):

1. **The release scripts refuse.** `ship.sh`, `ship-mac.sh`, `publish-mac-feed.sh`, `play-publish.mjs`, the Windows release scripts and the Linux release script each run `design-gate` first, over every commit since that family's last shipped mark. On success the script writes a tag `shipped/<family>/<build>` and pushes it; the first run takes the current tip as its starting mark. A UI change in that range with no valid evidence stops the release with the list of commits and the command that produces the evidence. This is the layer on the path every build takes to a person.
2. **Hooks carried by the repository.** Each family carries `.githooks/pre-merge-commit` and `.githooks/pre-push`, which run the checker for merges into, and pushes to, that family's integration and main branches. A release script refuses to run in a clone whose `core.hooksPath` is not `.githooks`, so any machine that ships has them on. The integrating session's brief names the same command as its merge step.
3. **A daily audit.** A scheduled job on the development agent, `design-gate-audit`, reads each family's integration branch heads and the instar main branch through the GitHub API, runs the checker over what was merged since its last pass, and compares with the verify records. A UI change that merged with no valid evidence and no override opens a server-written Work Board card naming the commit. This is what finds a skipped hook, an admin merge or a hand-made build whose code was pushed.

**Override.** The only way past a failing gate is the owner's. The agent opens a Work Board card whose `need` states the change (repository, pull request or commit, `uiTreeHash`), the rules to be waived and why. The owner approves it with a tap. The manifest's `override` names the card. The checker asks the server for the card and accepts it only when its approval is valid for the card's current text and that text contains the same `uiTreeHash` and rule ids; an edit to the card or to the screen files voids it. Waived rules are recorded on the verify record, printed in the PR body, and counted in the weekly maturation review. An override waives named rules for one change. It does not waive the evidence folder.

### 5. DF-0001: the server and web changes (build stage 1)

These are small, and they go first because the Apple app session's fix depends on them.

1. **Fixed order.** `usageWindows()` in `src/server/mobileCapacityRoutes.ts` returns limits in the order 5-hour, weekly, Fable weekly, by an explicit rank, not by the order keys happen to be read (a reading with `sevenDay` and `primary` would otherwise put weekly first). The final `wins.sort((a, b) => b.pct - a.pct)` is removed.
2. **The top limit is computed, not assumed.** A new `topWindow(windows)` returns the limit with the highest percentage. It replaces `windows[0]` at the three places that read it: the two notice checks and the account's `top`. `usageLine`, the account's `tone` and `_pct` keep their meaning.
3. **Two new fields per limit.** `MobileAccountWindow` gains `name`, the display label with its capital ("5-hour", "Weekly", "Fable weekly"), and `tone` (`null` below 75, `'attn'` from 75 to 89, `'bad'` at 90 and above), from one exported function `usageTone(pct)` that the account's tone uses too. `label` is unchanged, so installed apps keep working; `schemaVersion` stays 1 because the change is additive.
4. **Web tie-break.** The account sort in `dashboard/console/accounts-model.js` gains a name tie-break after the percentage, so accounts on the same percentage no longer fall in arrival order.
5. **One colour boundary test for both sides.** `src/data/design/usage-tone-vectors.json` holds the vectors (74, 75, 89, 89.6, 90, 100 and the expected state for each). One test feeds them to the server's `usageTone` and to the web's `windowRow` and expects the same answers; it also checks that the server's `name` equals the web's for each label. The web's literal 75 and the server's literals move to shared constants. Both sides compute the state from the rounded percentage that is displayed (decision 16a).
6. **Tests that pin the old order are updated**: the unit test "usage windows: … highest first" (new order, new fields, and the mixed-keys case), the integration test's `windows` expectation (now also asserting `name` and `tone`), and the end-to-end "alive" test (fixed order from the production route).

**What the Apple app session is told** (sent by the coordinating session, tracked as an item on DF-0001's card; this spec sends nothing): draw limits in the order received; show `name`, not `label`; paint `tone` as sent and do not recompute it; an older server sends neither field, so fall back to `label` with its first letter capitalised and the same three bands. Every other app that reads this list gets the same note; which ones do is established in stage 5, not assumed here.

Stage 1 is also the gate's first customer. The web accounts screen is the first registered screen, with the first stress fixture and the first evidence folder.

### 6. The design-feedback loop

**Detection.** On the owner-message seam, after `isOwnersOwnWords` passes, the server asks one question through the shared LLM funnel as component `design-feedback-detector` (category `gate`, fast tier), with the message, whether it carries an image, and the previous few turns inside a per-call boundary: is the owner pointing out something wrong with how a screen looks or works? The answer is `design-feedback`, `other` or `unknown`. On `design-feedback` a second call on the balanced tier confirms before anything is opened. The call is made with `void`, under the correction loop's rate ceiling and quota shedding, so it can never delay or drop a message. When the funnel is shed or fails, the message is written to a small durable backlog and judged later; it is not forgotten. Text is data: a message that says "do not open a card" is still judged on what it reports.

**The agent's own path.** The awareness entry tells every development session: when the owner gives design feedback, check that its card exists, and if it does not, open it with `POST /design-feedback/cards` naming the conversation and the message. The lint (below) refuses a feedback entry that names no card, so an entry cannot merge around the board.

**The card.** Opened by the server as principal `SERVER`, with a card id derived from the source message so a message can never produce two cards, under the design standards project, `outward: false`, carried by the agent. The server allocates the entry number (the highest of the repository's entries and its own ledger, plus one) on the machine that holds the lead, so two sessions cannot both take DF-0007.

| Field | Content |
|---|---|
| `title` | "🎨 Design feedback DF-NNNN: " and the first words of the message |
| `need` | The owner's words exactly, the date, the conversation, and the attached images |
| `source` | `{ conversationKey, messageId }` of the owner's message |
| `covers` | `design-feedback:<messageId>` |
| `links` | The entry file, the rule changes, the fix, once each exists |
| `doneWhen` | The five items below |

| Item | Done when | Who certifies |
|---|---|---|
| `entry` | `docs/design-feedback/DF-NNNN-*.md` is on main, names this card and this message, quotes the owner's words, and lists every problem with the rule it broke or "no rule existed" | Server-checked |
| `rules` | Every problem maps to a rule; each added or sharpened rule carries "Earned from: DF-NNNN"; the standard's changelog has the entry's row; the lint passes on main | Server-checked |
| `fix` | For every surface the entry lists, a change is merged whose evidence folder cites DF-NNNN and whose checklist passes every rule the entry cites | Server-checked |
| `check` | For every cited rule that already existed, the entry names what now catches it: a new machine check, a fixed check, a classifier or registry change, or one sentence on why none is possible | Server-checked |
| `seen` | Justin has looked at the fixed screen; the before and after captures were sent to him | Owner confirms (decision 7) |

**The done condition is enforced, not promised.** A server module, `DesignFeedbackCards`, runs `scripts/design-feedback-status.mjs --entry DF-NNNN` for each open card on a slow cadence and when the card is read. The script is pure over the repository trees it is given (instar main and the apps branches, read through the GitHub read path the green-PR watcher uses). For each server-checked item that holds, the module writes the evidence record itself; an agent's own evidence on those four items is refused `server-checked-item`. `claimDone` then behaves as it does today: `evidence-missing` until all four are verified, and the card closes on the owner's confirmation of the fifth. A card whose message turns out not to be design feedback is closed by the owner's tap; its reason reaches the detector's prompt as a lesson, as "Not important" reasons do for other cards.

**The lint.** `scripts/design-standard-lint.mjs`, pure, run as a unit test (so it is in the unit lane on every change), at pre-commit when the standard or an entry is staged, and by the verifier with the merge base. It reads the standard through the same parser the checker uses.

1. Every rule has an id of the right form, every required field, and a Check of `machine` or `review`. Ids are unique.
2. The "machine-checkable rules at a glance" table lists exactly the rules whose Check is `machine`.
3. **Ids are permanent.** `docs/design/rule-ids.lock.json` lists every id ever issued. The standard must contain every locked id, as a rule or marked Retired; with a base, the lock at the head must contain the lock at the base.
4. **Rule to entry, both ways.** Each "Earned from: DF-N" on a rule appears in entry DF-N's "Rules this entry added or sharpened" table, and each row of that table has the matching mark on the rule.
5. **Every problem maps to a rule.** Each numbered problem in an entry cites at least one existing rule id, or says no rule existed and names the rule added.
6. **The changelog is complete.** Each entry that added or sharpened rules has one changelog row naming exactly those rules, and every rule appears in at least one row.
7. **Earned rules are not loosened.** With a base: if the Rule line of an earned rule changed, or the rule was retired, the changelog row for that change must cite a newer feedback entry or an owner-approved card, checked as an override is (decision 9).
8. **Entry header.** Each entry has the Card and Source message rows, the owner's words as a quotation, and media files that exist. DF-0001 gains the two rows in stage 4, with a card opened for it from its original message.
9. **Gate misses are closed.** An entry's "why it was not caught" line that names the gate (not classed as UI, no check, baseline) must cite the change that fixes it.
10. **Machine rules are covered.** The coverage map has a row for every machine rule and surface (section 3).

### 7. Reaching every agent and every development session

| Change | Path |
|---|---|
| Classifier, checker, lint, capture tool, shared vectors | `scripts/` and `src/data/design/` ship in the package, so every machine with Instar has the trusted copy the apps repository calls. |
| Design lane, record field, predicate change, Actions workflow, floor constant | Code in the release. Harness changes carry the independent review the predicate requires. |
| Detector, card module, `POST /design-feedback/cards`, `GET /design-feedback` | Code in the release, behind `resolveDevAgentGate`. With the gate off the routes answer 503 and nothing listens on the seam. |
| Agent awareness | One entry, `src/data/awareness/design-standard-gate.md`: any change to an Instar screen needs its evidence folder, made with the capture command; where the standard and the registry are; design feedback from the owner is a card with an entry, never only a reply; a failing gate is fixed or taken to the owner as an override card, never worked around. Awareness entries need no migration. A `GET /design-feedback` row joins the Registry First table for "what design feedback is open?". |
| `/instar-dev` and `/build` | Each gains one step before the commit phase: if the change touches a UI path, run the capture tool, have the reviewer answer the checklist, commit the folder. Both skills ship in the package (`skills/`, `.claude/skills/build`). How a wording change reaches a copy already installed was not read for these two skills; stage 4 uses the update path each one already has, or adds an idempotent migration that skips customised copies, as Migration Parity requires. The step repeats what the gate enforces, so a session that never reads it is still stopped. |
| Side-effects artifact template | The operator-surface section points to the evidence folder instead of a prose attestation. |
| Apps repository sessions | Each family gets `.githooks/`, `design-gate.json` and a `DESIGN-GATE.md` of ten lines; the shared build brief names the command. The release scripts' refusal message is the last teacher: it prints the missing evidence and the command that makes it. |
| Constitution article | The 2.0 rule book first, then the registry article, each pull request naming the other; `scripts/check-constitution-pairing.mjs` passes for the pair. |

No setting is added. The modes table and the dev-agent gate are the only switches.

## Verify the state, not its symbol

| What is claimed | Symbol read | State it stands for | Corroboration | When it cannot be measured |
|---|---|---|---|---|
| These captures show the code being merged | `uiTreeHash` in the manifest | The screen files at the head are the ones that were captured | The gate recomputes the hash from the head tree; for the web, the lane renders the head itself | Hash differs: `evidence-stale`, refused. Native: the picture's content is not re-rendered by the gate (see Under-block) |
| The capture is at the standard size | Width and height in the image header | The screen was rendered at that size | Stated size times stated scale must equal the header; hash must match the manifest | Unreadable image: refused |
| Nothing visible changed | Image equality of base and head renders | The change does not alter any registered screen | Web: rendered by the gate in one run. Native: two committed captures | A touched file in no registered screen: exemption refused |
| A machine rule passes | The lane's result for that rule | The rendered screen satisfies it at every standard size | Each check has a negative control proving it fails on a violating fixture | No browser, no fixture, no test: lane failure, never a pass |
| A review rule passes | The checklist entry and the recorded reviewer | A reader other than the author answered the rule's question from the captures | Self-reported; the owner's own look on feedback cards; the audit of entries ("why was it not caught") | Not corroborated by code. Stated, not hidden |
| The owner agreed to an exception | A valid approval on a card whose text holds the hash and the rules | A person tapped yes to this exact change | The tap route accepts only a PIN or a phone presence signature; a later edit voids it | Card unreadable: refused |
| This feedback is fully handled | Server-written evidence on four card items | Entry on main, rules linked, fix merged with passing evidence, check added | The status script reads the trees; the lint passes on main | A tree that cannot be read leaves the item unverified and the card open |
| A screen exists on another surface | The registry's surface list | The same data is shown there | Seeded from each app's navigation; an entry whose problem was a missed parity adds the registry row | An unregistered native screen has no parity requirement until its surface's stage |

## Multi-machine posture

- **Standard, registry, classifier, checker, lint, baseline, coverage map: `unified`.** Git-tracked or shipped in the package.
- **Design-feedback cards and override cards: `unified`.** They are Work Board records in the replicated store. The detector runs on the machine that logs the owner's message. Entry numbers are allocated on the machine that holds the lead; a machine that does not hold it forwards the request, and when the holder cannot be reached the card opens without a number and takes one when it can.
- **Verify records: as Local Verify has them today.** The new field travels with the record.
- **Whether a machine can run the design lane: machine-local by design.**
  machine-local-justification: physical-toolchain-locality. The lane needs a browser binary on that disk, and the Apple checks need Xcode, which the Studio does not have and the Laptop does. A verifier with no browser fails the lane by name; Local Verify's existing helper-machine path is how the work reaches a machine that has one.
- **Apps release gate.** Runs on whichever machine ships that family, using that machine's installed Instar. A machine whose Instar is older than the checker's first release refuses to ship UI changes and says to update.
- **Audit job.** One machine runs it (the lead); its cursor is a replicated record, so a takeover continues from the last audited commit instead of starting over.
- **Holds go only to the session that is merging or shipping.** The only operator-facing items are override cards the agent chose to raise, audit cards, and the one confirmation on each feedback card.
- **Single machine:** everything works with no peer.

## Decision points touched

| Decision | Kind |
|---|---|
| Is this path a user-interface file? | invariant; basis: enumerable-domain; evidence: the path rules and the registry's source lists are closed lists, and a file that looks like a screen and is in neither fails the tree test |
| Does this change need evidence? | invariant; basis: enumerable-domain; evidence: the changed files either include a `ui` path or do not |
| Is the evidence for this version? | invariant; basis: enumerable-domain; evidence: the recomputed fingerprint equals the recorded one or does not |
| Did anything visible change? | invariant; basis: enumerable-domain; evidence: the base and head images are equal or not; the exemption is unavailable where no render exists |
| Does a machine rule pass? | invariant; basis: enumerable-domain; evidence: each check is a measurement with a stated threshold from the standard; the baseline comparison is a count against a recorded count |
| Does a review rule pass? | judgment-candidate. Floor: every applicable rule must have an entry, a not-applicable needs a reason, machine rules cannot be hand-filled; arbiter: a reviewer subagent on the design model that did not write the change; unknown is not a result |
| Is a rule not applicable to this screen? | judgment-candidate. Floor: only `review` rules; a reason of at least a sentence; counted per rule in the maturation review so a rule that is always "not applicable" is noticed; arbiter: the same reviewer |
| May this change merge with a rule failing? | invariant; basis: irreversible-consequence; evidence: a shipped screen reaches people; only a person's tap bound to the exact change passes it |
| Is this owner message design feedback? | judgment-candidate. Floor: only the owner's own words; outcomes are open a card or do nothing; never delays or drops a message; shed or failed calls go to a durable backlog; ladder: fast tier, confirmed on the balanced tier, `unknown` leaves the agent's own path; arbiter: the design-feedback detector |
| Is a feedback card done? | invariant; basis: enumerable-domain; evidence: four items are pure functions of repository trees and the fifth is a person's tap |
| Was an earned rule loosened? | invariant; basis: enumerable-domain; evidence: the Rule line at the head equals the base or does not; any difference needs a newer entry or an owner card. Whether the change is a sharpening or a loosening is not judged by code |
| Should a check block yet? | judgment-candidate. Floor: a check moves from `report` to `block` only by a reviewed change citing ten real runs with every false failure traced; arbiter: the maturation review |
| Which surfaces show the same screen? | invariant; basis: enumerable-domain; evidence: the registry's list |

## Over-block and under-block

- **Over-block.** A change to a dashboard file that alters nothing visible must still declare `visibleChange: "none"`; the gate does the comparison, so the cost is one line. A change to a grandfathered screen must first give it a fixture; that is real work and is the intended ratchet. A browser check can be wrong (a contrast reading through a gradient, a number cell found by content that is not a number); that is why every check starts in `report` mode and why false failures are traced before it blocks. The detector can open a card for a remark that was not feedback; the owner closes it with one tap, the false cards are counted, and each one is traced. Parity can require a capture from a surface no pool machine can build today; the checker accepts `parity-unavailable` with the machine that was tried.
- **Under-block.** Native captures are trusted as taken: the gate verifies their size, freshness and hash, and until that surface's checks run in a trusted lane it does not re-render them. Review-rule answers are self-reported by a reviewer the session started. The count ratchet passes a change that fixes one violation and adds another of the same rule on the same screen; the listed elements make this visible to a reader and nothing blocks it. A screen not yet in the registry has no parity requirement and no machine checks. An evidence folder stays valid when main changes a shared component under it, because its fingerprint covers only the files the change touched; for the web the lane re-renders at the merge head and catches a regression, for native nothing does until the next capture. An admin merge, a skipped hook or a hand-made build passes at the time and is found by the audit within a day, if the code was pushed. A design problem the owner mentions on a channel with no owner-message seam is caught only by the agent's own path. The first run of each apps family grandfathers everything before its starting mark.
- **Cost.** The design lane adds a browser run to every verify. Its duration is measured at each rung and reported beside the other lanes. The detector adds one fast call per owner message and one stronger call per suspected feedback. Committed images grow the repository; growth per month is a line in the maturation review.

## Maturation plan

- **test-agent-live:** each build stage is proven first on a throwaway agent and a throwaway clone of each repository: a UI pull request with no evidence, with stale evidence, with a wrong-sized image, with a hand-filled machine entry, with a false no-visible-change claim, with a valid owner override and with a forged one; a release script run over a range with and without evidence; a detector run on real past owner messages including DF-0001's, and on messages that mention a screen without criticising it.
- **dev-agent-live:** then on the development agent (today Echo) with real UI changes and Justin's real feedback. The DF-0001 fix on every surface is the first full pass through the loop.
- **fleet:** the checker, vectors and awareness text reach every agent through the normal update. The gate and the detector stay on the development agent only (decision 1); no fleet turn-on is planned in this version.
- **graduation criterion:** decided by the existing maturation review over real use. Each machine check moves to `block` on its own evidence (ten real UI changes, every false failure traced). The loop as a whole is judged on: every piece of owner design feedback since stage 4 has a card and an entry; every closed card closed on verified items; the number of times Justin pointed out a mistake that an existing rule already covered, with each traced to a check that was then added; false cards and false refusals, each traced; overrides, each listed; baseline counts per rule, which must fall; the lane's added verify time; repository growth. Missing evidence records `incomplete`, never a pass. No minimum duration.
- **dark-window:** not applicable to the fleet (no fleet turn-on). On the development agent, each check's `report` period is its dark window.
- **ladder:** not applicable: no flag of its own until the stage 2 change adds the design-standard-gate entry, gated by developmentAgent, and points this line at it
- **Owner:** Echo.

The north-star measure is the one in the criterion: **how often the owner points out something a rule already covered.** That number going to zero is what "we no longer make those mistakes" means.

## Build stages with live proof

1. **DF-0001 server and web.** Section 5. Proof: the unit, integration and end-to-end tests named there; the shared boundary test failing when either side's threshold is changed; a live read of `/mobile/accounts` on a throwaway agent showing fixed order, `name` and `tone`, with an older app build still drawing its list; the web accounts page captured at the standard sizes with the stress fixture, side by side with the Mac capture from the entry.
2. **Parser, classifier, registry, evidence checker, lint, capture tool for the web.** Proof: the checker refuses each case in the test-agent list with its own problem name; the lint fails on a removed rule id, a missing "Earned from", an incomplete changelog row and a problem with no rule; DF-0001 and the current standard pass unchanged.
3. **Design lane, ratchet, verify-record field, predicate, Actions workflow, pre-push.** Proof on a throwaway repository with the local floor on: a UI pull request with no evidence cannot reach a green `instar/local-verify`; `gh pr merge` without safe-merge is refused by the ruleset; the green-PR watcher refuses it; a verifier with no browser fails the lane by name; the baseline refuses a new violation and a stale high count; each check fails on its negative control.
4. **Design-feedback detector, card module, routes, status script, awareness, skill steps.** Proof through real Telegram on a throwaway agent, then Slack and an app conversation: a design remark with a screenshot opens exactly one card; the same message redelivered opens none; a non-design remark opens none; a forwarded message and a team member's message open none; the card cannot be claimed done until each item verifies; an agent's evidence on a server-checked item is refused; the owner's "not design feedback" tap closes it. A channel with no seam is recorded as a gap with its own follow-up card. DF-0001 gets its card.
5. **Apps repository: shared vectors, static scans, hooks, release-script gate, audit job.** Proof per family: a release script run over a range holding a UI change without evidence stops; with evidence it proceeds and writes its mark; a clone without the hooks path cannot ship; the audit opens a card for a UI commit pushed around the hooks.
6. **Apple automatic checks and captures.** Proof on the Laptop under the build lock: the design-audit test reproduces DF-0001's wrapped "100%" and short bar on the old Mac screen and passes on the fixed one, at every standard size.
7. **Android automatic checks and captures.**
8. **Windows and Linux**, each after its own reviewed design note.
9. **Constitution article**, both books.

Each stage ships unit, integration and end-to-end tests under the Testing Integrity Standard, with both sides of every decision row above, and wiring checks for the detector, the card module and the record field.

## Rollback

The fast rollback is a reviewed change to `DESIGN_GATE_MODES` setting every check to `report` and the evidence check to `report`: the lane and the checker still run and record, nothing refuses. The detector and cards are turned off by the same release setting their gate off; open cards stay on the board and can be closed by hand. Stage 1's fields are additive and are not rolled back with the gate; reverting them means restoring the old sort, which older and newer apps both accept. Evidence folders, the baseline and the lock file are inert without the code that reads them. A full revert of the lane must ship with the removal of `tests/design/**` from the tree, or those files become unlaned and fail every verify. In the apps repository, removing the `design-gate` line from a release script is the rollback, and the audit reports that it happened.

## Out of scope

- Other agents' own projects (decision 1). The checker and the standard's format are written so a later version can point them at another repository.
- The public website, and the wording of messages and notices (decision 15).
- Deciding what good design is. That is `docs/DESIGN-STANDARD.md`; this spec only makes it apply.
- Pixel-perfect visual regression against golden images. The gate compares images only to verify a no-visible-change claim.
- The native side of the DF-0001 fix, which the Apple app session is building. This spec provides what it reads and the gate its change must pass.
- A GitHub plan change or a continuous-integration service for the apps repository (decision 10).
- Rewriting the legacy dashboard's existing floors and tests. They are mapped, not replaced.

## Constitution wording

One article. The 2.0 rule book (the master) receives the same obligation in its own form first; the 1.x Standards Registry article, placed under *Operator-Surface Quality*, reads:

> ### Design Mistakes Become Rules; Screens Are Shown Against the Rules Before They Merge
> **Rule.** Every design mistake the owner points out is diagnosed in writing, naming the practice that was broken, and becomes a rule in the Design Standard or sharpens one; the feedback, the diagnosis, the rule and the fix are linked by a tracked card that cannot close until each exists. Every change to a screen on any surface shows that screen at the standard sizes, with realistic data, and a checklist of the applicable rules, before it merges. Rules that can be measured are measured by machine.
> **Fails.** A screen change with no evidence, with evidence from another version, or with an image that is not the stated size, does not merge and does not ship. A check that cannot run fails by name; it never passes blind. Only the owner can let a change through with a rule failing, by a tap bound to that exact change, and each such tap is recorded. Existing violations are grandfathered by a count that can only fall, and never for a rule the owner's feedback earned on a screen that is being changed.
> **In practice.** `docs/DESIGN-STANDARD.md` is the one standard and its rule ids are permanent. A change that touches a user-interface path carries a `design-evidence` folder that the merge floor verifies; the design lane runs the machine checks in a real browser; the app release scripts refuse a range with ungated screen changes; a daily audit finds anything that went around. Owner design feedback opens a Work Board card whose first four items the server verifies from the repository and whose last is the owner's look.
> **Earned from.** 2026-11-21: the owner compared the Mac app's accounts screen with the web dashboard's and found the Mac one clearly worse. The diagnosis found fifteen problems; for twelve no rule existed, and the rest were covered by a rule that applied to the web only. The existing quality standard already said a pull request names the screens that were loaded and at which widths, and nothing checked it.
> **Traces to the goal.** A coherent agent does not make its person point out the same kind of mistake twice, and does not ask them to look at a screen it has not looked at itself.
> **Applied through.** `scripts/lib/ui-surface.mjs`; `scripts/design-evidence-check.mjs`; the `design` lane of Local Verify; `scripts/design-standard-lint.mjs`; `DesignFeedbackCards`; `docs/specs/design-standard-enforcement.md`. **Parent principle:** *Structure beats Willpower*.

## Constitution alignment

- **Structure beats Willpower (parent).** A paragraph in a standard and a line in a quality checklist are replaced by a lane, a record field, a refusing release script and a card with verified items.
- **Verify the State, Not Its Symbol.** Evidence is bound to file fingerprints and image headers; the no-visible-change claim is checked by rendering; each remaining symbol is declared with its unmeasurable case.
- **Signal vs. Authority; Judgment Within Floors.** Lane results, the manifest and the detector's answer are signals. The merge predicate holds the authority for merging, the owner's tap for exceptions, and two judgments (review rules, design feedback) sit inside stated floors.
- **Intelligent Prompts: An LLM Gate Must Not String-Match.** Whether a message is design feedback is judged by meaning. Path rules and measurements are not meaning judgments and are done by code.
- **No Silent Degradation to Brittle Fallback.** No browser, no fixture and an unreadable card are each a named failure. A shed detector call is queued, not dropped.
- **Counts are signals, not gates.** The ratchet refuses a rise against a recorded baseline; moving a check to blocking is a judgment on traced runs, not a threshold reached.
- **Close the Loop.** Feedback is a card from the moment it is heard; the audit re-surfaces anything that went around the gate.
- **Agent Proposes, Operator Approves; Approval Only Where Required.** The owner is asked for the constitution article, for overrides, and for one look at each fix he asked for. Rules, entries, fixes and evidence are the agent's.
- **Updates never restrict existing agents.** Nothing here holds any agent but the development agent.
- **Cross-Machine Coherence; Migration Parity; Agent Awareness.** Stated in "Multi-machine posture" and section 7.
- **One Constitution, Two Books Aligned.** The article lands in both books, master first.
- **Occam's Razor.** One parser, one classifier, one checker and one lane serve the pre-push hook, the verifier, the Actions workflow, the apps release scripts, the audit and the feedback card. Nothing is added to GitHub that the local floor does not need, and no setting is added.
