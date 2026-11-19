# Approving from the Instar app, in plain words

An Instar agent starts out asking before it does things like sending emails for you. You can let it do some of those on its own, but only you can say yes. Until now, the only way to say yes was to reply to a card in your own Telegram or Slack chat with the agent. People who use just the Instar app had no way to say yes at all, so their agent was stuck at "ask me first" forever. Justin decided on 2026-11-16 that the app has to be enough on its own.

This change lets the app say yes. When the agent asks for more freedom, the app shows exactly what would change. You approve with your face or fingerprint, or your iPhone's passcode. On a Mac, only a fingerprint works, because the agent might be running on that same Mac and could know its password. Each yes counts once, for that exact change, and only before it expires.

Before the app can approve anything, you turn this on once, on that device, after reading a short statement. You can turn it off at any time, and approvals from that device stop at once. A second device can only be added if a device that already approves says yes to it. Every new device that gets paired is announced on the devices that approve.

There is an honest limit, and the app says it every time. The list of paired devices is kept on the agent's own computer, so in principle the agent could add a fake device of its own. So every approval made this way is labelled with that warning, and is never presented as independently checked. A later step, hardware attestation, could close that gap.

New agents get this switched on. Existing agents keep it off until it is turned on, so nothing changes for them by surprise. Telegram and Slack approvals work exactly as before.
