# Claim-check: absence of data is not "nobody claims these files" — Plain-English Overview

> The one-line version: the tool that warns you when another agent is already editing your files could report a cheerful "all clear" after learning nothing at all, and now it says "I could not check" instead.

## The problem in one breath

Before an agent starts editing files, it can run a claim check that asks GitHub whether any open or recently-merged pull request already touches those same files. The point is to stop two agents rewriting each other's work. But when the GitHub query came back with **no output at all** — no error, just nothing — the tool treated that as "no pull requests touch these files" and printed a green tick. Silence and "nobody is here" looked identical, and the reassuring one was chosen.

## What already exists

- **The claim check itself** — takes a list of files you plan to edit, asks GitHub for open and recent pull requests, and lists any that overlap. Advisory: it prints warnings, it does not stop you.
- **A loud failure path** — if the GitHub command genuinely errors (not installed, no network, not logged in), the tool already says so plainly: *"PR overlap NOT checked; spec scan only."* That part worked correctly.
- **A separate spec scan** — matches keywords against design documents, so even with GitHub unavailable you still get partial information.
- **A strict mode** — used by automation, which exits non-zero when overlaps are found or when the check could not be completed.

## What this adds

**The tool now distinguishes "I asked and the answer was none" from "I asked and got nothing back."** GitHub's JSON mode always returns a real answer — zero results is an empty list, two characters long, never an empty response. So an empty response on an otherwise successful call means the answer never arrived. The tool now treats that as unknown and routes it into the same loud "could not check" message the error path already used, instead of quietly turning it into zero.

Secondary changes:

- The same protection applies to any reply that is not a list at all — a stray object, a bare word, nothing. Previously all of these collapsed into "no claims."
- Both queries are covered, the open pull requests **and** the recently-merged ones. Guarding only the first would have left the identical bug one line lower.
- The check sits at two places: at the boundary that talks to GitHub, and at the point where the answer is consumed — so it holds even when the GitHub call is swapped out, as it is in tests.

## The safeguards

**A genuine "nothing found" still reports success.** This is the important one. A guard that shouted on every run would be useless, and indistinguishable from a correct guard whenever the bug is present. A real empty list still prints the green all-clear, and there is a test that fails if that ever stops being true.

**No new reporting channel.** The existing warning line was already correct and already loud; it simply was never reached on this path. Rather than inventing a second way to complain, absence is routed into the message that was always meant to carry it.

**Advisory stays advisory.** Nothing here blocks a commit or changes an exit code on the normal path. Strict mode continues to refuse to bless a claim space it could not actually see, which it already did for errors and now also does for silence.

## Why it matters

This tool exists to prevent two agents editing the same files at the same time. A false "all clear" is not a cosmetic wart — it is the exact collision the tool was built to prevent, delivered with a green tick and the confidence of a completed check.
