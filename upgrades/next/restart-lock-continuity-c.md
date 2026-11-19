# A locked testing machine is reported once

<!-- bump: patch -->

## What Changed

A machine that runs Local Verify, or one set up to look after itself, now reads its screen lock every 5 minutes. When the screen has stayed locked for 10 minutes, one report goes out naming the machine and when the lock started. This happens once per lock per machine, even when several agents run there.

A desk machine that coordinates Local Verify reports only while verification work is waiting, so locking it for lunch does not alert. At most 3 reports go out per machine per hour, except when the lock is blocking work.

The lock reader now starts whether or not machine maintenance is enabled, so `GET /machine-maintenance/lock-state` answers on every machine, and it now includes the watch's state.

## What to Tell Your User

- **Locked testing machines**: "If one of the machines that runs tests gets its screen locked for 10 minutes, I'll tell you once. Tests there can fail while it's locked, and only someone at the machine can unlock it."

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Lock watch on testing machines | Automatic; state in `GET /machine-maintenance/lock-state` |
