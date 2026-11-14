# Machines and Resource usage, from the app's point of view — the plain version

## What this is

Justin looks at his agent from his phone. The phone talks to the agent, which happens to answer from whichever machine is in charge at that moment. Until now, the Machines screen was written from that machine's point of view: one row said "this one", another said "Live (this machine)", and the others carried long sentences like "last evidence 3 s ago from a direct check from this machine; Mac M5 Pro reached it 9 s ago". From a phone, "this machine" means nothing. The Resource usage screen had the same blind spot: it only showed CPU and memory for the machine that answered, as if the other four did not exist.

## What already existed

- Each machine records its own CPU and memory use for the last hour (the resource ledger).
- The pool knows every machine, whether it is answering, its load, its session count and its Instar version.
- The phone's Accounts and Spend screens already ask every machine and merge the answers, naming any machine that did not answer.

## What is new

- Machine rows now read the same whichever machine answered: "Live · load normal · 3 of 15 sessions". The leading machine keeps a small "leading" tag. The longer "how do we know" sentence moved to the machine's own page and names the machine that checked ("Checked 3 s ago by Mac Studio").
- Resource usage asks every machine for its numbers and shows a combined line at the top (for example "4 of 5 machines · 11.9 GB of memory · 22 sessions", with the busiest machine), then one row per machine.
- A machine that does not answer says "Not answering". It never shows zeros, because zeros would look like "idle" when the truth is "unknown".
- Tapping a machine opens its page: its state, its CPU and memory, its busiest sessions, its Instar version, and a Remote Desktop button for that machine.
- The web dashboard gets the same treatment: no "this one" tag, and every machine shows what is using it and a Remote desktop link.

- The same rule now covers every phone screen. Spending, Accounts, Messages, Keys, Session settings, Inside, Plans and the session screens used to say "on this machine" or "This machine holds…". Now they name the machine ("Limits are on and enforcing on Mac Studio"). When the name isn't known, they simply leave the qualifier out. Error messages about files and messages no longer mention "this machine" at all.

## Safeguards

- Read-only. Nothing here can change a machine or a session.
- Only the owner's phone or the agent's own token can read it, as before.
- Each machine's answer is re-checked field by field before it is passed on, so a misbehaving machine cannot slip ids, file paths or secrets through.
- When one machine is asked for its own numbers on behalf of another, it answers only for itself. It never asks the others again, so there are no loops.
- Answers are shared for 15 seconds, so pulling to refresh many times does not flood the machines with requests.
- Older phones keep working: the fields they read are unchanged.

## What you need to decide

Nothing. This is a small, reversible change that follows Justin's request directly.
