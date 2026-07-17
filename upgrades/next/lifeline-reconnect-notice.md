## What Changed

When the lifeline can't hand a message off to the server but the server is
confirmed **healthy** (a transient timeout / 5xx / connection blip on a single
forward), the queued-message notice no longer says the false, alarming
"Server is restarting." It now reflects the real state: "I'm having trouble
reaching my server right now — your message is queued (N in queue) and I'll
deliver it as soon as I reconnect." The genuinely-down message
("Server is temporarily down…") is unchanged. The message, photo, and file
handlers all route through one shared helper (`buildQueuedNotice`) so the two
states can't drift apart again.

## What to Tell Your User

If a message of yours briefly can't be delivered while my server is actually
up, you'll now see an honest "reconnecting, your message is queued" note
instead of a scary "Server is restarting" alarm. Nothing about delivery
changed — your message was never lost; it queues and delivers as before. This
only fixes the wording so it stops claiming a restart that never happened.

## Summary of New Capabilities

No new setting. This is a bug fix to an existing user-facing notice.

## Evidence

- New unit test (`tests/unit/lifeline/queuedNotice.test.ts`, 8 cases) proves the
  healthy-but-forward-failed branch never says "restart" or "temporarily down"
  and always says "reconnect", and that the genuinely-down wording is preserved
  byte-for-byte.
- Full lifeline unit suite passes (18 files / 160 tests); TypeScript build and
  `pnpm build` are clean; exactly one "Server is restarting" string remains in
  the compiled lifeline (the separate callback-query server-down case, out of
  scope).
