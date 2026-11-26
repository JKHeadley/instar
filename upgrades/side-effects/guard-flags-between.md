# Side effects: guard catches destructive git forms with flags in between

Earned on 2026-11-05: a failed cd let a hard reset with `-q` before the flag run in a live agent home, and the guard's literal phrase did not match it.

1. Over-block: text that looks like the command, such as a commit message quoting it, now blocks in more spellings. The guard already blocked the literal phrase in text, so this is the same class. The agent can reword.
2. Under-block: a form split by a shell variable or an alias still passes. `git branch -D` and `git checkout -f` are not on the list and stay out of scope.
3. Level fit: same patterns in all three writers (template, init, migrator), which is the existing structure.
4. Signal vs authority: this guard is an existing hard floor on a narrow command list. No new judgement.
5. Interactions: the loop now uses extended regular expressions; the older patterns behave the same under them. The force-with-lease carve-out still applies and the new push pattern does not match that flag.
6. External surfaces: none. The hook is always overwritten on update, so existing agents get it.
6b. Operator-surface quality: n/a, no operator surface.
7. Multi-machine posture: machine-local hook, arrives with each machine's update.
8. Rollback: revert the commit; the next update rewrites the hook.

## Second-pass review

Tier 2 by the migrator risk floor. Behavior tests run the rendered guards on both sides of each form. No outside reviewer on this small change.
