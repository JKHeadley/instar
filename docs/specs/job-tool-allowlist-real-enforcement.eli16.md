# Job tool limits that actually limit — plain-English overview

## What this is

A scheduled job can say which tools it is allowed to use, for example "only the shell"
or "only reading files". The scheduler also cuts a job down to "reading only" when the
job asks for every tool without being authorized to. Today none of that does anything:
every job session starts Claude with a switch that skips all permission checks, so the
list is written down and then ignored. We checked this on the real Claude program today:
a job limited to reading still ran a shell command and wrote a file.

Worse, the scheduler says the opposite. Its event reads "clamped to Read", and the
health digest says the job "will run with Read-only tools". That is false comfort.

## What already exists

Triage sessions already use a working limit: Claude starts without the skip-permissions
switch, in a mode that refuses any tool not on the list, with no extra tool servers
loaded. If the limit does not apply, the launch fails rather than running unlimited.
We tested that form today too: reading worked, the shell was unavailable, and no file was
written. With the shell as the only tool, the shell worked and file-writing was refused.

## What is new

1. Jobs whose author wrote a tool list, and jobs the scheduler cut down for asking for
   everything without permission, now start Claude in that same limited mode.
2. A built-in job whose lock file says it may have been tampered with is cut to reading
   only, whatever list it declares, and if it would land on an engine that cannot be
   limited it does not run at all.
3. Jobs with no list at all are left alone, and so are user jobs whose list is just
   "reading only": older installs wrote that list into jobs automatically, so it was never
   anyone's choice. Most user jobs have no list and quietly use
   the shell every day; limiting them would break them, and nobody asked for it.
4. A job running on Codex (or another engine with no per-tool switch) is not limited,
   and the scheduler now says so plainly in an event, the health digest and the run
   record, instead of pretending.
5. A list with names the limited mode cannot honour (tool patterns, MCP tools) is not
   applied, and the record says why. Names are checked against the tool names the installed Claude
   actually accepts (read from Claude's own start-up record), because a misspelled name
   makes Claude start with no tools at all, and some familiar names are quietly ignored.
6. Every run now records whether its tool list was really enforced, and the reason.
   The record is taken from what the launch actually did, not from what was asked.
7. The event and digest wording now say what really happens, decided after the launch
   from what the launch actually did, and repeated at most once a day per job.
8. A list that includes the shell is labelled as such: it limits Claude's tools, not what
   the job can do through the shell.
9. A job's author can mark its list as binding ("toolAllowlistEnforce: true"). Then
   the list is applied exactly, even a plain "reading only", and if it cannot be applied
   (a misspelled tool, or an engine with no per-tool limit) the job does not start,
   rather than running without its limit.
10. Every limited job's instructions now start with one fixed plain line. We found that
   when instructions are typed into Claude's chat box, a first character of "!" runs a
   shell command even when the shell is not allowed; with the plain line first, that
   cannot happen. Later messages into a limited job get the same protection, and
   messages relayed from other sessions are not typed into it at all.

## Who gets it, and when

It is on for development agents (like Echo) and off for everyone else for now. Other
agents' jobs may declare lists narrower than what the jobs really do (nobody could tell
before, because the lists did nothing), so turning it on everywhere at once could stop
some jobs. Before it goes fleet-wide, those lists get counted and checked; that work is
tracked. The switch has to read the same on every machine of an agent. On Echo, one of
Echo's own review jobs becomes truly limited today; four built-in shell-only jobs would
too, but they are switched off on Echo. The built-in jobs that need everything already
have that permission and do not change.

## Safeguards

- One setting turns it off again, read at every launch, no restart.
- Nothing is refused that ran before, except a possibly tampered built-in job on an engine
  that cannot be limited. A list that cannot be applied leaves the job as it
  is and says so.
- The existing check that fails a launch if the limit did not apply is kept as is.

## What you need to decide

Nothing. This follows the approved proposal (EVO-008). The fleet-wide switch-on is a
later, separate step once the old lists are counted.
