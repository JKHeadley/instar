# Sibling-machine reach — plain-English overview

## What this is

An instar agent often runs on several computers at once (for Justin: a Mac Studio, a Mac Mini,
a laptop). Before any message goes to the person, an outbound check reads it and stops a few
bad habits. One habit it stops is asking the person for access the agent already has — for
example "please give me your password" when the agent's own vault already holds it.

The trouble: that check only knew about the ONE computer the message was sent from. On
2026-11-20, after the Mac Studio was rebuilt, four subscription accounts were missing on the
Studio. They were still signed in on the Mac Mini. The agent asked Justin to open the
dashboard, type his PIN and do four sign-ins himself. Justin asked why the agent did not just
use its other machine. He was right: the agent could start each sign-in on the Studio and
approve it in the Mini's already signed-in browser. No PIN, no passwords, no work for Justin.

## What already exists

- The check already sees this computer's signed-in browser accounts and the names (never the
  values) of the vault's stored secrets.
- A separate rule (B21) nudges the agent when it hands the person a click-by-click procedure.
  The agent may override that nudge if it gives a reason. On 2026-11-20 it overrode with "needs
  his PIN and passwords" — a reason nothing checked against the other machines.

## What is new

1. Every 10 minutes, in the background, each computer quietly asks its sibling computers
   (the agent's other machines) two things: which subscription accounts are signed in there, and which browser accounts are
   signed in there. It keeps the answer in memory. Sending a message never waits on the network.
2. When a message is checked, the check now also sees: the accounts signed in on THIS computer,
   and what each OTHER computer holds, with how old that information is. A computer it has not
   heard from recently is marked "unknown" — never "holds nothing".
3. The click-procedure rule now counts the other computers. "Sign in account X on this
   machine" is the agent's own job when another computer has a browser signed in to that exact
   account. It only nudges: the hard "you already hold this" wall still looks only at this
   computer, so information from another machine can never trap a message the person really
   needs to see. A browser signed in to a different account at the same company does not count.
4. When the click-procedure nudge fires and another machine holds the accounts in question, the
   nudge now says so plainly, right when the agent decides whether to override it: "your Mac
   Mini holds these accounts — ask a helper there".
5. The agent's written instructions now say: before asking about anything tied to one machine,
   check every machine, and use a helper on the one that can.

## Safeguards

- A "helper" is simply another session the agent starts on its other computer to do the step.
- Only harmless facts travel: account labels, emails, providers, status, browser account names.
  Never login folders, never secrets, never vault names from other machines.
- Old information expires after an hour and becomes "unknown"; "unknown" never makes the check
  hold a message.
- The check still leans toward letting messages through when unsure, and the click-procedure
  nudge stays something the agent can override.
- It goes live first on the development agent (Echo, the agent this happened to) and reaches
  every other agent only after two weeks of evidence that it helps and does not wrongly hold
  messages. One setting (`toneGate.siblingReach.enabled`) turns it on or off. On a single computer
  nothing changes at all.
- Information from another computer can only NUDGE the agent (it can override with a reason). It
  can never by itself hard-block a message: before any hard block, the check is re-run without the
  other computers' information.

## What you need to decide

Nothing. This is a reversible change inside an approved project; it can be switched off with
one setting or reverted, and it reaches other agents only after its evidence is reviewed.
