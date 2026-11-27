# Match a private Telegram enrollment button

The dormant matcher ties a private Accept button to its original displayed message, current owner and accepted account, holder, exact nomination digest and expiry.

- Authority. Only authenticated local Telegram ingress may supply the tap. This helper cannot mint or consume nominations or accept a device.
- Replay. The future holder must consume the matched callback and write the exact nomination durably before offering phone confirmation.
- Rollback. No bot, live caller, installed state, or authority change.

Independent review concurred for the isolated matcher. The future ingress must authenticate the original bot message and consume the callback once.
