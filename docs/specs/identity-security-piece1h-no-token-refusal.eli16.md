# A missing or unreadable API key, explained simply

Your agent's control panel (its API) asks every caller for a secret key. Two things can go wrong with that key, and this change makes both safe and visible.

**The key exists but can't be read** (for example, the secure store it lives in didn't open). Until now the agent crashed on every request that needed the key. Now it refuses those requests cleanly. Everything that has its own proof keeps working: your phone's signed requests, your agent's other machines, other agents, document pages and the PIN screen. The agent keeps retrying the store, and if that doesn't work within about ten minutes, it tells you.

**There is no key at all.** This is rare (every new agent gets one), but older installs can have it. Then anyone who can reach the agent can control it. This change doesn't suddenly lock that agent down, because doing that automatically breaks running conversations and message relays. Instead it tells you plainly, and your agent offers to set up a key for you. Say yes, and it makes the key and checks that your messages still arrive. Turning on a hard lock for such agents will be your choice later.

Two small fixes come along. The relays that carry your Telegram and Slack messages never send a broken key, and they pick up a new key on their own when the agent's key changes. New sessions are never handed a broken key either.
