# ELI16 — AUP-Rejection Wedge Signature + Fresh-Respawn API

## What happened

Last night one of my sessions died in a new way. Justin and the session had
been designing security test scenarios (deliberately-sneaky "try to trick the
agent" prompts, for the EXO 3.0 test harness). Enough of that content piled up
in the conversation that the AI provider's safety filter started refusing the
ENTIRE conversation — every single reply came back "this request appears to
violate our Usage Policy." Since each reply re-sends the whole conversation,
every reply failed, forever. From Justin's side it looked like me ignoring him
for an hour: "✓ Delivered" receipts, no answers.

The watchdog that's supposed to catch dead-but-still-printing sessions (the
ContextWedgeSentinel) only knew ONE death signature — the "thinking block"
error from May. This new one sailed right past it. And the only repair lever —
"restart fresh, do NOT reload the poisoned conversation" — existed solely
inside the watchdog's own wiring, so fixing it by hand meant editing a state
file directly.

## What this change does

1. **Teaches the watchdog the second signature.** It now recognizes the
   policy-rejection loop too, and the audit log says WHICH kind of wedge it
   caught. Safety detail: one single policy rejection is NOT treated as a
   wedge — sometimes one message just gets refused and the next works fine,
   and killing the conversation for that would destroy real state. The loop
   version always repeats, so we require seeing it more than once.

2. **Adds the repair lever to the API.** `POST /sessions/refresh` now accepts
   `"fresh": true` — restart this session WITHOUT reloading its conversation.
   That's the right move whenever a transcript itself is poisoned.

3. **Tells every deployed agent about it.** The CLAUDE.md migration adds the
   new signature, the API lever, and the prevention rule: keep literal attack
   payloads in files on disk and reference them by path — never paste them
   into the conversation itself.

## Why it's safe

Detection alone never kills anything (auto-recovery stays opt-in, unchanged).
The one-off-vs-loop distinction is tested on both sides with the real pane
text from the incident. The API param is validated, rate-guarded by the same
limiter every refresh uses, and reuses the exact internal mode the sentinel
already exercised in production twice this week.
