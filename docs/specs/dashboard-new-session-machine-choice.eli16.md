# Choosing the machine for a new session — plain-English overview

## What this is

When you start a new conversation from the dashboard's New Session box, you can already
pick which AI "door" (Claude Code, Codex, and so on) and which model it uses. What you
could not pick is which of your computers runs it. The agent runs on several machines
(the Mac Studio, the Mac Mini, the laptop, the Mama PC), and a new conversation always
started on whichever machine was currently in charge of handing out new conversations.
If you wanted it somewhere else, you had to create it and then move it, which briefly
ran it on the wrong machine first.

This change adds a Machine choice to the New Session box.

## What it looks like

A new dropdown called Machine sits under Model. It starts on "Automatic", which keeps
today's behavior. Below that it lists each of your machines by name. The machine
showing you the dashboard is marked "(this machine)". A machine that is switched off or
unreachable is listed but greyed out with "(offline)", so you can see it exists but
cannot pick it. A machine that has hit its usage limit is marked "(at usage limit)";
you can still pick it if you mean to.

If you only have one machine, the dropdown does not appear at all.

## What happens when you pick

- **Automatic**: exactly what happens today.
- **This machine**: the conversation starts right away, as today, and is also pinned
  here so it is not moved to another machine later for load balancing.
- **Another machine**: the conversation is pinned to that machine and its session is
  started there straight away, by the same route a normal message takes when a
  conversation lives on another machine. Your door and model pick travel with that
  start request, so the other machine starts on what you chose. Before anything is
  created, that machine is asked whether it can run the door and model you picked; if
  it cannot, nothing is created and the box tells you why. (Only when you picked nothing
  and the dashboard's default door is missing there does it start on that machine's own
  default, and the response says so.) The pin is written only once the other machine has
  accepted the start (or when no answer came back, since it may well be running). If
  that machine outright refuses the start, the conversation is left unpinned and the box
  tells you so: your first message then starts it wherever the agent normally would, and
  you can pick that machine again later once it accepts starts.

## Safeguards

- If you name a machine that does not exist, one that is offline, one whose clock is
  badly out of step, one that does not accept this machine's credentials, one that
  cannot be reached over the machine-to-machine link, or one still running an older
  version that cannot accept this kind of start, nothing is created and the box tells
  you why.
- In the rare case that another machine takes the conversation while the start is on
  its way, the box says so and the conversation is not pinned; your first message goes
  to whichever machine holds it. It never quietly starts the conversation somewhere
  else.
- Picking a machine never moves an existing conversation that happens to have the same
  name; that is refused.
- The pin it sets is an ordinary pin, the same as "move this to the laptop" makes, and
  can be removed the same way.
- No new permissions: it uses the same writes the existing "move this conversation"
  command already performs.

## What is not changing

Conversations you start in Telegram itself, and conversations that already exist, are
untouched. Slack and headless sessions do not get the Machine choice.

## What a reader needs to decide

Nothing is open. One honest limit: the check that the machine is online happens when you
tap Create. If that machine goes offline later, the conversation is handled like any
other conversation whose machine went dark (the existing failover and "machine is
restarting" notices), not by this feature.

## A small follow-up before merging

Two automatic code checks failed after this change was brought up to date with the latest code. Four error handlers lacked the marker that says "this error is reported, not hidden", and one unrelated new route had no record of which machine may write to it. Both are fixed. Nothing the user sees changes.
