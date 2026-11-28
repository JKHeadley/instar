# A second throwaway account for the locked-Mac proof — Plain-English Overview

## The problem in one breath

One of the locked-Mac proof tests checks what happens when the Mac's screen switches to a different user and then back. That needs a second account to switch to. The only other account on the test Mac runs the demo agent for the App Store review, so it must not be used, and its password isn't stored anywhere anyway.

## What already exists

The proof scripts already create and remove one throwaway account, `instarproof`. Its random password goes into the agent's vault before the account exists, and it is never printed or put on a command line.

## What this adds

Both scripts now take a fixed choice, `--fixture proof` or `--fixture switch`. `proof` is today's account, unchanged, and it stays the default. `switch` is a second throwaway account, `instarproofswitch`, with its own vault entry. No other name can be given, so the scripts can never be pointed at a person's real account.

## The safeguards

- Creating an account now stops unless macOS confirms that the new account is not an administrator.
- Removing an account stops before touching anything when it can't tell who is on the screen, when the account is the one on the screen, when it can't confirm the account isn't an administrator, or when the account's full name isn't the one the script gave it.
- The password handling is unchanged: the vault comes first, and the password is never printed.

## What ships when

The scripts ship now. Nothing creates the account at merge. It is created by hand on the test Mac in its own slot, after the 30 automatic tests pass.

## What you actually need to decide

Nothing.

An independent reviewer checked both scripts and agreed nothing blocks. One message was reworded after review.
