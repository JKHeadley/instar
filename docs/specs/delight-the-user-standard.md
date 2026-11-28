---
title: "Delight the User — a constitutional standard and its commit-time gate"
slug: delight-the-user-standard
status: draft
eli16-overview: delight-the-user-standard.eli16.md
parent-principle: "Operator-Surface Quality"
tracked: CMT-1998
review-convergence: "2026-11-19T04:57:59.060Z"
review-iterations: 6
review-completed-at: "2026-11-19T04:57:59.060Z"
review-report: "docs/specs/reports/delight-the-user-standard-convergence.md"
cross-model-review: "codex-cli:gpt-6.2-astra"
single-run-completable: true
frontloaded-decisions: 4
cheap-to-change-tags: 0
contested-then-cleared: 0
approved: true
approved-by: "Justin, topic 134088, 2026-11-18 20:12 PST: \"yes\" [source: telegram 134088/145506 2026-11-19T04:12:03Z], answering the article proposal 134088/145500 (constitution changes need Justin; he ratified this article and its screenshot-review rule)"
---

# Delight the User — a constitutional standard and its commit-time gate

## Problem

Today the constitution holds Instar's screens to a floor: *Operator-Surface Quality* (a screen leads with its primary action, shows no raw internals, keeps destructive actions quiet, reads plainly, works at phone width) and its subsection *Dashboard UX Standard*, which defines eleven dashboard floors (F1, F2, F9, F10 and F11 have shipped tests; F3–F8 are still listed as pending in that article). A screen can clear every one of those and still be unpleasant to use.

That happened on 2026-11-18 at 20:05 PST (topic 134088). The Work Board card detail in the Mac app was a wall of same-size grey prose. It showed internals ("(wait c5c23e80)", a raw UTC timestamp, markdown escapes, ": not known" fragments) and had tiny buttons, two cut off with "…". Those leaks and cramped controls already break the parent's floor (no raw internals; real tap targets), so the parent was not followed there. The deeper defect broke no written rule at all: every line had the same size, weight and colour, so nothing told the eye where to look first, and nothing in the constitution asked whether a person would enjoy the screen. Justin called it "pretty terrible" and asked for a new constitutional standard: all Instar UI/UX should aim to "delight the user", so people enjoy it from its taste in design alone [source: telegram 134088/145496 2026-11-19T04:05:39Z].

There is a second, structural gap. The existing Operator-Surface Quality assertion in `scripts/instar-dev-precommit.js` runs only after the gate's in-scope check, and that check lists `src/`, `scripts/`, `.husky/` and `skills/` only. A commit that touches only `dashboard/` files exits the gate before any surface question is asked. The screen-quality question therefore never runs on the commits it exists for.

## Ratification

Justin asked for the standard at 20:05 PST [source: telegram 134088/145496 2026-11-19T04:05:39Z]. Echo proposed the article at 20:08 PST: a new article under the existing screen-quality rule; every Instar screen a pleasure to look at and easy to take in at a glance; clear visual hierarchy, one obvious next action, calm spacing and type, no internal ids or raw formatting, polish matched across Mac, iPhone, Android and dashboard; every screen change reviewed against before/after screenshots. The message ended "Reply yes to add the standard." [source: telegram 134088/145500 2026-11-19T04:08:05Z]. Justin replied "yes" at 20:12 PST [source: telegram 134088/145506 2026-11-19T04:12:03Z]; no other yes-or-no question was open in topic 134088 between the two messages (145501 was a status report with no ask, 145503 an acknowledgement). That yes is the approval of this spec's constitutional content; the gate is the enforcement the proposal named ("every screen change reviewed against before/after screenshots").

The attribution ledger (`GET /attribution/trace?q=delight+the+user`) returned no rows for these messages: the ledger has no lineage for them, and two pool machines did not answer. The markers above were read from this agent's Telegram message log (`.instar/telegram-messages.jsonl`, rows 145496, 145500, 145506).

