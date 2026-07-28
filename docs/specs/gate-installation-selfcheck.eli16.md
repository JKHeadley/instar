# A gate that could be silently absent now says so

## The problem

Instar's development gate runs as a git pre-commit hook. Before any change to instar's own
behaviour can be committed, the gate checks that the change carries its required paperwork — a
plain-English overview, a side-effects review, and a trace recording that the change went through
the proper process.

That gate can be completely absent, and nothing tells you.

A developer working on instar creates an isolated copy of the repo using `git worktree add`. That
copy inherits the setting saying "look for hooks in this folder" from the main repo — but the folder
itself does not exist until the dependencies are installed. In that state, committing runs no hook at
all. It prints nothing, and it succeeds.

So a working gate and a completely uninstalled gate look **identical on screen**: both are silent.

This is not hypothetical. On 2026-07-27 an entire change was committed in the belief the gate had
approved it. The gate had never executed. The silence was read as a pass.

## Why the gate cannot fix this itself

A hook that is not installed cannot run in order to announce that it is not installed. Absence
cannot report itself. Any fix has to live somewhere that actually executes.

## What changed

The check was added to the step the developer runs by hand just before committing: writing the
trace. That step is the one that *asserts* "this change went through the proper process" — and that
assertion is false if the gate cannot run at all.

So before writing a trace, the script now verifies the gate is genuinely installed: that the
configured hooks folder exists and contains a pre-commit hook, or that a hook is installed the
classic way. If it is not, the script refuses to write the trace and explains exactly what is wrong
and how to fix it.

## Being honest about what this can and cannot do

This is a signal, not an enforcement. It cannot block a commit — the very situation it detects is the
one where no commit hook runs. What it does is convert a silent absence into a loud one at the moment
the developer would otherwise proceed believing everything was checked.

There is an escape hatch for environments that genuinely have no hooks. Using it is recorded in the
trace itself, so a trace written without a live gate can never later be mistaken for one the gate
approved.

And the check deliberately does not apply outside a git repository at all. Where there is no
repository there is no commit, so there is nothing to gate and nothing to be misled about. That
matters practically: several existing tests drive this script inside a bare temporary folder, and
they keep working without every future test author having to remember a special setting — which
would be exactly the kind of "remember to do it" burden this change exists to remove.
