# Restarting the agent on Linux no longer wipes out its sessions

## What the change is

On Linux, Instar runs your agent as a background service that the operating system's service manager, systemd, looks after. Every conversation and long-running job the agent works on lives inside a program called tmux, which keeps terminal sessions alive in the background.

Until now, when that service was restarted (for example with `systemctl --user restart`), systemd did what it does by default: it stopped every program the service had ever started. tmux was one of them. So a routine restart wiped out every running session at once, including long autonomous runs that were in the middle of real work. That happened on the Mama PC on 2026-10-22 and an autonomous run had to be revived by hand.

The fix is one setting in the service file, `KillMode=process`. It tells systemd to stop only the agent's main program on a restart and leave everything else, including tmux and all the sessions in it, running. When the agent comes back up it finds its sessions still there.

## What already exists

On macOS this was never a problem. The Mac's service manager only stops the main program's own group of processes, and tmux leaves that group when it starts, so Mac sessions already survive a restart. This change gives Linux the same behaviour.

When the agent's supervisor (the "lifeline") restarts, it already checks whether the agent's server is still running and healthy, and if so it simply carries on with it instead of starting a second one. That existing check is what makes it safe to leave things running.

## What is new

- New Linux installs get the setting in their service file.
- Existing Linux installs get it on their next update: the updater adds the one line, keeps a backup copy of the old file, and tells systemd to reload its settings. Reloading does not restart anything; it just means the next restart already behaves the new way.
- If someone already chose their own setting for this, the updater leaves it alone.

## Safeguards

- The updater only touches the agent's own service file, only adds the line when no setting is present, and keeps a dated backup.
- Running it twice changes nothing the second time.
- Nothing about Mac or Windows changes.

## What this does not fix

The same night, the Mama PC had a second, different failure: the whole per-user service manager shut down when the original login session closed, even though it was configured to stay running without a login. When that happens everything under it stops, tmux included, and this setting cannot help. That is being looked at separately.

## What you need to decide

Nothing. This is a small correction to how the service is stopped. One detail: a bare systemd restart now restarts only the agent's supervisor and leaves its server running (the same as on a Mac). The agent's own `instar server restart` command knows this and restarts the server too.
