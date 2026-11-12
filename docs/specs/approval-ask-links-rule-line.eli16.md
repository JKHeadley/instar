# Every ask carries its links — the plain-English version

## What problem this fixes

When an agent finishes a piece of work, it often sends a message that says something like "done, ready for your review." Then the person has to go hunting. Which thing do they review? Where is it? What exactly are they supposed to say back to make the agent move on? Justin asked for this to stop: any time a "finished" or "done" message needs the person to review or approve something, the message should end with a section that is very easy to read and that has links straight to the things that need looking at.

## What this change does

It adds one short rule to the instructions every agent reads at the start of a session (the agent's CLAUDE.md). The rule says: when a message needs the person to review, approve or decide something, end it with a short "What I need from you" section. Each ask gets its own line, in plain words. Each line has a working link to the thing being asked about, and the agent checks that the link actually opens before sending it. Private material goes through a private view, not a public page. Each line also says the exact reply that settles it, so the person can answer in one go. When the ask is a real grant of authority, the line links to its Approve/Decline page instead, so the person taps a button rather than typing.

New agents get the rule because it is in the template. Agents that already exist get it the next time they update: the update step adds the line once, right before the existing paragraph about sending the person to a page. If an agent already has its own hand-written version of this rule, the update swaps that version for the official wording, so everyone ends up with the same text. Running the update again changes nothing.

The rule is also written into the standards registry as a named clause under "Agent Proposes, Operator Approves", with Justin's words quoted as the ratification.

## What it does not do

Nothing checks the rule yet. No message is blocked or held because of it. It is awareness: the agent is told what a good ask looks like. A helper that builds the section for the agent, and a review that looks back at sent asks, are tracked separately, as is what happens when an agent keeps missing it.

## If it turns out wrong

Reverting the change removes the line from the template. Agents that already received the line keep it until a later update takes it out, which is the same as for any other CLAUDE.md line. No data, settings or messages are touched.