## What changes

1. **A new article, *Delight the User*,** in `docs/STANDARDS-REGISTRY.md` (Interaction), declared as a tree node under *Operator-Surface Quality*, which acknowledges it. The rule names five checks: clear visual hierarchy; one obvious next action; calm spacing and type; no internal ids or raw formatting as content; polish matched across Mac, iPhone, Android and dashboard. Every screen change is reviewed against before and after screenshots. The generated hierarchy block is regenerated.
2. **Screen files become in-scope for the commit gate.** `inScope()` in `scripts/instar-dev-precommit.js` adds `isUserFacingSurfaceFile(file)`. A screen-only commit now needs a trace and a side-effects artifact (Tier 1 at minimum: ELI16 + side-effects), which also closes the bypass described above for the existing Operator-Surface Quality assertion.
3. **A new assertion, `assertDelightTheUser`,** runs on both the Tier-1 and Tier-2 pass paths next to `assertOperatorSurfaceQuality`. Its pure checks live in `scripts/lib/delight-the-user.mjs`:
   - `isUserFacingSurfaceFile(path)` — `dashboard/**` and `dashboard-pair/**` (js, html, css, and the images and fonts they show: png, jpg, svg, webp, gif, ico, woff, woff2), `site/public/**` images and fonts, `site/src/{pages,components,layouts,styles}/**` (astro/css/jsx/tsx), `feedback-front/public/**` (js/html/css), and approval / operator-approval / secret-drop pages anywhere (js/html/ts/css). Tests, specs and markdown are never surfaces. A replaced icon or font changes what a person sees as surely as a stylesheet, so assets count (round 2).
   - `artifactAnswersDelight(content, { root, fileExists, fileIdentity, templateText })` — passes in one of two shapes. (a) One or more `Before:` / `After:` pairs, one pair per screen the change touches, matched in order, plus a written answer in the author's own words. Each side names a screenshot image (png/jpg/jpeg/webp/gif/heic) or an http(s) link; `Before:` may instead read `none — new screen: <reason>` and `After:` may read `none — screen removed: <reason>`, but not both in one pair. The two counts must match, every named local file must exist at commit time, and within a pair the two must not be literally the same: different normalized paths (so `card.png` and `./card.png` are one file) and, for local files, different bytes by sha256. Links are compared as strings and never fetched. (b) `Screenshots: no visible change — <reason>` with no Before/After lines; a section that declares both forms is refused as contradictory. In both shapes an answer or reason passes when it is the author's own words: not empty, not an untouched template line, and not a bare placeholder (n/a, none, tbd, todo, yes, no, ok, fine, good, done, delights, looks good, lgtm, dashes, dots, question marks).
   - `secondPassReviewedScreenshots(content, trace, pairs)` — for a change that moves something on screen (not "no visible change"), the trace must record a concurring second-pass review (`write-trace --second-pass true --reviewer-concurred true`) and the artifact's "Second-pass review" section must name every screenshot it was shown (by file name, or the full link). A screen-only commit takes the Tier-1 lane, which otherwise has no independent reviewer (the precommit's own note on Tier-1 says so), so without this "every screen change is reviewed against before/after screenshots" would mean only that the author attested. The reviewer's conclusion is theirs; the gate checks only that the review is recorded and names the pictures (the path as written always counts; the bare file name counts too unless two pictures share it). The trace and Reviewer checks are the shared `secondPassConcurred` and `secondPassReviewerNamed` from `scripts/lib/instar-dev-trace.mjs`, the same ones the merge-time independent-review check uses, so the two cannot disagree. Those fields and the Reviewer line are written by the committing session (that file's own docblock says they are self-attested): the check makes the review step structural and binds its record to the pictures by name; it does not prove that a second reader looked. The author-independent check is the pull-request review, which today happens for this change (code-owner approval on the registry) but not for most screen PRs, which merge on green.
   - Deleted screen files reach the gate too (`[...staged, ...scopeOnlyPaths]`), so a removed screen is asked for its before picture and `After: none — screen removed: <reason>`.
   - Hashing is safe: `defaultFileIdentity` opens only regular files (a FIFO, `/dev/zero`, a directory or a missing path returns null without being opened), reads in 1 MB chunks, and runs only when both files of a pair exist. Every local picture must open, not only exist: one that cannot be read is refused, including the sole picture of a new or removed screen, so a pair is never assumed different without both reads.
