# "Every ask carries its links": status after review round 2, and a choice for Justin

**Where it stands.** Two review rounds have run with source access (GPT 6 Astra and Fable 5.2) plus the conformance gate. The design was a live check in the outgoing-message reviewer (`B24_APPROVAL_ASK`), copying the existing page-link check (B22). Round 2 found a constitutional problem with that design, plus 3–4 others.

**The constitutional problem.** The Instar 2.0 rule book is the master. It says:

> "Reviewing every outbound message live, one at a time, has been a trap in 1.x … judge patterns in retrospect with the best model available; judge moments live only when the moment is irreversible."

A missing link is reversible. A live check on every reply is the 1.x pattern the master book warns against. It would also be the first rule added to every reply's review, fleet-wide, with no off-switch.

**Two routes:**

- **Route 1: live check (1.x style, as drafted).**
  - Every outgoing reply that asks you for something gets held until it has the request section and links.
  - It needs more machinery: an off-switch, a benchmark re-run, a rule for how it interacts with the page-link check, and link confirmation.
  - It also conflicts with the master book unless you grant an exception.
- **Route 2: built into how messages are made, checked afterwards (2.0 style, recommended).**
  - **Now:** the rule goes into every agent's standing instructions and into the standards, citing your words.
  - **Sender tool:** when an agent sends you asks, it lists them, and the tool builds the "What I need from you" section. Before sending, the tool checks that every link actually opens (a plain check, no AI judgment).
  - **Afterwards:** a regular review of sent messages, using the best available model, finds any ask that went out without links. It reports the pattern so it gets fixed at the source. Nothing is held at send time.

Route 2 follows the master book, catches what Route 1 catches, and doesn't slow every message down.
