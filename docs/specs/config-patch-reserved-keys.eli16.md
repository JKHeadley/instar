# Config updates refuse a few special key names — plain-English overview

## What this is

Your agent's settings can be changed through its API. A setting update is merged into the existing settings. Three key names (`__proto__`, `prototype`, `constructor`) are not settings at all; they refer to the inner workings of the programming language, and a merge that followed them could change how the whole program behaves, including switching off a safety brake that normally needs your PIN.

## What changes

An update that contains one of those names anywhere is refused with a plain message, and the agent's other internal merges skip them too. The place where the agent saves individual settings refuses them as well, so no route can slip one in.

## What you would notice

Nothing. No real setting uses these names.

## What you need to decide

Nothing. It is a fix, and a revert fully undoes it.
