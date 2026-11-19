# When the Instar app on your Mac loses its key (ELI16)

## What was wrong

When the Instar app on your Mac creates an agent, it connects to that agent with a secret key it keeps. If the app is reinstalled or loses that key, it makes a new one. The agent then refused the new key forever ("Another app has already connected to this agent."), so you couldn't reach an agent your own Mac had just made. That happened to Justin's "Testy" agent.

## What changed

The app can now say "this is the same Mac, and I lost my old key". The agent checks that the earlier connection really was made by this same computer, and that the request comes from the agent's own user account on it. Then it removes the old connection and accepts the new key in one step, and tells you it happened.

A connection made from a different computer can never be replaced this way, and neither can a phone you paired yourself. Nothing reachable over the internet can trigger it.
