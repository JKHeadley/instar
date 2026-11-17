## Approve trust raises from the Instar app

- **What changed:** a person who uses only the Instar app can now approve a raise in what their agent may do without asking (for example, "send reminders without asking each time"). Before, that needed a reply in a Telegram or Slack direct chat; with no chat, the agent could never get past "Ask me first".
- **How it works:** the app shows the exact change. The person approves it with Face ID or Touch ID, or the iPhone's passcode. A Mac approves only with Touch ID: the agent may control that Mac, so a password the agent might know doesn't count.
- **Turning it on:** the person turns this on once on their device, in a recorded statement they can withdraw at any time.
- **What each approval carries:** every approval is recorded and shown with a plain warning. The list of paired devices is kept on the agent's own computer, so the agent could add a device whose approval would look the same.
- **Who gets it:**
  - New agents made by the installer: on.
  - Existing fleet agents: off until `mobilePairing.trustApproval.enabled` is set.
  - Development agents: on.
- **Chat approval:** unchanged. When both a chat and an accepted device exist, either can approve; the first to arrive counts, once.
- **Constitution:** this implements the paired-device text Justin approved on 2026-11-16 (instar #3296, instar-2 #205).
