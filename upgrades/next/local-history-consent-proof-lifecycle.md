# Carry verified history approval to the first write check

## What Changed

The dormant confirmation can return a short-lived approval token. The first write check revalidates ownership and the exact reviewed copy request before it accepts that token.

## What to Tell Your User

The test flow now connects Face ID approval to the first write check. Importing real conversation history remains paused.

## Evidence

The signed HTTP fixture passes a confirmed token into a private permit transaction. It covers current ownership, key changes, expiry and refusal to use a committed approval again.
