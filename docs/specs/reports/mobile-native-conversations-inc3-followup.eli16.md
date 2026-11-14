# Phone pairing without Telegram: three small fixes after review (ELI16)

This change makes three small fixes to the "pair a phone without Telegram" feature that shipped in PR #2586. An independent reviewer read that PR and agreed with it. It also found three small things worth tidying. None of them changes how pairing works for a person using it.

**1. A missing test for the normal case.** When an agent has Telegram and knows who its owner is, the 6-digit pairing code must still go to the owner's private Telegram chat, exactly as before. The earlier tests checked this with a hand-built setup, but not through the real server's own startup path. The new test starts a real server with a pretend Telegram connection that reports an owner. It then checks that the code goes to the private chat and that nothing waits on the dashboard.

**2. An overstated sentence.** The instructions the agent reads about this feature said "my token alone cannot see it" about the pairing code shown on the dashboard. That was too strong. The agent can read the dashboard PIN from its own settings file, so a code shown after a PIN unlock is not hidden from the agent. The sentence now says it plainly: this path only proves that someone could unlock the dashboard, which is weaker than a private Telegram chat. Agents that already received the old sentence get it swapped for the new one when they update.

**3. A leftover code.** The dashboard shows a waiting phone's code until the pairing ends. If the server could not read its list of phones at the moment it tidies up, it hid the code from the dashboard but left the same code usable for confirming. Now it removes both together, so a code that is no longer shown can never be used.

What you need to decide: nothing. These are small corrections to an already-reviewed feature.
