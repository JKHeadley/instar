# Mentor Stage-A no-leak instruction — explained simply

## The everyday version

Your agent can act as a "mentor" to another agent: it watches how the mentee is
doing and periodically sends it a nudge or assigns it a task — exactly like a senior
developer checking in. To keep that fair, the mentor is built with a deliberate
"two hats" rule: when it composes the check-in message, it is only allowed to use
what a real user would see (the conversation and the visible task status). It is
NOT supposed to peek at the mentee's code, logs, or internals and feed it answers —
because the whole point is for the mentee to discover things itself. There's even an
automatic detector that flags it if the mentor's message mentions things a blind
user could not know, like a source file path, a line number, or a pull-request
number.

## The problem

In real use (mentoring our codex agent), that detector kept flagging a leak on
almost every check-in. The reason: when the mentor's AI wrote "go verify feature X,"
it would helpfully tack on "…it's probably in such-and-such source folder." It
wasn't reading the mentee's internals — it just knows roughly where things live from
general training — but naming the location still hands the mentee the answer and
trips the leak detector. The existing rule ("you can't see their internals") wasn't
specific enough: the AI read it as "don't claim to have read their logs" and kept
volunteering code locations anyway.

## What we changed

We added one clear, specific sentence to the mentor's compose instructions: never
name source paths, file names, line numbers, PR/issue numbers, or commit hashes —
say WHAT to check, not WHERE in the code to look. That targets exactly the things
the leak detector cares about, so the mentor stops handing out locations while still
giving genuinely useful guidance ("verify the project map doesn't include hidden
state folders").

## Why it's safe

We fixed the cause (the instruction), not the symptom — the leak detector itself is
completely unchanged, so it still catches anything that slips through. Nothing
outside the mentor's compose step is affected: not the detector, not the tool
permissions, not how sessions are spawned. We added a test proving the instruction
is present in the composed prompt. Only agents running the mentor are affected, and
only in how their compose step is worded. If anything looked off, removing the one
line restores the prior behavior exactly.
