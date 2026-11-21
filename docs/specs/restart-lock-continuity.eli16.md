# Restarts and locked screens: in plain words

## What happened

On Nov 17 the operator listed ten ways the agent's machines were hard to rely on. This design fixes four of them. They share one pattern: a machine stopped doing its work, and nobody was told.

- **A restart nobody planned.** When the M5 was restarted by hand, three conversations that were in the middle of work simply ended: a promise the agent was following through on, a document waiting for approval, and a security build. None of them came back until someone happened to write to each one again.
- **A machine away with no reason.** When the M5 went away, the other machines could only see that it had stopped answering. The agent that runs the testing line found out why only by asking the operator.
- **A locked screen.** The M5's screen was locked, which stops parts of its testing from working. Nothing said so; it was found only after test runs failed. And after it was unlocked, its own health check kept reading "never passed" until the next restart.

## What already exists

The machine already writes down every session that a restart ended, along with which conversation it belonged to. There is already a careful "resume queue" that brings sessions back slowly and checks each one first. There is already a check after every restart that confirms the server, messaging, tunnel and logins came back. And the machine can already tell whether its screen is locked.

The pieces were never joined up, and nothing writes down which sessions were running just before a sudden restart, because the start-up cleanup rewrites those records. The after-restart check doesn't look at sessions at all.

## What changes

1. **Every conversation a restart ended is written down.** When the server starts, before any cleanup, it notes every session that was running. Once they're confirmed ended, it lists them and marks the ones that had an open promise the agent was working on. Anyone can read that list on that machine: the Chief of Staff, the testing session, or the dashboard. In this first step nothing is brought back automatically. But if any of the ended conversations had an open promise and still hasn't come back 15 minutes after the restart, the owner gets one note naming them, once per restart. Otherwise a conversation still comes back the moment someone writes to it, as today. Bringing busy ones back by themselves is the next step, once this list has proved accurate for a week.
2. **The after-restart check shows that list** on machines that look after themselves. It reports; it never marks the restart as failed.
3. **A machine that shuts down properly says why.** Just before stopping, it tells the other machines whether the whole machine is restarting, only its server is restarting, or it is stopping for a reason it didn't record (for example, someone restarted the Mac by hand), and when it expects to be back if it knows. The others show that reason in their machine list, so any session that depends on that machine can read why it is away. A machine that vanishes without saying anything still reads as "unreachable", as today. If it said it would be back and hasn't returned 10 minutes past that time, the list says so.
4. **A locked screen is reported once.** If a testing machine, or a machine set up to look after itself, stays locked for 10 minutes, one report goes up naming the machine and when the lock started, once per machine even when several agents run on it. When the screen is unlocked, the health check runs again straight away, and its results for the next half hour are written down. Then, if it keeps failing, the cause can be seen.

## Safeguards

- Nothing here can stop, block or start any work. It writes a list, adds readings, and sends at most one note per restart and one per locked screen.
- The "going away" message is signed, so one machine can't claim another is away. Sending it never holds up a shutdown by more than two seconds.
- Only testing machines and machines set up to look after themselves are reported for being locked, so an ordinary laptop locked by its owner is not.

## What the reader needs to decide

Nothing in this design. Whether the testing Macs may stay unlocked and sign in by themselves after a restart is a separate yes or no for the operator, because it is a physical-security choice. This design works either way.