3b. **The parent's §6b check stops passing a hollow copy.** `artifactAddressesOperatorSurfaceQuality` matched the phrase anywhere, and the template's own §6b heading carries the phrase, so an artifact copied from the template and never answered passed. With the template supplied (the gate now supplies it), a §6b heading must be followed by at least one line of the author's own words. A bespoke artifact that names the question in prose without the heading still passes as before. This matters now because every screen-only commit reaches that check for the first time.
4. **The side-effects template** (`skills/instar-dev/templates/side-effects-artifact.md`) gains §6c with the five checks, the screenshot lines and the "no visible change" form.
5. **Tests:** `tests/unit/delight-the-user-gate.test.ts` (both sides of every check, the untouched template as a negative control, wiring) and `tests/unit/delight-the-user-precommit.test.ts` (the real hook in a sandbox repo: screen-only commit without a trace refused; Tier-1 bundle without §6c refused; a missing screenshot refused; a css-only change refused without the answer; a complete answer passes; "no visible change" passes; a non-screen change untouched). `tests/unit/standards-coverage-ratchet.test.ts` moves its live article count 100 → 101 with its source cited.

## The native apps

The Mac, iPhone and Android apps live in separate local repositories (`apps/instar-ios`, `apps/instar-android` in the agent home). This repository's commit gate does not reach them. A search of both repositories and of the agent's skills found no build skill, review checklist or builder-read document to add the checklist to (the iOS repository has ship scripts only; the Android repository has a plan file). The article therefore states plainly that the apps are held by their builders' review against the same five checks and before/after screenshots, and claims no gate there. The matched-polish check asks every change in this repository to say how the other surfaces stay matched. Both external reviews asked for a review prompt inside each app repository. That is real work in a separate repository whose checkout is on another session's branch (`apps/instar-ios` on `echo/ios-project-app-state` on 2026-11-18), so this change does not write there; it is reported to the session that owns the app work (echo-instar-app) as owed, in this change's hand-off message, and the article says no app gate exists until one is built.

## Decision points touched

- **Is a staged file a screen a person sees?** — invariant; basis: enumerable-domain; evidence: the repository's tracked screen locations are a closed list read from `git ls-files` on 2026-11-18 (`dashboard/` 112 js, 7 html, 5 css, 2 png, 2 woff2; `dashboard-pair/` html/css; `site/public` images; `site/src/pages` and `site/src/styles` astro/css; `feedback-front/public/index.html`; approval and secret-drop basenames, the same list the existing operator-surface predicate uses), and a new screen directory is added to the regular expression by a reviewed change.
- **Does the side-effects artifact answer the delight question?** — judgment-candidate; floor: the section exists, carries an answer in the author's own words (not empty, not a placeholder), and names screenshot pairs or a reasoned attestation, and a missing one blocks the commit; arbiter: whether the answer is honest, covers every touched screen, and whether the screen actually delights is judged by the change's independent review, the PR reviewer and the person, never by this predicate.
- **Is a second-pass review recorded for the pictures?** — invariant; basis: enumerable-domain; evidence: the trace's `secondPass` / `reviewerConcurred` fields are set or not, the section names a Reviewer or not, and it contains each picture's name or not; this proves a self-reported record exists, not that a second reader looked, and what the reviewer concluded is theirs.
- **Does a named screenshot exist, and are a pair's two files distinct?** — invariant; basis: enumerable-domain; evidence: a path either resolves to a regular file at commit time or it does not (`fs.statSync(...).isFile()`), two normalized paths are equal or not, two sha256 digests are equal or not; an http(s) link is accepted without fetching. Whether two pictures differ visibly is the reviewer's.
- **Is a screen-only commit in the gate's scope?** — invariant; basis: enumerable-domain; evidence: in-scope is the union of path prefixes in `inScope()`; adding the screen predicate is a fixed set membership.

