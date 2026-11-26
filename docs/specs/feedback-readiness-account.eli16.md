# Feedback readiness serving account — plain-English overview

## What this change is

The feedback pipeline has a step called readiness. An approved AI model reads groups of feedback reports and decides which groups are clear enough to become a work item. Until now, that model call always ran on whatever AI account the server was using by default. On the Studio that default is a Codex Pro account with almost no weekly room left (5%). So readiness calls were timing out and the step stalled, even though another signed-in Codex account had plenty of room.

This change lets the operator choose which account readiness runs on, and makes readiness check that account properly before every call.

## What already existed

Feedback triage, the next step, already had an account picker. It looks at the subscription accounts on the machine. It only accepts one that is active, signed in with a subscription login (not an API key), unchanged between two checks, and under 75% of its quota on a fresh live reading. It never relies on a cached number. Readiness did not use this picker at all.

## What is new

- Readiness now uses the same picker and the same checks.
- A new setting, `feedbackFactory.readiness.account`, pins readiness to one named account. When it is set, readiness uses exactly that account if it passes the checks. If it does not, readiness refuses and says why: the account is missing, not signed in or changed, over its limit, or its quota could not be read. It never quietly switches to a different account.
- Without a pin, readiness follows the existing triage setting. `off`, the default everywhere, keeps the old behavior exactly. `observe` notes which account it would have picked but changes nothing. `on` uses the least-used good account.
- The drain status page now says which account served the last readiness call, and whether its sign-in was still the same after the call. If a call was refused, it says why. That lets the operator confirm the right account is in use before turning readiness back on.

## The safeguards, in plain terms

- Nothing about who is allowed to decide changes. The approved readiness record, its model, its batch size and its daily spending cap stay the same. The model-identity check after each call still runs.
- A refusal costs nothing: no spending is reserved and no model is called. The waiting groups simply retry in 15 minutes. A refusal never pauses or revokes the readiness approval, so the operator never has to re-approve anything because of it.
- Account details shown are the account id only. No login file paths, tokens or login ids appear in the status.
- The setting is read on every call, so changing the pin needs no server restart.

## What the reader needs to decide

Nothing for most agents: the default leaves readiness exactly as it was. For the Studio, the operator (or the Chief of Staff for them) chooses whether to pin readiness to the Codex account with room. Once this ships, that is a one-line setting. Then the status page confirms the serving account is that one and verified before readiness ticks resume.
