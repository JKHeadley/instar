# ELI16 — spec-converge clause (d): audit the foundation, not just the spec

## What this is, in plain English

Before instar builds anything big, a spec (a design document) goes through a review
called `/spec-converge`. A handful of reviewers read it from different angles —
security, scalability, adversarial, and one called **Lessons-aware** that checks the
design against every lesson and standard we've already learned the hard way. The
whole point of that reviewer is: *don't let us repeat a mistake we've already made.*

Recently it missed one anyway. We wrote a spec for a **test harness** — a tool whose
job is to prove that the Slack permission gate works. The spec itself was clean, so
the review passed it. But the *thing it was testing* — the permission gate
underneath — had a real flaw: it used a brittle keyword list to decide who's allowed
to do what, which breaks one of our core rules (Signal vs. Authority). The review
never caught that, because it only looked at the spec in front of it and treated the
gate underneath as "fine, that's not what we're reviewing."

That's the gap: **the review audits the spec, but not the thing the spec is built on
top of.** A spec can be perfectly written while faithfully testing or extending
something broken.

## What this change does

It adds one more job to the Lessons-aware reviewer, called **clause (d):
FOUNDATION/SUBSYSTEM AUDIT.** Now the reviewer must look *one layer below the spec* —
at the subsystem the spec tests, extends, or builds on — and ask: "does *that* thing
violate a standard or repeat a known mistake?" If it does, the finding is: "this spec
is fine, but the thing it depends on breaks rule X — fix that before building on it."

So next time, a test-harness spec for a flawed gate would get flagged: "the harness
is sound, but the gate it proves holds brittle authority — surface that first."

## Why it's safe and small

- It's **words in a reviewer's instructions** — it makes the review look deeper. It
  doesn't change any running code, gate, or behavior.
- Existing agents already have the *old* version of this skill file installed on disk.
  A new copy in the source won't reach them on its own, so this change also adds a
  small **migration** that updates their installed copy on the next update — but only
  if they haven't customized it themselves (a customized skill is left untouched).
- For *this* agent (echo), the clause is already present, so the migration simply does
  nothing here — it's there for every other agent.

## How we know it works

Five new tests: it updates a stock skill that lacks the clause, it does nothing when
the clause is already there (safe to run repeatedly), it leaves a customized skill
alone, it does nothing when the skill isn't installed, and it checks that the source
skill file actually carries the clause (so the migration can't silently copy an empty
update).
