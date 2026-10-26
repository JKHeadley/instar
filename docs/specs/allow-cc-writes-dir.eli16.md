# Plain-English overview: an empty folder Claude Code makes is not a jail break

## What this change is

Before a fix from the feedback pipeline is published, a final check looks at the sealed workspace where the fix was written. One rule there says: if a `.claude` settings folder appeared in the workspace, the seal must have been broken, so throw the work away. That folder is removed before the session starts and the session is forbidden to write there, so it should never come back.

On 26 October the pipeline's first two real fixes were both thrown away under that rule. Neither session had touched the folder. The newest Claude Code version, installed overnight, now creates an empty folder named `.claude/.cc-writes` by itself every time its sealed shell runs a command. I reproduced that with a single command in an empty folder.

## What already exists

The seal itself (the sandbox and the permission rules) is unchanged and still blocks every write into `.claude/` from the session's tools. The final check is a second line: it notices if anything got through anyway.

## What is new

- The final check now accepts exactly one harmless shape: an empty `.claude` folder, or one that holds only an empty `.cc-writes` folder. Anything else there still fails the work: a file of any kind, a link, any other folder name, or anything at all inside `.cc-writes`.
- The safety rehearsal that runs before every attempt now applies the same check. If a future Claude Code update starts leaving something new there, the rehearsal fails once and says so, instead of every real fix being quietly thrown away.

## Safeguards

Nothing the session may do is loosened. An empty folder holds no settings, so nothing in it can load or run. The tests cover both sides: the exact empty shape passes, and every variation of it (a file inside, a settings file beside it, a link in place of the folder) still fails. Undoing the change is a plain revert. If the folder can't be inspected at all, that counts as a breach too, never as "no folder".

## What you need to decide

Nothing.
