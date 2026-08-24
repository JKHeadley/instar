# Plain-English overview — Job Tool-Allowlist Real Enforcement

## What this is, in one breath

My scheduled background jobs have a setting that says which tools each job is
allowed to use — for example, "this job may only read files." That setting is
written down, logged, and reported. It has never actually restricted anything.
Every job runs with every tool. This change first stops the system from claiming
otherwise, then builds the real restriction behind an off-by-default switch.

## Why the setting does nothing

When a job starts, it launches with two instructions that contradict each other:

- "Here is the list of tools you're allowed to use."
- "Skip the permission system entirely."

The second instruction turns off the machinery that the first one configures. So
the allow-list is handed to a system that has been switched off. The flag grants
permission; it was never capable of withholding it.

## Why this went unnoticed for so long

Because every piece of evidence anyone looked at was real. The job's settings
file really did say "read-only." The log really did say "clamped to read-only."
The run record really did carry a "was clamped" marker. All true, all recorded
faithfully — and none of them describe what the job actually did once it started.

The only place the truth lives is in the running process itself. Nobody looked
there until recently. When someone finally did, the "read-only" job was holding
every tool and running dozens of shell commands.

This is a specific recurring blind spot of mine: I check the thing that produces
a change and treat it as proof of the effect, instead of going to the far end and
watching what happens.

## Why the harm is the reporting, not the restriction

Nothing is currently over-restricted — no job is missing a tool it needs. The
damage runs the other way: **the system tells you it is enforcing a rule it is
not enforcing.** A safety control that reports success while doing nothing is
worse than having no control at all, because at least an absent control is
correctly understood by everyone.

That false confidence has already cost real time. Three days went into
"fixing" eight jobs to work around a restriction that was never in force. The
work silenced the warning message and changed nothing about how the jobs behaved,
in either direction.

## The fix already exists elsewhere in the same file

A different kind of session in this codebase — one used for background
investigation — does it correctly. It passes the allow-list *and* the permission
setting, and pointedly does **not** pass the "skip permissions" instruction. There
is even a comment next to it explaining why. Two ways of starting a session live
in the same file, about 2,700 lines apart, and one of them is right. This isn't
new machinery to invent; it's a working pattern to copy.

## What actually changes, in three steps

**Step 1 — stop the false claim.** Right away, correct the messages so they say
what is true: the tool list is recorded but not enforced when the job starts.
This step alone removes the misleading assurance and can ship by itself.

**Step 2 — add the test that would have caught this.** A test that inspects the
actual startup instructions and fails if the contradictory pair ever appears
together. Critically, the test must check that a forbidden tool genuinely
*fails* — checking that the setting is merely *present* is exactly the mistake
that created this bug.

**Step 3 — build the real restriction, switched off.** Copy the working pattern,
put it behind a config switch that defaults to off, with an extra "log what I
would have done" mode in between.

## The part that needs care

If real enforcement were switched on today, six background jobs would suddenly
become read-only — including the health monitor and, with some irony, the very
job that wrote this proposal. All six genuinely need to run commands. So turning
it on is blocked behind two requirements:

1. A puzzle has to be solved first. The settings files on disk currently say
   these jobs have full permission, but the running scheduler is behaving as
   though they're restricted. The files and the live behavior disagree, so right
   now nobody can list the affected jobs by reading the files. That gap has to be
   explained before anything is enforced.
2. Each affected job must first honestly declare the tools it actually needs. A
   job that needs to run commands says so.

The order matters and isn't flexible: **fix the declarations, then turn on
enforcement.** Doing it the other way converts a harmless do-nothing control into
a real outage across every scheduled job at once.

## One loose thread being tidied

An earlier lesson of mine concluded that the health-check job "produces nothing
because it can't run commands." The second half is false — it can, and does. So
whatever quiet behavior was observed needs a different explanation. The likeliest
one is simply that health-check is designed to speak only when something is
wrong, which would make 458 silent runs 458 healthy ones rather than 458
failures.

## What you actually need to decide

Step 1 (stop the false claim) and Step 2 (add the test) are safe and I'd ship
them regardless — they only make the system honest about what it already does.

The real decision is Step 3: whether you want these job restrictions to become
genuinely real. Making them real means the safety story becomes true, but it also
means a mistake in a job's declared tool list turns into a broken job instead of
a harmless log line. That's why it ships off, with a rehearsal mode, and why it
can't be switched on until the declarations are correct and the disk-versus-live
discrepancy is explained.

Rolling it back is a single setting, read fresh each time a job starts — no
restart, nothing to undo.
