# Side effects: Always available, nothing starts a second copy (spec §B.3, §B.5)

## Change
- `src/core/alwaysAvailable.ts` reads `/Library/Application Support/Instar/always-available/<agent>.json`, the root-owned record the Mac app's helper writes. Only a missing record means off. Anything unclear counts as on with a daemon: a read error, broken JSON, an unknown version, another agent's name, or a daemon value that isn't false.
- `installAutoStart` (`setup.ts`), the funnel every per-user plist writer goes through. While the daemon runs the agent, a real install is refused, even with `--force`. An update's `noStart` call still refreshes the boot wrapper (the daemon runs it) but writes no plist and loads nothing.
- The fleet watchdog template skips a daemon-run agent before any reload. A record folder it can't search skips too. Existing agents get the script through `migrateFleetWatchdog`.
- `instar server restart` prints a plain refusal under the daemon.
- `instar lifeline restart` skips the per-user kickstart and uses the existing proven-pid signal path. The daemon's KeepAlive starts the lifeline again.
- The server startup self-heal doesn't try to reinstall the per-user item.
- `LaunchdRecoveryControl.start` refuses (`recovery-always-available-daemon`).

## Who is affected
Nobody until the Mac app's helper writes a record: that is part B's Mac side, with echo-instar-desktop-app. Without a record, every path behaves exactly as before.

## Contract with the helper (sent to echo-instar-desktop-app, which agreed)
The record is `{version:1, agent, daemon, daemonLabel, setAt, …}`, root-owned. While `daemon` is true:
- the per-user plist is moved aside, to `.plist.always-available`;
- the daemon runs the same boot wrapper path, as the person's user, with KeepAlive.

Undo reverses both.

## Known limits
- Recovery bindings for an agent enrolled in recovery aren't restaged while the daemon runs it. They are restaged when the per-user item is installed again after turn-off.
- The PostUpdateMigrator's direct plist writes only touch a plist that exists, so they rely on the move-aside.

## Rollback
Revert. Without records, nothing changes.
