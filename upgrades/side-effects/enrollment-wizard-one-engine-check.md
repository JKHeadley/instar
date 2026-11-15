# Side-Effects Review — EnrollmentWizard names the Claude engine once (main lint repair)

## Summary of the change

`src/core/EnrollmentWizard.ts` gains a file-local helper `isClaudeCodeLogin(login)` and its two `login.framework === 'claude-code'` comparisons call it. The file's framework-id literal count returns from 2 to 1, the value in `scripts/framework-name-ratchet-baseline.json`, so `scripts/lint-framework-name-ratchet.mjs` passes on main again. No baseline, test or behaviour change.

## Decision-point inventory

None added or changed. The two existing conditions (skip the already-signed-in completion for non-Claude logins; seed readiness only for a completed Claude login with a config home) evaluate to the same values for every input.

## 1. Over-block

No issue identified. The helper returns exactly `login.framework === 'claude-code'`; the first site was `!==` and is now `!helper`, the second was `===` and is now `helper`.

## 2. Under-block

No issue identified in the code. The ratchet itself is a floor, as its header says: a helper or constant keeps the count down without moving engine logic into an adapter. Here the helper removes a real duplicate; it does not hide a new engine branch.

## 3. Level-of-abstraction fit

The cleaner home for "is this a Claude login" is the adapter tree or `frameworkFacts.ts`. That is a wider change to a sign-in path and does not belong in a repair whose job is to get main passing; the file already held one such literal before today and the baseline records it.

## 4. Signal vs authority compliance

Not applicable: no detector or gate is added. The ratchet (a deterministic CI comparison) is untouched.

## 4b. Judgment-point check (Judgment Within Floors standard)

No judgment point touched.

## 5. Interactions

`PendingLogin` is already imported as a type in this file; the helper takes `Pick<PendingLogin, 'framework'>`, so the nullable second call site keeps its own `login &&` guard. No other file references the helper.

## 6. External surfaces

None. No route, config, message, file or log changes.

## 6b. Operator-surface quality

No operator-facing surface.

## 7. Multi-machine posture (Cross-Machine Coherence)

Not applicable: no state, notice or URL. The sign-in behaviour on every machine is unchanged.

## 8. Rollback cost

Revert the commit; main then fails the ratchet again until the duplicate is removed another way.

## Conclusion

Behaviour-neutral repair of a red main. The cause (a change verified on an older base merging after main gained a new lint) is a test-line gap and is recorded separately as feedback for its own fix.

## Second-pass review

Not required: no gate, sentinel, session-lifecycle or messaging decision is touched, and the change is a mechanical extraction with identical truth tables at both call sites.

## Evidence pointers

- Before, on main 05364c0735: `lint-framework-name-ratchet: FAILED ... grew: 1135 -> 1136 ... src/core/EnrollmentWizard.ts: 1 -> 2`.
- After, this branch: `lint-framework-name-ratchet: clean — 1135 framework-id literal(s) outside the adapters across 148 file(s).`
