# componentFrameworks Load Fix — ELI16

## What this fixes

instar has a feature that lets different background workers run on different
AI providers — e.g. "run all my sentinels on Codex instead of Claude" — and
the docs tell you to turn it on with one setting in the agent's config file.
Tonight we actually tried to use that setting for real, on a live agent, and
discovered it does NOTHING: the part of instar that reads the config file
never copied that setting into the running program. The feature itself works
fine — but the documented switch for it was a dead wire, on every agent,
since the feature shipped.

## Why nobody noticed

The feature's tests built their configuration in memory (directly in code),
which skips the file-reading step entirely. So every test passed while the
real-world path — write the setting in the file, boot the agent — silently
dropped it. Classic wiring gap: each half works, the connection between them
was never tested.

## The fix

One small change: the config loader now carries the setting from the file
into the running config, exactly like it does for its neighbors. Plus two
new tests that do what the old tests never did — write a REAL config file
with the setting, load it the REAL way, and check the setting survived. One
test proves it's carried; one proves nothing phantom appears when the
setting is absent.

## What changes for users

If you set componentFrameworks in your config file, it now actually works
after the next update. Nothing changes for anyone who never set it.
