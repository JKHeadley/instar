# Lifeline version-skew recovery — what this fix does (ELI16)

## The story

The instar agent runs as two pieces on the same machine: a SERVER
(handles the real work) and a LIFELINE (handles Telegram message
delivery so the agent stays reachable even when the server is
restarting). They run as separate processes and talk to each other
over HTTP locally.

When the agent updates itself, the SERVER updates first because that's
where the auto-update code runs. The LIFELINE only catches up the next
time it restarts. In between, the server is on the new version and
the lifeline is on the old one. The server has a safety check: if a
forward comes in from a lifeline more than one minor-version behind,
it refuses with HTTP 426 (Upgrade Required).

That's the trigger. The handshake fires, the lifeline learns it needs
to restart, and asks the system to restart it. That should take a few
seconds. Done.

Except in the field on 2026-05-19, it didn't. The agent (b2lead-insights)
went silent for 21 HOURS. The operator only noticed when they sent a
Telegram message and got no reply. The lifeline was alive, but every
Telegram message they sent was being silently dropped after 3 retry
attempts.

## What was wrong

Five independent bugs all needed to fail for the user-visible outage to
happen. Any ONE of them being fixed would have made the agent
self-heal. All five being broken is what made it silent and lasted
21h.

1. **Cooldown timer blocked every restart attempt.** The lifeline asks
   the restart-orchestrator to restart it. The orchestrator says
   "I just restarted recently — cooldown active, try again later".
   That's correct for a flaky-server-came-back-up case. For a
   permanent version mismatch, the cooldown is wrong: no amount of
   waiting fixes the mismatch.

2. **Three failed forwards in a row = drop the user's message.** The
   lifeline's replay loop counts failures. After three failed
   forwards, the message is dropped with a degradation event. That
   policy is right when the failures are transient (server briefly
   down). It's wrong when the failures are caused by a version
   mismatch that won't resolve without a restart that's been blocked
   (see #1).

3. **The CLI command for "restart my lifeline" had the wrong service
   name.** The plist on disk calls the service `ai.instar.b2lead-insights`.
   The CLI restart command looked for `com.instar.b2lead-insights.lifeline`.
   Different domain (`ai` vs `com`), different suffix. launchctl
   couldn't find the service, fell back to pkill, which set up bug 4.

4. **The pkill fallback left a sleeping process holding the lock.**
   `pkill -TERM` sent the polite kill signal. The old lifeline got the
   signal but didn't actually exit — it went to "sleeping" state and
   sat there. It still held `.instar/lifeline.lock`. The new lifeline
   tried to start, found the lock, said "another lifeline is running",
   and exited. In a loop. Forever, until the operator manually
   `kill -9`'d the stuck process.

5. **Native module "rebuild" lied about success.** When better-sqlite3
   gets the wrong Node ABI (which happens when Node upgrades), the
   healer runs `npm rebuild better-sqlite3`. npm exited 0 but the
   resulting binary was STILL the old wrong-ABI one — it had pulled a
   cached prebuilt instead of actually compiling. The healer logged
   "rebuild succeeded but module still fails to load" and gave up.

## What this PR does

Five precise fixes — one per bug — that work independently and stack:

1. **Bypass the cooldown for the `versionSkew` bucket.** The daily cap
   (max 3 version-skew restarts in 24h) still applies, so a
   misconfigured server can't infinite-loop. But the per-minute
   cooldown is gone for this specific failure type.

2. **Don't drop messages while a version-skew is active. Send a
   user-visible alert.** When the lifeline detects HTTP 426, it sets a
   flag (`versionSkewActive`), sends ONE Telegram message to the user
   explaining ingress is paused and their messages aren't lost, then
   re-queues every replay without counting it against the drop budget.
   When the forward starts succeeding (lifeline restarted onto the
   new version), the flag clears automatically.

3. **Fix the CLI service label.** Change `com.instar.${name}.lifeline`
   to `ai.instar.${name}`. One line, but it changes the fallback path
   from "always fall back to pkill" to "actually use launchd
   kickstart".

4. **Make the pkill fallback escalate. Make the lock-acquire smarter.**
   Pkill now sends SIGTERM, waits 3 seconds, sends SIGKILL by name
   pattern. And the lock-acquire code now recognizes "process sleeping
   for >5 min after lock-write" as a stuck process and sends its own
   SIGTERM → SIGKILL sequence to take over.

5. **Force `--build-from-source` on the npm rebuild.** This tells npm
   "don't use a cached prebuilt; actually compile from source against
   my current Node ABI". The rebuild is slower (~30s instead of ~5s)
   but it actually produces a binary that loads.

## What it doesn't do

- Doesn't change the auto-update flow. The skew happens BECAUSE the
  auto-update worked on the server but the lifeline lagged. A
  forward-looking fix would have the auto-update tell the lifeline to
  restart too. That's a bigger change and out of scope for today.
- Doesn't change message-queue persistence — only the drop-vs-re-queue
  decision.
- Doesn't touch the Remediator architecture (the long-term replacement
  for ad-hoc recovery logic). That work is happening separately.

## Trade-offs

- **User gets one Telegram alert per skew episode.** That's the
  point — agent-appears-asleep is the worst outage class. The dedupe
  window is 24h per topic so the alert isn't noisy.
- **`--build-from-source` makes the rebuild slower.** It's already a
  slow operation (~30s). The alternative is faster-but-broken, which
  we've measured doesn't help.
- **`SIGKILL after 3s grace`** is aggressive, but the alternative is
  "stuck forever". The grace period lets clean exit handlers run when
  they CAN run.
