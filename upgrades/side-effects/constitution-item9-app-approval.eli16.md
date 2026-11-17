# Approving from the Instar app, in plain words

## What changed

Instar's rules said a person could let their agent do more on its own only by replying in a private Telegram or Slack chat, or from an approval account they had accepted. Someone who only has the Instar app on their Mac or phone had no way to do it, so the "how careful should I be" question did nothing for them.

The rules now also accept a yes from a paired Mac or phone, under conditions:

- The device's key stays locked in its secure chip.
- The person unlocks the device (face, fingerprint or passcode) for each approval.
- Each approval covers one exact request, once, before it expires.
- The first device is the app that created the agent; later devices are added only from one already paired.
- The agent must never add a device itself. The list of devices is kept on the agent's own computer, so every approval says plainly that this isn't independently verified. A check from Apple can close that gap later.
- The person can withdraw this at any time, and an organization can forbid it.

## Who decided

Justin said he wants the Instar app alone to be the main way, with Telegram and Slack optional, and approved this exact wording on 16 November 2026. This is the 1.x half; the 2.0 rules change the same way in a paired pull request.

## What happens next

The approval path in the code is built separately, on top of the trust journey work, and it must meet every condition above.

The rulebook keeps a fingerprint of each section so nobody can change it quietly. Adding this paragraph changed the fingerprint of its section, so an independent reviewer re-read the whole section and agreed nothing conflicts, and the new fingerprint is recorded. The approved words did not change.
