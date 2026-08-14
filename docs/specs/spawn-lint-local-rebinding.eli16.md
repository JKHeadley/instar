# Two more ways past the runaway-process guard, found by trying to break it

> The one-line version: after hardening the check against renamed imports, a peer agent attacked it and got past it twice more — with a plain local variable and with bracket access — and both are closed here.

## The problem in one breath

Earlier today the check that stops an uncapped AI process being created outside its safety limit was hardened: it now works out every local name a class is imported under, instead of matching one literal name.

Then a second agent was asked to break it, and did. Two of the ways past are entirely local to a single file, which is exactly the ground the hardening claimed to cover:

- assign the class to a variable and construct from the variable;
- reach the class out of an imported module with bracket notation instead of a dot.

The first is probably the easiest bypass anyone could write. It was not anticipated.

## What already exists

- **The limit itself** and the single approved path where it is installed.
- **The check**, now aware of renamed imports and dot-qualified module access.
- **A written statement of what it still misses**, which said only that chains crossing module boundaries could slip through.

## What this adds

**A variable holding the class is now treated as the class.** Chains are followed to a fixed point, so assigning it along several times cannot walk out of the set.

**Bracket access is recognised** alongside dot access.

**The written statement of remaining gaps is corrected.** It previously named one kind of miss and there were three: the two above, plus the cross-module chains. Two of the three were inside what the earlier statement implied was covered, so leaving it unchanged would have left a claim on record that was narrower than the truth.

## The safeguards

**Six tests in the opposite direction**, including a new one: assigning some *unrelated* symbol to a variable and constructing from it is not flagged. Without that, a rule that treated every variable as suspicious would pass every bypass test and fail on ordinary code.

**One test pins a gap deliberately left open.** A chain crossing module boundaries still gets past, because this check reads one file at a time and cannot follow a symbol exported onward from somewhere else. That test asserts it is *not* caught — so nobody later mistakes the boundary for an oversight, and if someone closes it properly the test will fail and be updated on purpose.

**The codebase passes cleanly before and after**, so no new work is created for anyone.

## Why it is worth saying who found it

The bypasses were not found by re-reading the fix. They were found by someone else being asked, explicitly, to break it — and told that an evasion would be worth more than a clean report. A review that can only confirm is not a review.
