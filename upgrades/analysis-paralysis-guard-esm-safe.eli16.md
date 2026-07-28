# ELI16 — the new hook would have crashed on half the agents it installed to

The analysis-paralysis guard this PR adds started with two ordinary-looking lines:

    const fs = require('fs');
    const path = require('path');

That is fine in one module system and fatal in the other. On an agent running in ESM mode, `require`
does not exist, so the hook crashes the moment it is invoked — on every single tool call, because it is
a PostToolUse hook.

This is a repeat of a failure this repo has already paid for: `hook-event-reporter.js` shipped with a
bare `require('http')`, was install-if-missing, and left ESM agents permanently stuck on a broken
template. That incident is why built-in hooks are now always overwritten on update, and why there is a
test watching for exactly this pattern. The test caught it here.

The fix is to load those modules inside the handler with `await import('node:fs')`, which works in both
module systems — the same approach the other generated hooks in this file already use.

The PR was written in May, before that test existed, so nothing was ignored — the code simply had never
been measured against it.
