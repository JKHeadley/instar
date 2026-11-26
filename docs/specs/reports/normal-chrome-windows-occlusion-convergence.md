# Convergence Report — Windows normal-Chrome: occlusion fix and a named blank-page error

## Cross-model review: codex-cli:gpt-6.2-astra

A real GPT-tier pass ran through the agent's codex CLI on all three rounds (verdicts: MINOR ISSUES, SERIOUS ISSUES, MINOR ISSUES). Gemini is not installed on this machine; grok is not enabled.

## ELI10 Overview

On Windows, the agent's browser driver opened Chrome, but pages stayed white whenever another window covered Chrome, because Chrome stops drawing windows it thinks nobody can see. Worse, asking for the page's text quietly returned Chrome's own button labels with a "success" answer. The change starts Chrome with that power-saving behaviour switched off, makes the driver say clearly when a page can't be read (and what to do), warns when it binds to an older Chrome that lacks the fix, and teaches the browser skill about it, including on agents that already have the skill installed.

It matters because an agent that thinks a page is empty makes wrong decisions confidently. The trade-off is small: one extra Chrome launch setting, and `text` now fails (exit 2) on a page that never drew instead of pretending.

## Original vs Converged

- Originally the error said Chrome "is not drawing the page because" of occlusion. After review it reports the two observations (no page document after a recheck; this Chrome lacks the fix) and calls covering windows a known cause, not the proven one.
- Originally the error fired immediately. Now it rechecks once after a second, since a navigation can change the title before the new page's tree appears.
- Originally it told the agent to close Chrome. Now it says to close only a Chrome the agent started; otherwise read a screenshot or use its own profile.
- Originally `text` on a blank tab still returned Chrome UI strings silently. Now it adds a stderr note saying only Chrome's own UI was read.
- The page title (page-supplied) is now stripped of control characters, cut to 80 characters and labelled in the message.
- The skill migration was rebuilt twice: first it appended the note at the end of the file (wrong place); then a "replace whole" branch never fired because the launch row also changed. It is now three anchored edits, and a fixture of the real previous skill text proves an untouched copy ends byte-identical to a fresh install. A Recovery quick list row was added.

## Iteration Summary

| Iteration | Reviewers who flagged | Design findings | Left behind | Spec changes |
|-----------|-----------------------|-----------------|-------------|--------------|
| 1 | internal (all six lenses, one reviewer), codex, conformance gate | 4 (migration placement; recheck before advising a close; neutral wording; don't advise closing a Chrome you didn't start) | 5 | recheck, wording, ownership-aware remedy, title sanitising, migration placement, rollback text |
| 2 | internal, codex, conformance gate | 3 (launch-row drift kept the replace-whole branch dead; state observations not cause; blank-tab text silent) | 3 | three-edit migration + v3 fixture, observation wording, stderr note, recovery row |
| 3 (cap) | internal, codex, conformance gate | 2 accepted at the cap + 1 fixed (stale frontmatter sentence); rollback sentence fixed | 6 | wording fixes only |

Standards-Conformance Gate: ran every round (round 1: 3 flags; round 2: 4 flags; round 3: 4 flags), never degraded.
Internal reviewers: one general-purpose subagent per round covering security, scalability, adversarial, integration, decision-completeness and lessons-aware lenses (proportionate to a Tier-1 change); model: the session model (Opus 5.5).

## Proportion

Tier 1; about 7 source/test/config files plus one fixture, about 250 changed code and test lines; 3 of 3 rounds used. ⚠ At the cap, but rounds 1 and 2 each found a real defect in the migration that tests written from the new text could not catch.

## Left behind

- DESIGN accepted at cap: a page that titles itself "New Tab" (or "about:blank") with no page document still gets `text` exit 0 with Chrome UI strings. Mitigated: `text` now writes a stderr note that only Chrome's own UI was read. Using the omnibox URL to classify blank tabs would close it; low impact (a page can only hide its own blankness). Queued as an improvement: feedback fb-7221d794-3ab.
- DESIGN accepted at cap (gate, Judgment Within Floors): one recheck after one second is a fixed wait. The failure is exit 2 with "wait and retry", so the caller keeps the decision about waiting longer; no harm from a slow page beyond one retry.
- Gate flag (A Decision That Can Block…): the driver stays content-pinned as non-blocking. Its new failure refuses to return wrong data; it gates no message, session or other agent, and find/click already exited 2 when the page document was missing. Reason text in the baseline updated.
- Gate flag (Never Silently Cut…): the 80-character title cut is marked with `...`; the title is only a label in a diagnostic.
- Precision: the flag check matches the token in any `--disable-features`, not only the last one (only a Chrome started outside the driver can have two).
- Precision: `native-drive.ps1`'s header comment lists text/find/editfields only; click, invoke, typeedit and typesecretedit also reach the error. Left as is so the pinned bytes remain the ones run live; the skill text lists all of them.
- Precision: Chrome's built-in PDF viewer may have no accessible Document; unverified.
- Precision: a mixed-line-ending skill file comes out all CRLF after migration.
- Not live-tested: the neutral branch and a Document appearing during the recheck (UI Automation cannot run on Linux CI; static tests only).
- An uncovered-baseline experiment (cover, uncover, re-cover one unflagged Chrome) would separate covering from relaunching; not run because it means moving the operator's own app window. The message no longer claims more than was observed.

## Full Findings Catalog

Round 1 — internal: migration placed note at end of file (DESIGN, fixed); title-change race could advise a needless close (DESIGN, fixed with a recheck); flag-check-not-last-switch (PRECISION, left); English title list / page-titled "New Tab" (PRECISION, caveat added); unescaped title in driver voice (PRECISION, fixed); rollback vague (PRECISION, fixed). Codex: neutral "has no content yet" overclaims (DESIGN, fixed); don't advise closing an attached Chrome of unknown ownership (DESIGN, fixed); "no page-visible effect" overclaims (PRECISION, fixed). Gate: Verify the State (fixed by "likely" then observation wording); Judgment Within Floors on the allowlist (pre-existing, unchanged; not real for this change); blocking-decision classification (accepted, see Left behind).

Round 2 — internal: launch-row change kept the replace-whole branch dead and left migrated copies without the flag sentence (DESIGN, fixed with three anchored edits and a v3 fixture); stale docstring (PRECISION, fixed); PDF viewer (PRECISION, left). Codex: blank/New Tab `text` false success (DESIGN, partly fixed with the stderr note); state observations not cause (DESIGN, fixed); behavioural recheck test (DESIGN, not possible on Linux CI; left as honest limit); "no page-visible effect" (PRECISION, fixed). Gate: one-recheck floor, title as symbol, 80-char cut, blocking classification (see Left behind).

Round 3 — internal: stale frontmatter sentence (DESIGN, fixed); three wording slips (PRECISION, two fixed, header comment left). Codex: page titled "New Tab" (DESIGN, accepted at cap); rollback must also remove the launch sentence (DESIGN, fixed in spec); mechanism vs measurement (PRECISION, wording already reports observations). Gate: same four, plus Migration Parity on rollback (fixed).

## Convergence verdict

Converged at round 3 (the Tier-1 cap). The remaining design findings are not about safety, security or data loss; they are recorded above as accepted risks with reasons. Spec is ready to approve and build; the build was proven live on the Mama PC on 2026-11-19.
