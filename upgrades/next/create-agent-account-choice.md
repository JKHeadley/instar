<!-- bump: patch -->
## What Changed

Creating an agent now asks which account of the chosen AI to use when one or more are already signed in on the computer. Setup lists them by email, including accounts used by other agents on the same machine, plus "sign in to a different account". The chosen account becomes the new agent's account: shared folders are marked as shared, and a new sign-in gets its own folder. The Mac app answers through the install answers file (`account`), and an app that doesn't answer gets today's behaviour.

## What to Tell Your User

When you create a new agent, you can now choose which Claude or ChatGPT account it uses, including one you already use elsewhere, or sign in to a different one.

## Summary of New Capabilities

- Account choice during `instar install` (`do-account-choice`), with the `account` answers field.
- New account sign-ins go into their own folder; chosen accounts join the new agent's account pool with their identity checked.

## Evidence

63 unit tests in tests/unit/install-accounts.test.ts, install-account-choice.test.ts and install-flow.test.ts.
