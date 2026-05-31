# Explain it like I'm 16: stop the scope-check hook from confusing Codex

## The setup

When an AI agent finishes responding, little programs called "Stop hooks" run.
One of ours, the "scope-coherence checkpoint," watches whether the agent has been
heads-down coding for a long time without stepping back to look at the big picture.
If so, it gently interrupts ("hey, zoom out, re-read the spec"). If not, it just
says "all good, carry on."

Each hook talks back to the agent runtime by printing something. There are two
runtimes: Claude and Codex (OpenAI's). They have slightly different rules for what a
Stop hook is allowed to print.

## The problem

Our scope-check hook, when it decides "all good, carry on," printed a little
message: `{"decision":"approve"}`. Claude is fine with that — it reads it as "okay,
allow." But **Codex has a stricter rule**: to interrupt, print
`{"decision":"block"}`; to allow, print **nothing at all**. Printing
`{"decision":"approve"}` isn't on Codex's menu, so Codex throws an error every time:
"invalid stop hook JSON output."

We caught this live: while test-driving our Codex agent "Codey," it finished a task
perfectly and sent its reply — and then that error popped up right after. The reply
went out fine (so nothing actually broke), but the error showed up on *every* Codex
session completion. Annoying and wrong.

## The fix

Teach the hook the universal rule: **to allow, print nothing.** We removed the
`{"decision":"approve"}` print on all the "carry on" paths, leaving them to just
exit quietly. The "interrupt" path still prints `{"decision":"block", ...}` exactly
as before, because both Claude and Codex understand that one.

The neat part: printing nothing means "allow" on **both** runtimes. So for Claude
this is a zero-change (empty and "approve" mean the same thing there), and for Codex
it makes the error disappear. It's the same convention we already applied to another
hook (the autonomous-loop one) a couple of fixes ago.

## Why it's safe

The scope-check's actual job — interrupting when you've been coding too long without
zooming out — is untouched; that path still prints its block message. We only
changed the "do nothing, allow" paths to literally do nothing. And because every
agent rewrites this hook from our source on its next update, the fix reaches all of
them automatically, including Codey.

## How we know it works

Tests confirm: the "allow" paths now print empty (and exit cleanly), the generated
hook contains no `approve` message anywhere, and it still keeps the `block` message
for the real interrupt. 28 related hook tests pass. Final proof comes from
re-driving Codey after it updates and seeing the error gone.
