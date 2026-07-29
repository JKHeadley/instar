# ELI16 — one file with the right name let a whole commit off the hook

Rule 3 says code that reads outside state must ship with either a written justification or a "canary" —
a small file that proves the reading still works. The check looked for a canary next to your file.

Except it didn't check "next to". It asked: *is any file in this commit called something-canary?* If
yes, **every** file in the commit was treated as having one. There are eleven canary-named files in the
source tree, so any broad change touching one of them satisfied that half of the rule for everything
else it contained.

It failed silently in the permissive direction — it let things through rather than blocking them — so
nobody ever hit it and complained.

**A second bug was hiding underneath.** The check *did* have a proper "look in the canary folder next to
this file" rule, but it looked one directory too high. It worked for files nested inside an adapter and
missed files sitting directly in one. The sloppy catch-all was quietly covering for it — so removing
the catch-all on its own would have turned a too-weak check into a plainly wrong one.

I only found that because an existing test failed when I tightened the first rule. I had assumed the
test was wrong. It wasn't; it was describing a real folder layout the check couldn't see.

**Both are fixed:** the catch-all now requires the canary to actually be beside the file, and the folder
rule checks both layouts.

The check is now stricter than it was yesterday. That's the point — it was passing things it should
have refused.
