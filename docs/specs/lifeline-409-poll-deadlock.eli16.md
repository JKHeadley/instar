# A machine that takes over now starts answering Telegram

## What was wrong

When an agent runs on two machines, only one of them should collect Telegram messages at a time. If both try, Telegram answers the second one with an error called a 409 ("someone else is already collecting"). The lifeline, the small process that collects messages, counts those 409s, and since a recent change it refuses to start collecting while that count is above zero, so it never becomes a second collector.

The count only went back to zero after a successful collection. On the two-server test, the network link between the machines was cut, both collected for a few minutes, and both got 409s. When the link came back, the second machine stepped aside and stopped collecting, still holding its count. Later the first machine was switched off. The second machine took over correctly, but its old 409 count told it someone else was still collecting, and it could never make the one successful collection that would clear the count. It stayed silent for the whole outage.

## What changes

- A 409 only counts as "someone else is collecting" for two minutes. While a machine is really collecting, a fight with another collector produces a fresh 409 at least once a minute, so a real conflict is never missed. A machine that handed the job over and gets it back within two minutes of a 409 still waits.
- A machine that stepped aside no longer tells its watchdog it is "stuck in a fight", so the watchdog stops asking for restarts it doesn't need. A new fight later is timed from its first 409.

## What stays the same

The rule itself does not change: a machine still never starts collecting while there is current evidence that another one is. The handover still waits 20 seconds to ride out flapping, and it still checks that it holds the lease before collecting.

## Safeguards

If an old count lapses while another machine really is collecting, the newcomer gets a 409 within one round, backs off, and the normal conflict handling takes over, the same as on any first start.

## What a reader needs to decide

Nothing. This is a narrow bug fix with no setting, no migration and no change in normal operation. A second defect found in the same test (the lifeline's self-restart never runs on Linux) is a separate change.
