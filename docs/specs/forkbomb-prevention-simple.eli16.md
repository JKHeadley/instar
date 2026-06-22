# Fork-Bomb Prevention (SIMPLE) — ELI16

## What happened, in plain terms

On June 20 your computer ran out of memory and crashed — twice in an hour. The cause: the agent's
server can ask an AI model questions by launching a separate `claude` program for each question.
Under a bad feedback loop, it launched **230–289 of them at once** — each ~400MB — which ate all
128GB of RAM. It got worse because three different things (launchd, the fleet supervisor, a tmux
session) each tried to revive the agent, so up to **three full copies** of the server were running,
each launching its own flood.

A quick patch (cap it at 3 at a time) was applied during the incident — but a routine software
update later **wiped that patch**, so right now the agent is running with no cap at all. This fix
puts a permanent, sturdy cap back.

## Why this spec is short (and why that matters)

I first wrote an *elaborate* version of this fix — 2,400 lines, many clever moving parts (priority
lanes, reserved slots, timeout budgets, special per-gate behaviors). I ran it through ~17 internal
review rounds and thought it was ready. Then I had two **non-Claude** AI models (GPT-5.5 and Gemini)
review it, and both independently said: this is **over-engineered** — too complex to implement
correctly, and it's using the wrong main tool for the job. They were right. So this is the simple,
sturdy replacement. The lesson: for a resource-exhaustion crash, reach for the simple, OS-aligned
control first; save the clever stuff for later if it's actually needed.

## The fix — three simple, sturdy pieces

1. **A host-wide cap on how many AI subprocesses run at once.** One shared counter (a small file on
   disk that all the agents on the machine check before launching), capped at 8 at a time across the
   *whole* computer — not just per-agent. 8 × ~400MB ≈ 3.2GB, totally safe on a 128GB machine, versus
   the 230+ that crashed it. The cap lives at the one spot every AI-launch passes through, and a code
   check (a "lint") stops anyone from sneaking a launch past it. As a backstop against a misbehaving
   program that ignores the counter, a generous OS-level process limit is set too.

2. **A single-instance lock.** Only one copy of each agent's server can run on the machine at a time,
   so the "three copies each flooding" multiplier can't happen again. It's careful not to break
   normal restarts (the new copy waits a moment for the old one to bow out) and never gets confused
   on a multi-machine setup (it knows which computer a lock belongs to).

3. **Bounded intake — never an endless waiting line.** When the cap is full, a new request waits a
   few seconds, then takes a *safe* action: a safety check (like the emergency-stop gate) is **held**
   (the message isn't let through un-checked) rather than waved through — and the held message is
   simply surfaced for you to resend, NOT shoved back into the retry loop that caused the original
   crash. Background work just slows down. Crucially, the waiting doesn't pile up in memory.

## What this deliberately does NOT do (yet)

The clever machinery from the elaborate version — priority lanes, reserved slots, fine-grained
per-gate behaviors — is left out on purpose. It can be added later *if* measured to be needed. Also
left for later: a bigger architectural idea both outside models raised — that the agent leans on too
many AI-model checks in the first place, and reducing the *number* of those checks would fix the
flood at its source. That's a separate, larger effort.

## What you need to decide

Nothing blocking — the design is settled and validated by the outside-model review. The cap defaults
(8 host-wide, on by default) are sensible and tunable. This ships as one focused, on-by-default PR so
the protection (which is currently absent) is restored quickly and can't be wiped by a future update,
because it lands in the real source — not a hand-patch.
