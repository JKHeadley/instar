# ELI16 — the flood guard that could be switched off by naming a string

## What it protects

Instar can create its own Telegram topics — those separate threads you see for alerts, updates and
so on. Left unbounded, a single buggy feature can create hundreds of them and bury the useful ones.
That has actually happened three times, most memorably when a detector gave every one of its notices
a slightly different label and so slipped past the per-source limit.

The final defence against that is a single place in the code where topics are born, which counts them
and refuses once a budget is spent. A check runs on every build to make sure nobody calls the Telegram
API directly and goes around that counter.

## What was wrong

The check looked for the Telegram method name written out as text, right next to the call:

```js
apiCall("createForumTopic", { name: "..." })
```

Which means it saw nothing at all here:

```js
const M = "createForumTopic";
apiCall(M, { name: "..." });
```

Same call. Same Telegram API. Same flood. Invisible to the check.

Two more spellings did the same thing: gluing the name together from two pieces
(`"createForum" + "Topic"`), and passing the named constant to the alternative form of the call.

**Nothing about any of that is sneaky, and that is the point.** Pulling a repeated string into a named
constant is ordinary tidying — the sort of thing you do to make code *nicer*. Someone could step
around a safety floor while cleaning up, and the build would say "clean".

I measured this before changing anything: a known-bad call the check *does* catch, run in the same
pass, so I could prove the test itself worked. It caught the plain form and missed all three others.

## What changed

Before applying its rules, the check now works out what the method name actually is: it follows a
named constant back to the text it holds, and glues together pieces of text that sit next to each
other. The rules themselves are untouched — they just see through one level of naming.

## Why it won't start failing builds it shouldn't

This check blocks commits, so wrongly flagging correct code would cost more than the hole it closes —
a noisy check gets switched off, and then it protects nothing. Six things are deliberate, each with a
test:

1. **A constant holding something else is fine.** Only the actual method name counts.
2. **A name that never reaches a call is fine.** Holding the text is not the same as calling with it.
3. **An ambiguous name is left alone.** If the same name is set to two different things in one file,
   it is treated as unresolvable rather than guessed at — guessing wrong fails someone's build.
4. **It never invents text.** `"createForum" + suffix` stays unresolved, because working out what
   `suffix` holds would take real analysis and the answer would be a guess.
5. **A longer name that merely starts the same way is fine** — a different Telegram method is a
   different method.
6. **Substitution happens only at the two places the rules look**, never everywhere, so an unrelated
   line mentioning the same value is untouched.

It also only ever looks within a single file, so one file's names can never affect another's.

## What it still can't see, stated plainly

- A name imported from **another file**.
- A name built at runtime from a variable, a function call, or a template.
- Anything needing real dataflow analysis.

Those need a different kind of tool. Guessing at them would flag correct code.

## One more thing this fixes, quietly

Running this check used to be all-or-nothing: importing it to test its internals would run the whole
repository scan and, on the first real violation, kill the process — taking the test run with it. Three
other checks hit exactly that this week. It now only runs the scan when you run it directly, which is
what makes the tests above possible at all.

## How you know it works

The tests were written first and run against the old behaviour: **five of the eighteen fail** without
this change. The other thirteen pass either way — those are the controls, and most of them exist purely
to prove the check stays quiet where it should. Against the real codebase it reports clean both before
and after, so nothing that exists today is newly blocked.
