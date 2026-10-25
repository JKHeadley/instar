# ELI16 — the feedback sorter tripped over its own notes

## The problem

Fleet agents send bug reports. The feedback sorter ("drain") reads them from a log file,
groups similar ones, asks a model which groups are ready to become a task, and creates
those tasks.

The log file is append-only: nothing is ever edited in place. When the sorter files a
report into a group, it writes a new copy of that report's line at the end of the file,
marked "processing". The newest copy wins.

The sorter also keeps its own index of every line it has read, with a fingerprint of each.
When it reached its own "processing" copy, it saw the same report id with a different
fingerprint and decided the file had been tampered with. It stopped the whole run. Every
run after that stopped at the same line, so no group ever became a task.

The scheduled job that drives the sorter reported "success" anyway. It runs on a small
model that wrote its own shell loop, and that loop crashed on a variable name the shell
reserves (`status`).

## What this change does

- The sorter's own updates now get a new record id each time, as the design always said
  they should. So a new copy is never mistaken for a changed old one.
- The 1,000 old copies already in the file changed only the "processing" mark and the group
  name. Those are accepted as updates. Any other change under an old id is still treated as
  tampering.
- Tampering no longer stops everything. Only the bad line is set aside and logged, and the
  rest of the run continues. Every run is then marked "degraded", so the scheduled job keeps
  failing and alerting until a person repairs that line.
- The false alarm already stored on the live machine clears itself on the next run, with
  an audit entry.
- Two waste fixes found on the way: after the log is compacted, the sorter no longer
  re-reads everything from the start, and an unchanged log is no longer copied again.
- The scheduled job now runs one fixed script. A refused, degraded, or failed run fails
  the job, with the reason.

## What you need to do

Nothing. The next run heals the stored state, and the job update arrives with the
normal instar update.
