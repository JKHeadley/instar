# Side-Effects Review — Keep Sign-In Clicks On Their Original Page

Date: 2026-11-23. Author: Echo. Tier 2. Existing approved specification: docs/specs/assisted-subscription-relogin.md. Companion explanation: docs/specs/assisted-subscription-relogin.eli16.md.

## Decision-point inventory
The browser captures the transport, page target and pipe session before looking up click coordinates. It verifies that scope immediately before each mouse event. A missing button can submit a form only inside the same document evaluation that established the button was missing. A release error is accepted only after the release was actually dispatched and an independent target-list observation confirms that the original page has closed and a different live page is available. This permits observation to continue; it does not declare sign-in successful.

## Over-block
A page or connection change during a click now refuses further input rather than sending it to a replacement page. Ambiguous release errors still fail. This can stop a repair that might otherwise have continued, but preserves its actual error and avoids duplicate or redirected input.

## Under-block
Only a release known to have been dispatched may qualify for closed-target observation. A failed press, failed transport send, still-open original target, absent replacement or failed target-list query cannot qualify. A same-message unrelated error does not cause form submission. No broad error-message matching grants fallback authority.

## Abstraction and signal versus authority
Reference: docs/signal-vs-authority.md. A transport error alone is not proof that the browser completed an action. Actual dispatch plus target closure allows another observation, while the existing snapshot classifier and repair driver retain outcome authority. Form fallback is local to the document lookup, avoiding a second command whose default target could have changed.

## Interactions
The normal Chrome override accepts the same optional inline fallback and retains its Apple Event transport. Public click callers retain their one-argument behavior. Credentials, authenticator ownership, provider classification, approval and consent rules are unchanged. Explicit session and transport checks prevent an old click from following a newly active page.

## External surfaces and multiple machines
This changes browser input during existing assisted sign-in; no new API, permission, installed setting, migration, account selection or user action is introduced. It neither signs in a real account during tests nor reads credentials. TCP and pipe browser modes enforce their corresponding original-target checks on each machine.

## Rollback
Revert this source and its regression tests. No persisted-state migration is required. Reverting restores the broad form fallback and popup-close failure path.

## Evidence and limits
The complete local-claims integration run failed on the existing real-Chrome popup-close case. That log exposed the second fallback error, not the original click error, so it does not prove the exact initial transport failure. Deterministic regression tests exercise actual command dispatch with a scripted transport, including press failures, pre-dispatch failures, replacement transport after coordinate lookup, missing-button detachment, surviving targets and post-release closure. The final focused unit selection passes 32 tests, including actual wrapped JavaScript execution for the normal Mac browser with and without a containing form. The TypeScript check passes. After the final scope changes, all nine real-Chrome integration cases pass, including popup closure and the new missing-button form case. All ten selected production lifecycle checks also pass. The complete suite must be admitted through the shared coordinator at a frozen head; no manual full run or complete-suite pass is claimed.

## Independent review
Two independent source reviews confirmed closure of the missing-button replacement-page fallback and mutable-transport findings. Neither reviewer ran tests or builds. Final artifact review concurred with the source and side-effects analysis and requested updating its stale test evidence; that evidence is corrected above. No further concrete defect was reported.

## Class closure
This correction does not change agent-authored instructions, hooks, skills, configuration or detector policy. The code binds input to its original browser scope rather than relying on a prompt to remember that scope.

## Proportion
Tier 2 because this changes browser input during assisted authentication. The existing converged and approved assisted-subscription-relogin specification supplies the authority boundary. Two source reviewers independently closed concrete scope findings and final artifact review concurred. The patch changes two browser implementations and their focused tests, plus this review and a release note. One intended commit attempt; complete coordinated verification remains required.
