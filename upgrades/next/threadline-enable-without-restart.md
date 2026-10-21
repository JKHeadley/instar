# Upgrade Guide — vNEXT

<!-- bump: patch -->

## What Changed

- **An agent can switch on its connection to other agents without its person restarting anything.** New route `POST /threadline/pairing/enable` (Bearer). It sets `threadline.relayEnabled` and `threadline.verifiedPairing.enabled` in `.instar/config.json`, leaving every other key alone, and when that needs a restart it requests the server's existing supervised restart (the same `state/restart-requested.json` flag the auto-updater writes, marked as planned maintenance). The agent's conversation survives the restart: it tells its person one sentence ("I'm switching on my connection to other agents. I'll be back in about a minute, then I'll give you the invite."), waits for `GET /threadline/pairing` to answer 200, and makes the invite. Before this, the agent had to ask its person to send `/lifeline restart`.
- The route restarts only when it would help and only once: it answers `ready` when pairing already works, `unavailable-here` when another machine holds the relay or this one is a standby, `restarting` when a restart is requested or already on its way, `deferred` while another session is actively working (the same rule update restarts follow; the server finishes by itself if that work settles within five minutes; never deferred under `updates.restartImmediately`), `not-ready-after-restart` if a restart for this in the last ten minutes did not make pairing work, and `restart-unavailable` when no Instar lifeline is running to bring the server back (the lock's pid must really run `instar … lifeline start` and have the start time the lifeline recorded in its lock; it never restarts a server that would stay down).
- A pairing invite waiting for approval holds the enable restart the same way it holds update restarts, so a restart never destroys pairing work already under way. The wait is still capped: after five minutes the request stops, logs `gave-up`, and records it (config written, restart still pending, with what held it). `GET /threadline/pairing/enable` shows a waiting or given-up request. The change applies at the next restart.
- The two config keys are written with a compare-and-swap. If another process changed `config.json` between the read and the write, the write starts over from the new content, so that change is never lost.
- "Connecting to another agent" step 1 now uses this route and tells the agent never to ask its person to restart anything or change a setting. Existing agents that already have the section get the new step 1 in place of the old one on update.
- Fixed: the lifeline supervisor counted restart requests per target version to catch update loops, and requests that named no version (the money-layer enable restart, the "restart" fix command, and now this route) all shared one count that never reset, so every third one was silently skipped. Only update restarts are counted now.
- The self-knowledge node for connecting to another agent may now return up to 1400 tokens, so the whole procedure arrives.

## What to Tell Your User

If you ask me to connect with another agent and my connection is switched off, I switch it on myself. I'll be away for about a minute and then I'll hand you the invite. You don't need to restart anything.

## Summary of New Capabilities

- `POST /threadline/pairing/enable`: switch the agent network and pairing on, restarting the server by itself when needed.

## Evidence

- `tests/unit/threadline-connect-enable.test.ts`: every restart decision, the config write, the restart flag, the deferred retry with the asking session excluded, the update gate read, the supervisor no longer skipping version-less restarts while still catching update loops, and the knowledge for new and existing agents.
- `tests/integration/threadline-pairing-enable-route.test.ts`: the route on a real AgentServer excludes the asking session, defers behind other work, refuses without a lifeline and on a standby.
- `tests/e2e/threadline/pairing-enable-without-restart.test.ts`: an agent with relay and pairing off, on a real relay, makes one call; the real ForegroundRestartWatcher picks up the request, the server boots again from the config on disk, and the agent makes an invite. No person action anywhere.
