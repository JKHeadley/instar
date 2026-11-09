# Resource-aware placement — the plain version

## What this is

When an Instar agent runs on several computers, it has to decide which computer does each piece
of work. Today it mostly asks "which computer looks least busy?" — and it judges "busy" by a raw
number that ignores how big each computer is. A small Mac Mini with 10 cores and a big Mac Studio
with 16 cores look equally busy at the same number, even though the Studio has far more room. And
nothing anywhere knows the difference between light work (a chat) and heavy work (building an
app, running the whole test suite, launching simulators).

On 6 November the Mac Studio got so overloaded that the agent's own server kept freezing, and
merges were stuck for two hours, while other computers had spare room. Justin asked why the work
wasn't being spread out, and said heavy work should never go on the Mini: the agent should choose
computers by their size and how busy they are right now, and that should be the default for every
multi-computer agent.

## What already exists

- Each computer already reports its cores, memory and how loaded it is, every 15 seconds.
- New conversations are already sent to the least-busy computer, skipping ones that are out of
  quota or signed out.
- Test runs ("Local Verify") can already be handed to other computers.

## What changes

1. **"Busy" is measured per core.** A computer's load is divided by its number of cores before
   comparing, so a big computer with the same load counts as less busy.
2. **Heavy work only goes to big computers.** A computer counts as big enough for heavy work if it
   has at least 12 cores and 32 GB of memory. Today that is the Studio, the M5 Pro and the Laptop;
   the Mini and Mama PC are not. Among the big ones, heavy work goes only to one that has room
   right now. If none has room, the work waits instead of piling on.
3. **Test runs stop going to the Mini.** Handed-off test runs skip computers that are too small or
   too busy, and try the least busy one first.
4. **Jobs can say they are heavy.** A scheduled job marked heavy won't run on a small computer.
5. **The agent can send heavy helper work elsewhere.** The agent's helpers normally run on the
   same computer as the agent. Now the agent can ask "where should this heavy job go?" (a
   read-only preview), and with one call start a background helper session on the computer the
   preview picks, with its task attached. That helper has no Telegram topic, so Justin sees no
   extra chats. If four heavy helpers start at once, each one counts against its computer right
   away, so they don't all pile onto the same machine before its load numbers update.
6. **Each computer can be overridden.** If Justin wants the Mini to take heavy work after all (or
   wants a big computer to stop), one setting on that computer says so, and every other computer
   learns it from its regular report.

## Safeguards

- Nothing is dropped. Work that has nowhere suitable to go waits, with a named reason.
- A computer whose size or current load can't be measured is never sent heavy work. Load numbers
  older than a minute don't count.
- The guess "this command looks like a build" only labels the preview; it never blocks or moves
  anything by itself.
- Conversations still go to any computer, including small ones; only heavy work is restricted.
- One known limit: scheduled jobs run on whichever computer currently leads. If that's the Mini, a
  job marked heavy is skipped (and the skip is recorded each time) rather than run on the Mini. No
  built-in job is marked heavy yet, so nothing that runs today stops.
- The preview changes nothing: it only shows what the agent would choose and why.

## What to decide

Nothing is waiting on a decision. The size line (12 cores, 32 GB) matches what Justin described
for today's computers, and each computer can be overridden one at a time. Undoing the change is a
plain revert.
