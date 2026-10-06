# A joined machine ends up supervised by the lifeline, like the first

## What Changed

`instar join` installs a standby's LaunchAgent with `server start` (its scaffolded config has no Telegram, and the lifeline needs one), and nothing revisited that once Telegram was configured; join's closing text also told the operator to `instar server start` a second, unsupervised server (instar#2122, Luna/sagemind).

- Server boot's auto-start self-heal (macOS) now regenerates the LaunchAgent with the lifeline when Telegram is configured but the plist starts the bare server (`autoStartNeedsLifeline` in `src/commands/setup.ts`).
- `instar join` no longer suggests starting a server when auto-start was installed.

## What to Tell Your User

If you add a second machine, once Telegram is set up there it starts at login the same way as the first machine, with my watchdog keeping the server running. The join steps no longer tell you to start a second copy of the server.

## Summary of New Capabilities

None — an auto-start repair and corrected join instructions.

## Evidence

- `tests/unit/autostart-needs-lifeline.test.ts`: server plist + Telegram configured → switch; lifeline plist → leave; server plist without Telegram → leave.
- The predicate matches the real LaunchAgent format on this machine (`<string>lifeline</string>` in the ProgramArguments of Echo's and Luna's plists).
