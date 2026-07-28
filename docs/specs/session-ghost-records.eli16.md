# Duplicate sessions on the dashboard — the ghost-record fix, in plain English

## What you saw

Your dashboard showed six copies of the same session on the Mac Mini ("Resource Limitation Mitigation", over and over). There was really only ONE terminal running — the other five entries were ghosts: leftover bookkeeping records from old restarts that nobody ever cleaned up.

## Why it happened

Every session has two parts: the real terminal (a tmux session) and a small bookkeeping record the dashboard reads. When a session gets restarted, the system creates a fresh bookkeeping record for the new terminal. During the stability crisis in early June, sessions on the Mini were restarted again and again — and each restart left the OLD record behind, still marked "running." Five restarts, five ghosts. The dashboard faithfully showed every record it found, so one terminal looked like six sessions.

## The fix

Terminal names are unique — there can never be two live terminals with the same name on one machine. So the fix enforces exactly that rule on the bookkeeping: the moment a new record registers as "running" for a terminal name, any OTHER record still claiming to be "running" for that same name is closed out and stamped with a note saying which record replaced it. The rule lives in the ONE place every session registration already passes through, so no restart path — present or future — can forget to clean up after itself.

## What it does NOT do

It never touches the real terminals — it closes paperwork, not programs. It can't close the wrong thing across machines (each machine keeps its own books, and the rule only applies within one machine's records). And if the cleanup itself ever hits an error, the new session still registers fine — the hygiene step is never allowed to break a real launch.

## How the old ghosts get cleaned

Ghosts already sitting on your machines collapse automatically the next time each session name restarts (which happens naturally). The five on the Mini were already cleaned by hand today.

## What you'll notice

The dashboard shows one entry per real terminal. That's it — no settings, no migration, nothing to turn on.
