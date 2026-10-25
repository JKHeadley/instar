# ELI16 — the feedback drain's epoch counter got stuck at 1

## The problem

The feedback drain keeps a small database. To stop two copies of the server from
writing to it at once, every write carries an "epoch" number: a counter that says
which owner is current. The database remembers the last owner's number and refuses
any write that carries a different one.

The database wrote its number once, back in August, when the server ran alone on one
computer and the counter was 1. Later the server switched to a coordinator, which hands
out much bigger numbers (22677 today, going up on each restart). The database still
wanted exactly 1, so it refused the real owner. Two jobs failed every time: the hourly
backup checkpoint (so there has been no fresh drain backup since August) and the
clean-up that runs after each drain run.

## What this change does

- The remembered number now moves forward with the real owner. A bigger number means
  a newer owner, so it is accepted and written down. A smaller number means an old,
  stale writer, and it is still refused.
- Every move forward is written to the audit log.
- On a single computer, a restart now picks up the remembered number. It no longer
  starts again from 1.
- Restores from a backup are still caught. That check looks at the database file
  itself, not at this number.

## What you need to do

Nothing. The next drain run fixes the stored number on its own, and backups resume.