## Fixed limits

None. Round 1 had a 20-character reason floor and round 2 a 120-character answer floor; each was refuted by a short, complete, legitimate answer ("Renamed CSS class"; "Approve now uses the shared accent and reads first on all platforms. Spacing, type, and labels are unchanged."). The predicate now refuses only emptiness and bare placeholders, and the adequacy of the words is the reviewer's.

## Enforcement choices beyond the ratified text

Justin's yes covers the standard and its review rule ("every screen change reviewed against before/after screenshots"). These are this spec's enforcement design, not his words: the commit is the review point (it is the one place every screen change already passes, and the side-effects artifact is where instar records a change's review); one Before/After pair per touched screen; a recorded second-pass review naming the pictures; refusing pictures that cannot be compared. A screen change spread over several commits pays the review on each commit that moves something on screen.

Screenshots of secret-drop, approval and sign-in pages are taken with inert fixture values only (template §6c), since the pictures are attached to a pull request.

## Left behind

- **A PR-boundary check for screen-only PRs** (round 5, external reviewer): apply `scripts/decision-audit-presence-check.mjs` to screen-only PRs opened after a cutoff, so a skipped local hook cannot merge a screen change with no review record. Not built here: that check runs on every PR at merge, a cutoff by PR creation time is new logic in a merge-time gate, and it deserves its own reviewed change rather than a fifth-round addition to this one. Carried on CMT-1998 and named in this change's hand-off; until it lands, the under-block list above states the gap.
- **An app-repository review prompt** for the native apps (rounds 1–2): carried on CMT-1998 to the session that owns the app work, as **The native apps** says.
- **An explicit pass / fail / not-applicable outcome for §6b** (round 6, external reviewer): would let the parent gate block a reported "fail" without reading prose. It changes the shape of every side-effects artifact's §6b, which is the parent standard's own gate, so it belongs in a change of its own. Carried on CMT-1998 with the parent-sentence item below.
- **Viewport and state labels per pair, checked** (round 6): the template now asks for the same size and state for each pair and for the phone-width pair on a phone layout; checking that structurally was not built, and the second reader holds it.
- **The parent article's overstated "a 'no' blocks" sentence**: constitutional text, carried on CMT-1998 for Justin's wording.

## Signal vs. authority

The gate blocks on the *absence of an attestation*, the same strength as the existing Operator-Surface Quality, Agent-Proposes-Operator-Approves and framework-generality assertions. It never judges taste: it does not look at the screenshots' content or score the answer. That judgment stays with the independent review and the person (`docs/signal-vs-authority.md`; *Structure Decides Alone Only on an Exact Match*: section present, file exists, are exact matches).

## Under-block, stated

- An answer passes when it is the author's own words: "great" or "looks nice" pass the predicate, and only empty text, untouched template lines and the listed placeholders are refused. A template line lightly edited ("1. **Clear visual hierarchy** — yes") counts as words.
- Any two different http(s) strings pass as a pair without being fetched, and two old images already in the repository pass as a pair. The second reader, who must name each picture, is the check on both.
- The second-pass record is self-attested (see 3 above): an author can write a concurring trace and a Reviewer line without a second reader having looked. The record names the pictures, so a false one is a specific, checkable false statement on the record.
- "Screenshots: no visible change" skips the second reader. An author who misclassifies a visible change that way clears the gate with no one looking at the screen. Most instar PRs merge on green with no human review, so nothing downstream catches it either; the attestation's reason is on the record in the artifact for any later reader.
- A §6b answered "no" (the author reports the surface fails a floor) passes the predicate. Telling a reported failure from a pass in free text is a reading of meaning, which *Intelligence Infers, Keywords Only Guard* keeps out of string checks; the second reader and the PR review hold it.
- The parent article's sentence that "a 'no' or an unjustified 'n/a' blocks the commit" still overstates its gate: after 3b, a §6b answered "no" passes the predicate (it is own words). That sentence is constitutional text, so changing it needs the operator. It is carried on CMT-1998 (this change's commitment) and raised in this change's hand-off, so the owner of the commitment brings the corrected wording to Justin.
- The gate cannot tell a good answer from a hollow one, a real screenshot from an unrelated image, a re-saved copy of one picture (different bytes, same image) from a real after picture, a link that does not open, or whether every touched screen got its pair (it checks that pairs are complete, not that they cover each file). Review holds all of that.
- Screenshots kept only on the author's machine (a scratch folder) cannot be opened by a reviewer elsewhere. The template asks the author to keep them where the change's reviewer can open them and to attach them to the pull request; the gate checks only that they exist where the commit is made.
- Screen-producing code outside the listed locations (for example HTML rendered from strings in `src/server/` other than approval and secret-drop pages) is not matched.
- The PR-boundary bypass detector (`scripts/decision-audit-presence-check.mjs`) keeps its own scope list and is not widened in this change: widening it would refuse in-flight screen-only PRs whose commits were made before screen files had decision records. A `--no-verify` screen-only commit is therefore not caught at the PR boundary; the PR's own review is the backstop there.
- The native apps have no gate (see above).

