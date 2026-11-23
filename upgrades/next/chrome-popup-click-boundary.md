# Upgrade Guide — Keep Sign-In Actions On The Original Page

<!-- bump: patch -->

## What Changed
Assisted sign-in binds each click to the original browser connection and page. If a popup closes after a mouse release was dispatched, the browser can continue observing only after it confirms that popup is gone and a different live page exists. It never repeats the input. Forms without a submit button are submitted within the same document evaluation that looked for the button, rather than after an unrelated browser error.

## What to Tell Your User
A sign-in popup closing should no longer trigger an extra action on another page. If the browser cannot confirm what happened, the repair still stops and reports the problem.

## Summary of New Capabilities
None. This repairs existing assisted sign-in behavior and preserves its approval and account rules.

## Evidence
Thirty-two focused unit checks and the TypeScript check pass. All nine real-Chrome integration checks and ten selected production lifecycle checks pass, including popup closure and a form without a submit button. Independent source reviews confirmed that neither the fallback nor later mouse events can move to a replacement page. Coordinated full verification remains required before publication.
