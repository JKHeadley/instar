# ELI16 — Why "keep the work on the laptop" stopped hijacking your conversation

## The problem, in one sentence

The agent can run across several machines, and you can move a conversation between them
by just saying so — "move this to the mini". The code that decided *"is this message a
move command?"* used a **list of trigger words** (`move`, `transfer`, `run`, `continue`,
`resume`, `keep`, …). If your message contained one of those words followed by a machine
name, it was treated as a command — and the message was **swallowed** (it moved a session
instead of reaching the agent).

On 2026-07-03 that ate a real operator message: **"keep the work on the laptop"** — plain
discussion — matched the word `keep` × `on` × the machine `laptop`, so it was hijacked as a
"pin to laptop" command and the agent never saw what you actually said. The reverse also
failed: **"let's have the mini take this one"** *is* a real move command, but it has none of
the trigger words, so it was missed.

## Why a word-list can never get this right

Telling a **command** from **discussion** is a judgment about what a human *meant*. "Keep it
on the laptop" (a preference), "should we move this to the mini?" (a question), and "move
this to the mini" (an order) all mention a machine — only the last is a command. A fixed
list of words has no way to feel that difference; it fires on the words, not the meaning.
Instar's constitution now has a standard for exactly this — *"Intelligence Infers, Keywords
Only Guard"*: a decision about what someone *meant* is made by the AI reasoning over the
message **and the recent conversation**, never by a keyword list.

## What we built

We replaced the word-list decision with a small **LLM classifier**. It reads your latest
message plus the last few turns of the conversation and answers a strict, structured
question: *is this a present command to move/pin this conversation, and if so, to which
known machine?* Two design choices make it safe:

- **It can't invent a machine.** The answer for "which machine" is constrained to the list of
  your **real** machine nicknames (plus "none"). The model picks from that list — we never
  scan its free text for a machine name. If it somehow names a machine you don't have, we
  drop it.
- **When in doubt, it does nothing.** If the AI is unavailable, times out, is unsure, or
  gives a low-confidence answer, the message is **passed straight through to the agent** —
  never hijacked. The old bug was the code being *too eager* to grab your message; the new
  code leans the opposite way. A missed move command is cheap (you just say it again); an
  eaten discussion message is the exact harm we removed.

To keep it cheap, a quick check runs first: if your message (and recent context) name **no**
known machine at all, we skip the AI entirely and pass through — the AI is only consulted
when a move is genuinely possible.

## What changes for you

For now, **nothing visible** — the new recognizer ships **off on the fleet** and, on the
development agent, in **dry-run**: it watches real messages and writes down what it *would*
have done ("would-move" vs "would-pass") to a log, but still passes every message through.
That lets us prove the false-alarm rate collapsed before it's ever allowed to actually move a
session. Once the log looks clean, we flip it on. The move feature itself already existed;
we only changed *how it decides* your intent.

## The deeper fix: a discrimination benchmark

The real lesson wasn't just "use an LLM" — it was that we had **no test** pitting commands
against look-alike discussion. So this change ships a committed **corpus** that does exactly
that: "move this to the mini" (act) vs "keep the work on the laptop" (pass) vs "should we move
this to the mini?" (pass) vs "let's have the mini take this one" (act), plus an
unknown-machine guardrail and the fail-safe cases. It runs two ways — a deterministic check
that locks the pipeline's contract in every build, and an opt-in run against the **real** AI
that measures its accuracy directly. That benchmark is what stops this class of bug from
sneaking back in.

## The tradeoff

Every candidate message now costs one quick AI call instead of a regex — but only when a
machine is actually named, it's a small fast model, and it rides the same rate-limit and
circuit-breaker protections as every other background AI call. In exchange, the agent stops
mis-reading your intent in both directions. That's the whole point of living inside
intelligence: use it to understand you, instead of dumbing the decision down to string
matching.
