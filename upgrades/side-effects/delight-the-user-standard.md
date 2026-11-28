# Side-Effects Review — Delight the User (constitutional standard + commit gate)

**Version / slug:** `delight-the-user-standard`
**Date:** `2026-11-18`
**Author:** `echo (instar-dev agent)`
**Second-pass reviewer:** `independent subagent (see Second-pass review)`

## Summary of the change

Adds the RATIFIED constitutional article *Delight the User* to `docs/STANDARDS-REGISTRY.md` as a tree node under *Operator-Surface Quality* (which now acknowledges it; the generated hierarchy block is regenerated). Adds its enforcement to the instar-dev commit gate: `scripts/instar-dev-precommit.js` puts screen files in scope (`inScope()` → `isUserFacingSurfaceFile`) and runs a new `assertDelightTheUser` on both pass paths; the pure checks are `scripts/lib/delight-the-user.mjs`. The side-effects template gains §6c. Tests: `tests/unit/delight-the-user-gate.test.ts`, `tests/unit/delight-the-user-precommit.test.ts`; `tests/unit/standards-coverage-ratchet.test.ts` moves its live article count 100 → 101. Spec: `docs/specs/delight-the-user-standard.md`. Ratification: Justin, topic 134088, "yes" 2026-11-18 20:12 PST [source: telegram 134088/145506 2026-11-19T04:12:03Z] to the article proposed in 134088/145500.

## Decision-point inventory

- `isUserFacingSurfaceFile` — add — which staged files are screens (fixed path list).
- `inScope()` in the precommit — modify — screen files now require a trace.
- `assertDelightTheUser` / `artifactAnswersDelight` — add — blocks a screen commit (deletions included) whose artifact lacks a delight answer or screenshot pairs (or a reasoned attestation); pictures must exist, open, and differ within a pair.
- `secondPassReviewedScreenshots` — add — for a change that moves something on screen, requires a concurring second-pass record (the shared `secondPassConcurred` / `secondPassReviewerNamed`) whose section names each picture.
- `artifactAddressesOperatorSurfaceQuality` — modify — with the template supplied, a §6b heading must be followed by the author's own words (an unanswered template copy no longer passes).

---

## 1. Over-block

Every screen-only commit (including image/font-only and deletions) now needs a Tier-1 bundle (ELI16 + side-effects + trace), and one that moves something on screen also needs a recorded second-pass review naming the pictures. That is the ratified rule ("every screen change reviewed against before/after screenshots"), not an accident. Branches in flight that touch only screen files meet the gate on their next commit. A data-only edit inside a screen file pays one written sentence plus "Screenshots: no visible change — <reason>". An image-only re-encode pays the same. The reason and the answer have no length floor (two earlier floors were refuted by short legitimate answers in review), so a terse honest answer is never refused; only empty text and bare placeholders are.

## 2. Under-block

