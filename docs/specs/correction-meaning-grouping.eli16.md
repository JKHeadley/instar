# The correction analyzer counts reworded repeats together — plain-English overview

## What this is

When you correct the agent, or tell it how you want things done from now on,
a "correction sentinel" writes the lesson down as a short note. Once a week an
analyzer reads those notes, and when the same lesson has come up at least four
times, on at least two different days, in at least two different sessions, it
turns it into a standing preference that every new session is reminded of.

That never happened. The analyzer decided whether two notes were "the same
lesson" by counting shared words, and it needed about two thirds of the words
to match. People never repeat themselves word for word. "Only ask me to approve
constitution changes" and "Require my approval only for changes to the
constitution" share about half their words, so the analyzer saw two unrelated
one-offs. On 29 October there were 131 notes, and the analyzer put zero of them
together. So nothing ever reached four, and no preference was ever learned.

## What already exists

- The notes themselves (the correction ledger) and the four/two/two rule (the
  recurrence gate). Neither changes.
- Jev, a small, fast, cheap classifier from TypeSafe that the agent already
  uses for several yes/no style questions, and the habit of sending Jev's
  unsure answers to a slightly bigger model (GPT-6 Luna) to decide.

## What is new

For every pair of notes of the same type that share at least a few words, the
analyzer asks Jev: "do these two notes state the same core rule, even if one
adds a detail?" Jev answers with a probability. Above 70% counts as the same;
below 30% counts as different; anything in between goes to Luna to decide.
Each pair is asked only once and the answer is saved, so later weeks only ask
about new notes.

Two notes can then be grouped either because they share most of their words
(the old rule) or because Jev or Luna said they state the same rule.

## The safeguards, in plain terms

- **No chains.** A group only forms when every note in it matches every other
  note. If A matches B and B matches C but A does not match C, they do not all
  end up together. This was already the rule; it now also applies to Jev's
  answers.
- **The bar for a preference is unchanged.** Grouping only decides which notes
  count together. Four occurrences, two days and two sessions are still
  required, and a learned preference is still a reminder, not a command.
- **Fails back to the old behavior.** No Jev key, Jev down, a timeout, or the
  switch turned off: the analyzer groups by shared words exactly as before.
- **Bounded cost.** A cap on calls per run and a four-minute time budget;
  anything not asked this week is asked next week.
- **Nothing private leaves twice.** Notes are already scrubbed of secrets when
  stored; they are scrubbed again and cut short before being sent to Jev. The
  call log records only which pair was asked and the numbers, never the text.
- **You can see it.** A new read-only page lists the groups it currently forms
  (summaries only), and the weekly run says which grouping it used.

## What you need to decide

Nothing. It is switched on for this development agent only (the other agents
keep the old behavior until it is turned on for them), and the weekly analyzer
job is switched on for this agent only. It can be turned off without a restart
by setting `meaningGrouping.enabled` to false.
