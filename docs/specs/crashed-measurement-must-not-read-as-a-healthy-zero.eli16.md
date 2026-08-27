# Plain-English overview: a crashed measurement must not read as a healthy zero

## What is actually wrong

Your agent runs a handful of small scheduled chores. Four of them ask the agent's
own server a question, get a JSON answer back, and pull a number out of it —
*how many memories did I save?*, *how many pending items did I retry?*, *did any
of my capabilities change?*

The way those chores pull the number out is broken, and it has been broken in
every copy instar has ever shipped.

They pass the answer through a shell command called `echo`. `echo` looks
harmless, but in the exact shell the scheduler uses it quietly rewrites
backslashes. JSON is full of backslashes — every quotation mark inside a piece
of text is written `\"`, every line break is written `\n`. So a perfectly good
answer goes in and a mangled, unreadable one comes out. The step that reads the
number then crashes.

Here is the part that matters. When it crashes, each chore was written to fall
back to the number **zero**. And zero, in every one of these chores, is the
happy answer:

- *Memory export: no entities to export.*
- *Feedback retry: nothing pending.*
- *(capability audit)*: no drift detected.

So a chore that failed completely produces the identical sentence to a chore
that ran perfectly and found nothing to do. Nobody reading the log can tell them
apart. This ran undetected for a week on one agent before anyone noticed.

## What already exists

The problem was found and hand-fixed twice, on one agent, by editing that
agent's own settings file. Neither fix reached the code that generates those
settings for everyone else, so every other agent still has the bug — and the
hand-fix has since vanished entirely, because the settings file format changed
underneath it and took the repair with it. That is the whole argument for this
spec: fix the thing that *produces* the file, not the file.

## What is new

Four changes, all small.

1. **Use the right command.** `printf` instead of `echo`. It passes the answer
   through untouched. Nine places in the generator.

2. **Stop guessing zero.** When the number genuinely cannot be read, the chore
   now says *count unknown* instead of inventing a `0`. A failure that looks
   like a failure is the entire point.

3. **Fix the agents that already exist.** New agents get the corrected file the
   moment this ships, but existing agents keep whatever they were installed
   with, so a migration step rewrites their chores too. There are two different
   file formats in the wild — an older single file and a newer folder of files —
   and both get patched, because the two agents on this very machine sit on
   opposite sides of that change.

4. **A test that fails the build** if the broken pattern ever comes back. This
   repair has already been lost twice; a rule nobody can forget is the only
   version worth shipping.

## The one thing this spec refuses to do

The original proposal also asked for a second change: raise a quality threshold
on the memory export so that important lessons appear near the top of the file.

Checking it against the live data showed it would backfire badly. Of the 59
memories currently stored on this agent, 56 carry exactly the same quality score
— it is the default the system writes, so the score barely varies at all.
Setting the threshold just above that default would keep **3 memories out of
59** and throw the rest away. The hand-fix appeared to help only because
deleting most of the file let a different section float into view.

The underlying complaint is real: the part of the system that reads this file
only reads the first fifty lines, so anything below that is invisible. But the
fix belongs in what order things are written, not in what gets deleted. So this
spec reorders the file to put durable lessons first, and leaves every threshold
exactly where it is.

## What you actually need to decide

Whether you agree with three judgement calls:

- **Refusing the threshold change** and substituting a reordering. This is the
  one place the spec overrules the approved proposal it came from, and §3.3 of
  the spec shows the measurement behind it.
- **`count unknown` as the new failure wording.** It makes some logs noisier
  than they are today. That is deliberate — the current quiet is the bug.
- **Patching both file formats** in the migration rather than only the current
  one. It is more work, and skipping it would leave half the existing agents
  unfixed.

Everything else is mechanical: a wrong command replaced by the right one, in a
place where nobody can quietly put the wrong one back.
