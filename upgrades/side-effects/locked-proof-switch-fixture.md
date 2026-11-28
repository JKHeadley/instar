# Side-Effects Review — locked-Mac proof: a second throwaway account for the user-switch case

**Version / slug:** `locked-proof-switch-fixture`
**Date:** `2026-11-27`
**Author:** `echo`
**Second-pass reviewer:** `independent subagent review, 2026-11-27 15:34 PT — concur`
**Reviewer:** independent second-pass subagent (fresh context, given the code not the author's conclusion); verdict concur, no blocking defect

## Summary of the change

Tier 1, 2 scripts and 1 test file. `scripts/locked-proof/create-proof-user.sh` and `remove-proof-user.sh` gain a closed `--fixture proof|switch` option. `proof`, the default, is today's `instarproof` with vault key `locked_proof_user_password`, unchanged. `switch` is `instarproofswitch` with `locked_proof_switch_user_password`, the second account that proof case 12.12 switches the console to and back from. No other value names an account, so neither script can be pointed at a real user such as the Mini's Demo account. Create now also refuses, before the password check, unless `dsmemberutil` answers exactly "user is not a member of the group" for admin. Remove refuses before stopping anything in four cases: the console owner cannot be read, the account is on the console, it is not confirmed outside admin, or its full name is not the one create set. Remove also gains the same stand-in hook as create (LOCKED_PROOF_FAKE_BIN), so it is now tested.

## Decision-point inventory

No runtime decision point. These are developer scripts run by hand on the proof Mac.

## 1. Over-block

Remove now also refuses an `instarproof` whose full name is not "Instar proof", or whose admin membership cannot be confirmed. The Mini's current instarproof was made by this script with that name. If it were ever renamed, removal stops with the reason and the account is deleted by hand.

## 2. Under-block

The refusals compare a full name and admin membership. They cannot prove that a same-named standard account with that full name is a throwaway. The closed fixture list is the main protection.

## 3. Level-of-abstraction fit

The account map lives in the two scripts that create and delete the account. The driver keeps `instarproof` as the proof user. The judge already counts any console owner other than instarproof, root or loginwindow as away (lib.mjs consoleRoundTrip), so it needs no change.

## 4. Signal vs authority compliance

Not applicable.

## 5. Interactions

Default behaviour and the vault key are unchanged, and so are the order store, create, clear policies and authenticate. One step is added: the admin check between clearing policies and authenticating.

## 6. External surfaces

One new vault and Bitwarden item, only when someone runs the switch fixture with --execute. Nothing runs at merge.

## 7. Multi-machine posture

Machine-local by design: one proof Mac, run by hand.

## 8. Rollback cost

A git revert. An instarproofswitch already created is removed with `remove-proof-user.sh --fixture switch --execute`. Its vault key is then deleted by the operator-side agent.

## Class-Closure Declaration

unbounded-self-action: closure n/a (negative declaration). Two operator-run scripts that each act once on one fixed account and then exit. No loop, no retry and no self-trigger.

## Second-pass review

**Reviewer:** an independent second-pass subagent (Claude, fresh context, given the code at 4d08b3d5c and not the author's conclusion) read both scripts and ran them against stand-in commands; verdict concur, no blocking defect.

An independent reviewer read 4d08b3d5c and ran both scripts against stand-in commands only. Verdict: concur, no blocking defect. Fixed after review: the admin-refusal message pointed to remove-proof-user.sh, which refuses that same account; it now says a person deletes it by hand. Noted, not changed: "live" means on the console. A switch account still logged in behind fast user switching is stopped and deleted, which is what teardown wants. The full-name parse trims spaces, not tabs, so a tab-indented value refuses, which is the safe direction. A failed existence read exits 0 as "no user", as before this change.
