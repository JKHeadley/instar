# Doorway scan: making the scan real, in plain English

**What this is.** Instar keeps a map of the ways an agent can reach AI models:
Claude Code, Codex, Gemini and so on. Each is called a doorway. A weekly job is
meant to check that each doorway still answers, and write what it found to a
file on that machine.

**What was wrong.** The checking code was written and tested, piece by piece,
but the final step that runs those pieces was never finished. The program
printed a note saying it was not switched on yet, then reported success. So the
job looked healthy for weeks while no check ever happened. The "must fail"
safety checks passed too, because they tested how the job reports a crash, not
whether a scan took place.

**What changes.** The program now really does the checks and writes the file.
The job counts as a success only if that file exists and this run wrote it. A
new daily safety check uses a fake program that claims all is well and writes
nothing, and the job must call that a failure. If it ever stops doing so, the
safety check itself raises an alert.

**What happens when something changes.** If a doorway that worked stops working
on two scans in a row, you get one plain-English notice. A doorway that was
never installed raises nothing. If the notice cannot be delivered, it comes
back on the next scan instead of being lost.

**What it costs.** Nothing in money or tokens. The job only asks each program
for its version number. Paid checks stay off, and are now refused for everyone.

**What it does not do.** It proves a doorway answers. It does not discover new
models, because none of the current doorways has a free way to list them. The
map of top models still comes from a human review.

**What you need to decide.** Nothing. The job ships off for other agents, and
undoing this is a plain revert.
