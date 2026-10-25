# Side-Effects Review — a joined machine ends up supervised by the lifeline, like the first

**Version / slug:** `join-autostart-lifeline`
**Date:** `2026-10-05`
**Author:** `echo`
**Second-pass reviewer:** `not required (auto-start self-heal extends an existing check; join output text)`

## Summary of the change

instar#2122 (Luna/sagemind second-machine bring-up): "`instar join` installed a `server start` LaunchAgent instead of `lifeline start` (unlike the first machine and Echo's Studio), and it started a stray server outside the supervisor."

`instar join` scaffolds a machine-local config with `messaging: []` (the Telegram token is machine-local), so `installAutoStart` correctly picks `server start` at join time — the lifeline refuses to run without Telegram config. Nothing ever revisited that once Telegram was configured on the standby. And join's closing text told the operator to run `instar server start`, though auto-start had already launched one, producing a second, unsupervised server.

1. Server boot's existing auto-start self-heal (which already regenerates stale plist formats) now also regenerates the LaunchAgent with the lifeline when Telegram is configured but the plist starts the bare server (`autoStartNeedsLifeline` in `setup.ts`).
2. `instar join` no longer tells the operator to start a server when auto-start was installed.

## Decision-point inventory

One added condition in the boot self-heal: "Telegram configured AND plist lacks `lifeline`" → reinstall.

## 1. Over-block

Nothing is refused. An agent with Telegram configured that deliberately runs a server-only LaunchAgent is switched to the lifeline — the same outcome the self-heal already produces whenever it reinstalls for any other reason (it passes the Telegram flag).

## 2. Under-block

macOS only (the plist check lives in the darwin branch, like the existing format checks). Linux systemd units are unchanged. The standby lifeline's own Telegram-polling behaviour is unchanged (it already suppresses polling under `multiMachine.telegramPolling: false`).

## 3. Level-of-abstraction fit

Extends the one place that already repairs auto-start drift at boot.

## 4. Signal vs authority compliance

No new authority over agent behaviour; an install-time repair.

## 4b. Judgment-point check

Not a competing-signals decision.

## 5. Interactions

Reinstalling reloads the LaunchAgent, which restarts the server once under the lifeline — the same one-time restart the existing format self-heals cause. On the next boot the plist matches and nothing further happens.

## 6. External surfaces

One boot log line when it switches; `instar join` closing text.

## 7. Multi-machine posture (Cross-Machine Coherence)

Machine-local by design: each machine's LaunchAgent is its own.

## 8. Rollback cost

Revert; a switched plist keeps running the lifeline, which is the intended state.

## Conclusion

A joined standby converges on the same supervision as the first machine once it can, and join stops inviting a duplicate server.