- The second-pass record is self-attested by the committing session (the shared helpers' own docblock says so); it binds the record to the pictures by name but does not prove a second reader looked. "No visible change" skips it.
- A §6b answered "no" passes (reading a reported failure in free text is a meaning judgment).
- The gate cannot judge the answer's honesty, whether a picture is the right screen, whether a re-saved copy is really a new picture, whether a link opens, or whether each touched screen got its pair. The change's independent review and the person hold that.
- Screens rendered from strings in `src/server/` (other than approval and secret-drop pages) are not matched.
- `scripts/decision-audit-presence-check.mjs` (the PR-boundary check) keeps its own scope list, so a `--no-verify` screen-only commit is not detected at the PR boundary. Widening it would refuse in-flight screen-only PRs whose commits predate decision records for screen files.
- The native apps (`apps/instar-ios`, `apps/instar-android`) have no gate; the article says so.
- Screenshots kept only in a scratch folder cannot be opened by a reviewer on another machine; the template asks authors to attach them to the PR.

## 3. Level-of-abstraction fit

Right layer: the same commit-time side-effects gate that already holds Operator-Surface Quality, Agent Proposes/Operator Approves and framework generality. It sits next to `assertOperatorSurfaceQuality` and reuses its artifact resolution. A CI image-diff would be a different, heavier instrument and still could not judge delight. The existing operator-surface predicate is left unchanged (its tests pin css as not-an-operator-surface); the broader screen predicate is separate.

## 4. Signal vs authority compliance

- [x] No — the gate blocks on the absence of an attestation (a section, own-words text, files that exist and differ), which are exact matches (*Structure Decides Alone Only on an Exact Match*). It never scores taste or reads the pictures. Judgment of the screen stays with the reviewer and the person (`docs/signal-vs-authority.md`).

## 4b. Judgment-point check

The one judgment (does the screen delight) is not made in code; the floor is presence, the arbiter is review. Classified in the spec's `## Decision points touched`.

## 5. Interactions

- Uses the same second-pass helpers as the merge-time `independentReviewProblem`, so a screen commit cannot pass here and fail there on the review record, or the reverse.
- Existing artifacts that kept the template's §6b heading with no answer will now be refused on their next surface commit; answering one line fixes it.
- Shadows nothing; runs after `assertOperatorSurfaceQuality`. A dashboard js/html commit now hits both (6b and 6c), which is intended: floor and bar.
- The operator-surface raw-input scan now also runs on dashboard-only commits (it previously never reached them). That closes the bypass; a dashboard file that asks for raw JSON input will now be refused on a dashboard-only commit too.
- Tier classification counts screen files as in-scope files; a large screen change can now signal a higher tier.
- Merge commits still pass early (MERGE_HEAD check precedes everything).
- Binary assets are staged in scope; the gate's diff-text scans read added text only, and the sandbox test commits a png through the real hook.

## 6. External surfaces

None for installed agents or users: the hook lives only in the instar source repository and ships nothing to the fleet. Other instar developer sessions see the new requirement on their next screen commit. No operator-facing surface is added or changed by this commit (no screen file is staged), so §6b and §6c do not apply to it.

## 6b. Operator-surface quality

No operator surface — not applicable (this commit stages no dashboard, approval or secret-drop file).

## 6c. Delight the user

Not applicable to this commit's own files: it stages no screen file. The gate added here is what asks this question of future screen changes.

- Screenshots: no visible change — this commit changes the constitution, the commit hook and its tests; no screen file is touched

## 7. Multi-machine posture (Cross-Machine Coherence)

machine-local BY DESIGN: a commit-time check in whichever checkout makes the commit; it reads only the staged files and that machine's filesystem and holds no state. Every machine running the same hook applies the same rule. Nothing to replicate, no notices, no URLs.

## 8. Rollback cost

Revert the PR. No state, migration or fleet rollout. The article's text is constitutional and changes only with the operator.

## Conclusion

The ratified article lands with enforcement that is real (sandbox-repo tests drive the actual hook through refusals and passes) and honest about its limits (presence, not taste; no native gate). Screen-only commits are reviewed for the first time, closing the old Operator-Surface Quality bypass. Clear to ship after Justin's code-owner approval on the registry.

## Second-pass review (if required)

Required (the change adds a gate).

**Reviewer:** independent second-pass reviewer subagent (fresh context, read-only), 2026-11-18

Concur with the review. Notes: (1) the `secondPassReviewedScreenshots` docblock said "every After picture" while the code checks both sides; fixed to "every picture". (2) Scope claims hold: screen files in scope, deletions passed on both pass paths, and the raw-input scan now really reaches dashboard-only commits; `isOperatorSurfaceFile` unchanged. (3) Under-block is honest (self-attested record, links compared as text, "no visible change" skips the second reader, PR-boundary check unchanged, no app gate). (4) Signal vs authority holds: presence checks only; the hollow-copy check could refuse only an answer identical to a template line word for word, judged negligible. (5) The sandbox png is fake bytes, which still proves a binary path goes through the hook.

## Evidence pointers

- `tests/unit/delight-the-user-gate.test.ts` — both sides of every check (placeholders, path aliases, identical bytes, unreadable pictures, removed/new screens, pair counts, second-pass naming incl. shared and nested file names), the untouched template as a negative control, wiring on both pass paths and the scope change.
- `tests/unit/operator-surface-gate.test.ts` — the §6b hollow-copy cases added; existing cases unchanged.
- `tests/unit/delight-the-user-precommit.test.ts` — the real hook in a sandbox repo: screen-only commit without a trace refused; no §6c refused; missing screenshot refused; css-only and image-only refused without the answer; screenshots without a second reader refused; a review not naming the pictures refused; a deleted screen refused without the answer and passing with "screen removed"; complete reviewed answer passes; "no visible change" passes; non-screen change untouched.
- Registry lints: insertion-placement, tree-parentage (47 relations, bidirectional), code-backreference (71/71), hierarchy `--check` current.

## Pre-queue review (rule 7), 2026-11-27

**Reviewer:** independent pre-queue reviewer, fresh Claude Opus 5.5 helper of the Design Standards session, not the author. Head 74ce1222c against main d66e82bd5a. Verdict: dissent on one item, now fixed.

- Blocking, fixed: `tests/e2e/converging-audit-precommit-report-backing.test.ts` builds its hook sandbox from a fixed file list that lacked `scripts/lib/delight-the-user.mjs`, which the precommit and `operator-surface.mjs` now import, so the hook would fail on load there. The file is added to that list. The other hook sandboxes copy the whole `scripts/lib` folder.
- Description, fixed: the ratchet line now says 102 to 103, the count after merging main.
- Non-blocking, carried on CMT-1998: a Tier-2 trace naming a missing `sideEffectsPath` returns quietly from the delight check, as the §6b check does; a backtick-wrapped "no visible change" line is refused with a misleading message (fails closed); the section finder takes the first matching heading; the Tier-2 hook path is checked by a source grep, not a sandbox run.