## Over-block, stated

- Every screen-only commit now pays the Tier-1 bundle (ELI16 + side-effects + trace). That is the intended cost: the ratified rule is "every screen change reviewed against before/after screenshots".
- Branches already in flight that touch only screen files will meet the gate on their next commit.
- Data-only edits inside a screen file pay one written reason on the "no visible change" line.
- Asset-only commits (a dashboard or `site/public` image or font) pay the Tier-1 bundle too, plus a second reader when the asset changes what is seen; a lossless re-encode takes "no visible change".
- Every screen commit that changes what is seen now pays a second-pass review. That is the cost of the ratified "reviewed against before/after screenshots".

## Multi-machine posture

machine-local BY DESIGN: a commit-time check that runs in whichever checkout makes the commit, reading only the staged files and the local filesystem. It has no state of its own. Screenshot paths are checked on the committing machine, where the author took them. `machine-local-justification: physical-credential-locality` does not apply and none is claimed; the gate holds no durable state, so there is nothing to replicate, and every machine running the same commit gate applies the same rule.

## Rollback

Revert the PR. No state, no migration, no fleet rollout: the gate exists only in this repository's developer commit hook. The article can be revised only with the operator.

## Maturation plan

- **test-agent-live:** not applicable: a developer commit-time gate in this repository; it runs on the next commit any instar developer makes after merge, with no runtime switch to stage.
- **dev-agent-live:** live for every instar development checkout on merge; the sandbox-repo tests drive the real hook through refused and accepted commits before then.
- **fleet:** not applicable: nothing ships to installed agents; the hook lives only in the instar source repository.
- **graduation criterion:** sampled from merged pull requests in this repository that touch screen files (not from hook records): each carries, in its side-effects artifact, either a complete reviewed Before/After record or a reasoned "no visible change" entry. A merged screen PR with neither is reported as a missing record, separately from any confirmed hook skip. This criterion says nothing about the native apps, which no gate reaches (see The native apps).
- **dark-window:** none; it is never dark.
- **ladder:** not applicable: a developer commit gate with no switch and no staged rollout, a revert undoes it.

## Open questions

*(none)*
