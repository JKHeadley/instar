# ELI16 — the check that only recognised one way of saying it

## The rule

Some features are supposed to be live on a **development** agent and dark everywhere else, so they get
exercised before they reach the fleet. There is one shared helper that answers "is this a development
agent?", and everything is supposed to route through it.

If people hand-roll that decision themselves instead, the answer drifts — different code makes the call
differently, and features that were supposed to be exercised on a dev box quietly aren't. So a lint fails
the build when it sees the decision made by hand.

## What it was looking for

Exactly this shape:

```ts
const enabled = cfg?.enabled ?? !!config.developmentAgent;
```

The `??` means "use the explicit setting if there is one, otherwise fall back to whether this is a
development agent". The lint looked for `developmentAgent` written immediately after the `??`.

## What it missed

You do not have to write it there:

```ts
const da = config.developmentAgent;
return enabled ?? !!da;
```

Same decision, made by hand, in the same file — invisible to the check, because the words
`developmentAgent` and `??` are now on different lines.

Nothing about that is sneaky. Pulling a value into a named variable is ordinary tidying, which is what
makes it worth closing: someone could step around this guard while making the code nicer, and nothing
would say a word.

Worth being fair to whoever wrote it: the lint's own header said plainly that it could not catch aliases.
That was honest and it was true. It is closed now because the specific shape that actually shows up is
cheap to catch — not because the warning was wrong.

## What changed

Before checking a line, the lint now reads the file for any local variable that was set from
`config.developmentAgent`, and then treats `?? !!thatVariable` the same as the direct form.

## Why it won't start failing builds it shouldn't

This lint fails builds, so wrongly flagging good code is worse than missing a case. Four things are
deliberate, each with a test:

1. **Only that value counts.** A variable set from anything else is fine.
2. **Whole words only.** `config.developmentAgentName` is a different thing and isn't flagged — the same
   boundary that already applied when written directly.
3. **Reading the flag is still allowed.** `const da = config.developmentAgent; return da ? "dev" : "fleet"`
   is untouched. Using the value is fine; hand-rolling the *fallback decision* is what's banned.
4. **Comments don't count.** The lint already ignored commented-out code, and the new alias-reading uses
   the same stripped view, so a commented declaration binds nothing.

Aliases are also read per file, so one file's variable can never affect another's.

## What it still can't see, stated plainly

- A **helper function** that wraps the check (`isDevAgent(config)`).
- An alias imported from **another file**.
- Anything needing real dataflow analysis to work out.

Guessing at those would flag correct code. So the original warning is narrowed rather than deleted: it can
no longer catch *arbitrary* aliases, having gained the ordinary local one.

## How you know it works

The tests were written before the fix and run against the old lint first: three of the thirty-one fail
without the change. The other twenty-eight — including four new ones that exist purely to prove it stays
quiet where it should — pass either way. Against the real codebase the lint reports clean, so nothing that
exists today is newly blocked.
