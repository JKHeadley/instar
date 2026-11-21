---
title: Restarting the server and boot readiness
---
To restart your own server (for example after changing a setting that is read only at start), ask through the API with your name and the reason; never write `state/restart-requested.json` by hand, which restarts with no one named. Many settings apply live, so check first whether a restart is needed at all.

```bash
curl -X POST http://localhost:{{port}}/server/restart -H "Authorization: Bearer $AUTH" -H 'Content-Type: application/json' \
  -d '{"requestedBy":"<your session name>","reason":"<one line: why>"}'
```

It answers 202, after a wait of up to 8 s while the lead is secured, and the supervisor restarts within about 10 seconds (later while a Local Verify run holds it). On a development agent, a restart asked for this way (or by an update, a role change, the app or dashboard restart, or the Telegram fix command) keeps this machine's lead across the restart: the lease is renewed with a longer expiry while the request is pending, and at boot the same lease is confirmed back by a peer before anything is held. A kill or a lifeline-level kickstart writes no request and does not keep the lead until the role change no longer needs a restart (a later build). `/health`'s `multiMachine.syncStatus.pendingRestart` says what is pending, and the `lease-continuity:` log sentences say what happened. If the server restarted less than 2 minutes ago it answers 429 with `Retry-After`: wait, then ask again only if still needed. While a server boots it already answers on its port: every route, `/health` included, is a 503 with `Retry-After` and `bootReadiness.state` `"starting"` (with `retryAfterSeconds` and each subsystem's state), so a peer or script waits instead of treating it as dead. Once it serves, `/health` is 200 with `bootReadiness.state` `"ready"`. With your token, `bootReadiness.previousRestart` names who asked for the last restart.
