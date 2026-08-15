# ELI16 — the freeze-guard that stopped looking when you renamed the import

## What it protects

The agent's server runs on a single thread. If it starts another program and
waits for it to finish *synchronously*, everything stops — no health replies, no
other work — for as long as that program takes.

That is not hypothetical here. A slow terminal-multiplexer call once blocked the
server exactly this way. From outside, a server frozen mid-call and a server that
has died look identical, so the supervisor restarted a process that was alive and
working the whole time.

The fix was to route every such blocking call through one place that records "a
blocking operation is in progress," so the watchers can tell a busy server from a
dead one. A build check keeps new ones from being added outside that route.

## What was wrong

The check looked for the *name* of the blocking call on the line. So both of
these got past it while the plain form was caught:

```ts
import { execFileSync as run } from 'node:child_process';
run('tmux', ['ls']);           // invisible

const ex = execFileSync;
ex('tmux', ['ls']);            // invisible
```

Renaming an import is not a trick — it is how anyone resolves a name collision.
Assigning something to a shorter name is ordinary too. Either one silently
removed a safety check from that file.

Neither form appears anywhere in the guarded directories today, so closing them
adds nothing to the list of grandfathered exceptions and cannot break anything
that exists. It is purely forward-looking.

## The part where measuring changed the answer

The check also ignores the call when it is reached through an object — something
like `helper.execFileSync(...)`. My first instinct was that this was the same
kind of hole, and there are **fourteen** such calls in the guarded directories.
Fourteen invisible blocking calls would have been the headline.

It is not true, and I am glad I counted what they *were* rather than just how
many there were.

**Thirteen of the fourteen are calls through the audited git helper** — that is,
code going *through* the safe route, which is exactly what the rule wants.
Flagging them would have inverted the rule: punishing the correct pattern.

**The fourteenth is inside a template for a generated script.** It is text that
gets written out to a small standalone program, which runs in its own process
and cannot block this one.

So all fourteen exclusions are correct, and the rule is right as written. I have
left it alone and pinned that decision with two tests, so the next person who
notices it does not "fix" it and break the funnel.

I nearly got this wrong twice. My first check of whether the fourteenth was
inside a template counted backticks in a sixteen-thousand-line file and told me
it was not — which happened to support the more dramatic finding. Reading the
function it lives in settled it in one line.

## Why it won't start failing builds it shouldn't

This check fails builds, so wrongly flagging good code costs more than the gap it
closes. Six things are deliberate, each with a test, and all of them pass under
both the old and new versions:

1. **A blocking call that goes through the proper route is fine** — that is the
   required pattern, and if the new reach overrode it, the fix would punish
   exactly the code the rule exists to produce.
2. **A call with a written justification is fine** — the existing escape for
   startup-only work still works.
3. **An unrelated thing that happens to share the name is fine.** Only a name
   actually bound to a blocking call counts.
4. **A method call on some other object is fine** — same exclusion as the
   original rule.
5. **A file with no blocking call is fine.**
6. **The two cases above** — the git helper and the generated script.

Against the real codebase the check reports clean both before and after.

## How you know it works

The tests were written first and run against the old behaviour: **four of the
twelve fail** without this change. The other eight pass either way — one
confirming the plain form is still caught, two that the existing escapes still
win, three holding the line against flagging good code, and two pinning the
deliberate exclusion so it survives the next reader.
