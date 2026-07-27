# A safety bar that tripped on a filename

## The setup

Before any change to instar's own code is committed, a classifier suggests how much review the change
needs, and separately sets a *floor* — a minimum level based on risk signals like "this adds a new
capability" or "this touches something irreversible".

The floor matters more than the suggestion. Declaring a change below its floor is allowed, but it is
recorded as a deliberate override for someone to review later. That design only works if the floor is
right, because the whole point is that going under it should feel like a decision.

## What went wrong

One of the risk signals is "a new configuration key was added". Detecting that from a diff is hard —
almost every piece of code contains lines that look like `name: value` — so the check is gated: it
only counts as a config key if the change also mentions something that looks like a configuration
surface.

One of those "looks like configuration" markers matched any text containing `.config`. That includes
*filenames*.

So a script that merely **reads** a file called `vitest.push.config.ts` matched the marker. Combined
with an ordinary bit of code like `const options = { slice: 6, runs: 2 }`, the classifier concluded a
new configuration key had been added and raised the floor — for a read-only helper script that adds
no configuration at all.

## Why this was worth fixing rather than working around

I hit this myself and declared the change below the raised floor. The floor turned out to be wrong,
so the outcome was fine — but that is luck, not judgement, and it points at the real damage.

A bar that trips on a filename teaches whoever meets it that going under the bar is routine. Do that
enough times and the override stops feeling like a decision. Then one day the bar is right, and it
gets stepped over with the same shrug.

A noisy guard does not merely annoy. It erodes the guard it belongs to.

## What changed

The filename marker is gone. The remaining markers all name genuine configuration surfaces — a config
module, the config file itself, a config type. A change that really adds a configuration key will
mention one of those.

Two tests hold the line from both sides: one reproduces the exact case that misfired and requires the
floor to stay low, and one runs through every remaining marker and requires the floor to still rise.
Narrowing a check must not blind it, and the second test is what proves it did not.
