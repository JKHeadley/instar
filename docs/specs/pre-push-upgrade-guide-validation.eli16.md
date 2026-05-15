# Pre-Push Upgrade-Guide Validation — ELI16 overview

## The short version

Every time someone pushes a change to instar that's going to ship to all agents, there's supposed to be a small "release notes" file (`upgrades/NEXT.md`) that explains what changed. There's a check at *publish time* — the moment the package goes to npm — that refuses to ship if the release notes are malformed (technical jargon in the user-facing section, no proof of how a bug fix was verified, etc.). That check is good.

The problem: there was a separate check at *push time* (before a pull request can even land) that ran a much smaller subset of the rules. So malformed release notes could slip through push, get merged on main, and then silently fail the publish. The agent that needed to alert someone never did. The release just quietly... didn't happen. We lost two days of merged work that way — including the token ledger we shipped yesterday and today's PromptGate token-burn fix, both of which sat on main for hours-to-days before anyone realized npm wasn't getting them.

## What this change does

Makes the push-time check call the same validator the publish-time check calls. Same rules, same error messages, same outcome — but caught earlier, when the person making the change is still at their computer and can fix it.

The validator already exists as a shared module. The push gate just wasn't using it. Now it does.

## Why it's safe

Pure tightening of an existing pre-push gate. Worst case: a malformed release notes file is caught earlier (good). Best case: malformed release notes are caught BEFORE the silent publish failure (very good). Nothing that previously passed push and publish is newly rejected — the rule set is the same as publish, it's just enforced one step earlier.

## Why it matters

The "silent publish failure" pattern is the same shape as a "bleeding tokens" pattern: something goes wrong, no one notices, the consequences pile up while everything looks fine. The token ledger was the observability for *one* version of that pattern (where are the tokens going?). This fix is the equivalent for releases (did the release actually ship?). Both shrink the time-to-detection from "two days when a human happens to notice" to "immediately, in the workflow that created the problem."

## What you'd see if it goes wrong

Almost nothing. If somehow the new check produced a false positive (rejects a well-formed release notes file), the developer would see the same error message they'd see at publish time, just earlier — they'd fix the wording and re-push. There's no path where the new check breaks something other checks would catch.

## How we know it works

Five integration tests in `tests/unit/pre-push-gate.test.ts` write deliberately-malformed release notes into a scratch directory, run the actual gate script against them, and assert it rejects them with the right error. Three of those are the specific shapes that broke us today (inline code in user-facing text, camelCase config key in user-facing text, missing Evidence section when a fix is claimed). One is a well-formed file that the gate must still accept. All ten tests in the file (the new ones plus the existing scaffolding) pass.
