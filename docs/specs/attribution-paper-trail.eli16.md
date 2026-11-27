# Attribution paper trail, in plain words

## What goes wrong today

An agent writes a note: "Justin corrected me, never do X." There is no link to what he actually wrote. Later sessions read the note, copy it, and each copy sounds firmer. Months on, the agent tells Justin it broke "his standing rule", and refuses work because of it. He never said it. That really happened, and when 36 similar notes were checked by hand, 8 had drifted away from his real words and 4 had no source at all.

Nothing checks this today. Every safeguard so far is a written reminder, and reminders are what failed.

## What changes

Any time an agent credits a person with saying something, it has to do one of two things:

1. Quote their exact words and point at the logged message: `"at least every hour and a half" [source: telegram 102965/48211]`
2. Say plainly that it has no source: `[source unknown]` or `[my inference]`

The second is always allowed, so an honest agent can never get stuck. What is no longer allowed is the third option that caused all this: claiming what someone said without showing where.

## Where it is checked

- **When a note or rule is saved.** The agent's attempt to save is checked first, on both Claude and Codex. If it credits someone with no source, the save is refused, with suggested real messages and the honest wording as the way through.
- **When a message is sent.** The existing check on outgoing messages gets one more rule. If a message says "your rule" and nothing backs it, the agent has to fix it or give a recorded reason. This also catches "I can't do that, that's a standing rule", even if no person is named. Messages to other agents get a warning and a record, and are never held.
- **Once a day, as a report.** A background check reads the notes, including ones saved in ways the first check cannot see. It reports what it finds and changes nothing. Corrections are made by a session, so they pass the same check.

A label only counts if it removes the credit. "Justin's standing rule: X [source unknown]" still credits him, so it is refused. "X. An earlier note credited this to Justin; source unknown." passes.

## How it decides

Two kinds of decision, kept apart:

- **Exact facts are checked by code**: does the message exist, are the quoted words in it, did it come from that person, was it sent before the claim first appeared. Each channel has its own proof of who sent a message, because only Telegram logs record it directly. A display name alone never counts. These checks inform the decision; the model makes the call.
- **Meaning is judged by a model**: is this sentence crediting a person, did the person really type this rather than paste it, and does the note say more than their words do?

"Could not check" stays different from "does not exist". A machine that is down, a date in Echo's 08-19 to 08-26 gap, or an old row that rotated out of the log never counts as a false citation.

If the model is unavailable, the save goes through marked unchecked, counted and reported, and the daily report picks it up later. Blocking every memory save during an outage would do more harm than one unchecked claim. The model is the agent's own subscription, within a daily limit, so there is nothing new to buy.

## The paper trail itself

Every claim checked is recorded in an append-only history: the exact wording, where, when, the verdict, and which earlier claim it came from. Asking for the trail shows the original message and then every later version in order, including a claim that was reworded with no source. Links made by an exact edit are told apart from links the model inferred. If a note was matched to a message only afterwards, the trail says "these words support it", not "this is where it came from".

## What you would notice

- **Echo:** first watches only, for about three days, then enforces.
- **Other existing agents:** nothing, until the feature has proven itself on Echo against clear numbers. Then they record and report only. An update never adds a refusal; the owner opts in.
- **New agents:** checks on from the start once it graduates.
- No note is ever changed by the system.
- To turn it off: one setting.

## What it cannot do

It cannot read minds: a real quote can still be misread, and the model's ruling on that is a judgment rather than a proof. It does not protect against an agent deliberately editing the history files. Saves made through shell commands are only caught by the daily report. Terminal input, email, lines the owner wrote by hand and learned preferences have no source pointer yet; each gets a tracked follow-up.

## What you decide

The code above is agent work and does not need sign-off. The constitution wording is separate and comes to you on its own.
