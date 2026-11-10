# Clearer machine notices and a nudge for waiting sign-in repairs — Plain-English Overview

> The one-line version: the dashboard now says how long a machine has been out of reach and whether anything is fixing it, stops showing a tick box that can never be ticked, and reminds you once when a sign-in repair has waited hours for your tap.

## The problem in one breath

Three things on the dashboard confused or failed the operator. A machine whose sign-in repair is off showed a greyed-out tick box with "turn this on from that machine's own dashboard", which looks like it is offered here. Notices like "No answer from Laptop" did not say for how long, or whether anything was already trying to reconnect. And a sign-in repair that was waiting for approval sat unseen for more than a day, because its one notice was easy to miss.

## What already exists

- **The machine pool view** — every machine's last real contact, whether its connections are down and since when.
- **The connection re-dialer** — on agents where it is on, it keeps re-trying a dead connection to another machine on its own.
- **The sign-in repair notice** — when a repair needs your approval, one notice is raised on the attention list, which follows the quiet-by-default rules.
- **The security rule** — another machine is never allowed to switch a machine's repair setting on; only that machine can.

## What this adds

Every "couldn't reach this machine" line on the dashboard now uses one shape: "Couldn't reach Laptop for 12 minutes; reconnecting by itself", or "for 3 hours; it looks switched off or asleep", or, when nothing is known, it says so plainly instead of guessing. The pool view now also says whether the re-dialer is working on that machine. Seven pages use the same wording, and one page that used to print an internal machine code now prints the name.

- Rows that cannot be changed from this page have no tick box. Their line says repairing without asking is off there and can only be switched on from that machine itself, because another machine is not allowed to raise it. The rule itself is unchanged.
- A sign-in repair that has waited for your approval longer than four hours gets one reminder, with a direct link to the "Needs you" list on the Accounts page.

## The new pieces

- **One wording helper for unreachable machines** — turns the facts the server already has into one plain sentence. It never invents a duration: a heartbeat file is not counted as reaching the machine, and no evidence means "not known".
- **The approval reminder** — checks every 15 minutes for repairs waiting longer than the setting (four hours by default; zero turns it off). It reminds once per wait, on the same attention row as the first notice. It is never sent at night, and it never approves anything.

## The safeguards

- Nothing here can block, approve, or change a repair; the reminder only tells you.
- The reminder uses the existing quiet-by-default path, so it is pushed to your phone only if you chose to push that kind of notice; otherwise it waits in the attention list and notifications feed.
- After a restart the reminder text is identical for the same wait, so it does not ping you twice.
- If the re-dialer is off on an agent, notices say "not known whether anything is fixing it" rather than claiming either way.

## What you need to decide

Nothing. To change how long a repair waits before the reminder, or to turn it off, ask the agent; it is one setting.
