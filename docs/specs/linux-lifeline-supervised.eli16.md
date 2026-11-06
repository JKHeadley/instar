# Letting the Linux lifeline restart itself

## What this is about

Every instar agent has a small always-on process called the lifeline. It collects Telegram messages and keeps the main server running. The lifeline has a watchdog: when it notices it is stuck in a way only a fresh start can fix, it exits on purpose and expects the operating system to start it again a few seconds later.

It only does that when it is sure something will start it again. Otherwise exiting would take the agent down for good. It checks this by looking at which program started it.

## What is wrong today

On a Mac, instar's launch file says outright "you are supervised", because the lifeline is started through a small shell script and the check alone would be fooled by that script. The Linux service file never got the same line. So on Linux the lifeline always concludes nobody will restart it, and its watchdog never acts. It just writes "would restart, but unsupervised" to the log every 30 seconds while the agent stays stuck.

We saw this on the two-server takeover test: a machine was stuck not answering Telegram for over 20 minutes, and its watchdog knew but would not act.

## What changes

- New Linux installs get the same "you are supervised" line the Mac has.
- Existing Linux installs get it added by the update, the same way an earlier update added another line to the same file. A backup of the old file is kept next to it.
- Nothing is restarted to apply it. It takes effect the next time the agent starts, which on Linux means the next manual restart or reboot.
- Linux agents will also pick up new code after a big update. Today the lifeline keeps running the old version until the machine reboots, for the same reason.

## A limit that was missing

Review found that the existing limit on self-restarts only controlled how often: at most one every 10 minutes. It never limited how many. A restart that doesn't fix the problem would repeat every 10 minutes forever. The alarm meant to catch that could never go off either, because of a counting mistake. This change fixes both, on every platform:

- At most 6 self-restarts a day for this kind of problem. Echo's busiest day on record had 3.
- The alarm now goes off at the 6th restart in an hour. If the restarts are spread out, the report comes when the daily limit is reached.
- When the daily limit is reached, the agent reports once that self-repair has given up, and keeps running as it is.

## What stays the same

Macs keep working as before, apart from the new daily limit. Each restart takes the agent away for about one to two minutes. Messages already in the lifeline's queue are kept on disk, and Telegram hands over again anything not yet processed.

## Safeguards

- An operator can opt a machine out with a small override file that updates never touch.
- Undoing the change is a code revert. The backup file beside the service file restores the old one on any machine.

## What a reader needs to decide

Whether Linux agents should restart themselves the way Mac agents already do, now with a daily limit. I recommend yes. Without it, the self-repair built for these stuck states does nothing on Linux, and Linux agents stay on old code after big updates.
