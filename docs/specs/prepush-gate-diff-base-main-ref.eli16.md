# ELI16 — The pre-push check now measures your PR against main, not your last push

## In plain English

Before you push, instar runs a gate that asks "what files does this change touch?" and enforces
rules (e.g. "if you changed product code, you must include a release note"). To answer "what
files," it compared your branch to *your branch's last pushed version*.

## The problem

When you update a pull request by MERGING the latest main into it (the safe way to resolve
conflicts without force-pushing), that comparison suddenly includes ALL of main's changes too —
hundreds of files that other people already shipped. The gate then yells "you changed 173 files
with no release note!" — none of which are actually yours. The only escape was to set a skip flag,
which is exactly the kind of safety-bypass habit you don't want.

## The fix

The gate now measures your change against **main** (the branch you're merging into) instead of your
last push. That gives your PR's TRUE set of changes whether you pushed normally or merged main in.

## Why it's safe

This comparison can never *hide* a change of yours — by definition it includes everything on your
branch since it split from main. At worst it could show a few extra files (if your branch is built
on another branch), which only makes the gate stricter, never looser. And if a clone has no "main"
to compare against, it falls back to the old behaviour. Proven: the gate's 16 unit tests pass and
the script still parses.
