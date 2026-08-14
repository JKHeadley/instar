# ELI16 — the check that read the argument instead of the command

## The incident this exists to prevent

Node runs your program on a single thread. If you ask it to run another program and *wait* for the answer,
nothing else happens in the meantime — no requests answered, no timers, nothing. That is usually fine for
something fast.

`ps`, `pgrep`, `lsof` and `pkill` are the ones that are not fine. They list everything the machine is doing,
and they get slow exactly when the machine is busy — which is exactly when monitoring code runs most often.

On 2026-06-07 that closed a loop. Monitors ran these scans synchronously on a timer. Under load the scans got
slow, each one froze the server for its duration, the freezes added up, and the server stopped answering its
own health check. The supervisor watching that health check concluded the server had died and restarted it.
The server was alive the whole time. It was restarted for being busy answering a question nobody needed asked.

Afterwards, the fix was to make those calls asynchronous — which yields the thread instead of blocking it —
and a lint was written so nobody could reintroduce the synchronous version.

## What was broken

The lint looked for the command spelled out inside the call:

```js
execFileSync('pgrep', ['node'])   // caught
```

But the command does not have to be written there:

```js
const cmd = 'pgrep';
execFileSync(cmd, ['node']);      // NOT caught

const cmd = 'pg' + 'rep';
execFileSync(cmd, ['node']);      // NOT caught

import { execFileSync as run } from 'node:child_process';
run('pgrep', ['node']);           // NOT caught
```

Every one of those runs `pgrep` synchronously and freezes the thread for its duration. The lint was reading
*how the argument was spelled* rather than *what the program actually runs*. Codey found the middle case
while auditing about twenty of these checks for exactly this weakness, and reproduced it against the shipped
lint: it exited clean.

Nothing here is an exotic trick. Pulling a command into a named constant is something people do for
readability, not to evade a check — which is what makes this worth closing. Someone could have walked past
this guard while tidying up code, and nothing would have said a word.

## What changed

The lint now works out what the command actually is, and *then* applies the same rule:

- A chain of string pieces joined with `+` is glued back together.
- A command stored in a nearby `const` is looked up.
- If someone imports the function under a different name, that name is followed too.

## Why it will not start yelling at correct code

This lint blocks commits, so wrongly flagging good code is worse than missing a case. Three deliberate
choices, each with its own test:

1. **The value decides, never the name.** If someone writes `const pgrep = 'tmux'`, that is fine — it runs
   `tmux`. The variable happening to be *called* `pgrep` means nothing.
2. **Whole words only.** `psql` is a database client, not `ps`. It is not flagged.
3. **When in doubt, stay quiet.** If the same name is set to two different values in one file, the lint
   admits it cannot tell which one applies and says nothing. That is the safe direction on purpose.

Async calls are untouched, since moving to async is the entire point of the rule — the lint must never punish
the fix it is asking for. And the reviewed escape hatch for a genuine one-shot call still works.

## What it still cannot see, stated plainly

- A call written across several lines. This lint reads one line at a time; changing that means parsing the
  code properly, which is a different kind of tool. That gap existed before and still does.
- A command that comes from a config file, a command-line argument, or another module. Working that out needs
  real dataflow analysis, and guessing would flag correct code.
- Only the two directories where the incident happened are covered. The session-handling code has its own,
  larger conversion tracked separately.

These are written at the top of the file rather than left to be discovered.

## How you know it works

The tests were written *before* the fix and run against the old lint first: four of the fourteen fail without
the change, which is what makes them worth having. The other ten pass either way — those are the controls
that prove the lint has not started flagging things it should leave alone. Against the real code the lint
reports clean, so nothing that exists today is newly blocked.
