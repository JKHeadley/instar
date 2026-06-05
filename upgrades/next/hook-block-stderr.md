<!-- bump: patch -->

## What Changed

Fixed an invisible-verdict bug in the pre-send message-quality gate. When the gate
blocked an outbound message, it wrote its reasons to the wrong output channel, so
the agent saw a generic "hook error" instead of the actual findings — and would
retry blind. The reasons now land on the channel the runtime actually shows, so a
blocked message comes back with the specific quality findings to fix.

## What to Tell Your User

Your agent's pre-send quality check now explains itself. If it holds a message
back, the agent sees exactly why and revises, instead of appearing to hit a
mysterious error.

## Summary of New Capabilities

- Blocked outbound messages surface their quality findings to the agent instead
  of an opaque hook error.
- Maturity: stable; the gate's judgments are unchanged — only their visibility.
