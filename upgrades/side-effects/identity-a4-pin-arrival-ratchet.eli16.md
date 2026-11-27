# The PIN guess limit asks where a request came from — Plain-English Overview

> The one-line version: one check that counts wrong PIN guesses now first asks whether the request came in over the home Wi-Fi, as every "is this the computer itself?" check must; nothing behaves differently.

## The problem in one breath

Instar counts wrong guesses at the owner's PIN (the short number that unlocks the dashboard) so that nobody can keep guessing forever. One part of that counting treats a request coming from the computer itself in a special way. A newer safety rule says every "is this the computer itself?" check must first ask whether the request arrived through the home Wi-Fi door, because a phone on the Wi-Fi is never the computer. The PIN counter was written at the same time as that rule and skipped the question, so the automatic test that enforces the rule failed and blocked the phone-pairing change from merging.

## What already exists

- **The home Wi-Fi door** — a second, separate way into the agent that only a phone on the same Wi-Fi uses, for pairing a first phone. It already labels every request that comes through it, so those requests can never look like they came from the computer.
- **The rule's test** — a check that reads the code and fails if any new "is this the computer?" test forgets to ask about the Wi-Fi door first.
- **The PIN guess counter** — charges each wrong guess to the address it came from, and charges guesses it cannot attribute to one shared allowance.

## What this adds

The PIN guess counter now asks the Wi-Fi-door question before its "is this the computer?" test. Because the door's requests were already labelled, every request gets exactly the same answer as before; the change only makes the rule visible where the rule's test looks for it.

## The safeguards

No setting, stored data or upgrade step changes. Undoing the change is a plain revert. The rule's test passes again, and the existing PIN tests (53 of them) still pass.
