# Side-Effects Review — Setup never picks an AI account on its own

## Summary of the change

Tier 1: 3 files, about 25 changed lines; one change, one commit attempt. In `accountChoiceStep`, the branch for "resumed while awaiting `do-account-choice`, no answer given" used to return `done`, silently taking the default signed-in folder. Now it returns `awaiting-person` with the account cards and a plain instruction. Origin: Justin, 2026-11-19, topic 143810: "it never asked me to choose a chatgpt account or login. This is a failure. It should NOT just assume and claim an account." (His run used an installer copy, 1.3.1875, that predates the account choice. This removes the remaining path by which any app could still get a silent claim.)

## Decision-point inventory

One install-flow branch: whether to proceed without the person's pick. It now never proceeds without one when accounts exist.

## 1. Over-block

An app from before 17 November resumes without an answer and stays at the step. It shows its generic waiting screen with the new instruction ("update the Instar app"). That person must update the app to finish, instead of getting the default account silently. This is intended: Justin ruled out the silent claim. A terminal-only person resuming without an answers file sees the same instruction. They can answer with `--answers` as before. Current Mac builds (95 and later) always write `account`.

## 2. Under-block

When no account is found, the step still finishes with `done` and goes to sign-in. That is correct, because there is nothing to choose. Whether the Mac's own Instar copy is up to date is the Mac app's job (it refreshes at each setup since build 111, with a 15-second limit). This change covers the case where that refresh fails.

## 3. Level-of-abstraction fit

The change sits in the single pure function that owns the choice. The caller in `install.ts` is unchanged.

## 4. Signal vs authority compliance

No detector or gate. A setup step now waits for the person instead of acting for them, which moves authority to the person.

## 5. Interactions

`door-sign-in` reads `accountConfigHome`. It now only runs after an explicit pick, a new-account answer, or when no account exists. The stale-pick branch is unchanged.

## 6. External surfaces

The instruction text shown at the waiting step is new. Nothing changes on the network or in the config.

## 6b. Operator-surface quality

The text is plain and says what to do next.

## 7. Multi-machine posture

`machine-local-justification: per-install-local-flow`. An install runs on one computer, against that computer's account folders.

## 8. Rollback cost

Revert the commit. No state carries over: install progress files keep the same shape.

## Conclusion

Safe and small. It removes a silent account claim.

## Second-pass review (if required)

Not required. No messaging, session-lifecycle, gate or sentinel authority is involved.
