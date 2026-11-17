# Listen early, and restarts that say who asked (plain version)

## What happened

On 16 November the Mac M5 Pro's server restarted and was unreachable for 2 minutes 43 seconds. Its log said only "Restart requested by undefined", so nobody on that machine could tell who asked. During the gap the other machines got "connection refused" and could not tell a slow start from a dead machine. Justin's "Accept all" landed right in the gap.

We traced it. Another Echo session changed one setting on the M5 (which GitHub login Local Verify trusts) and then wrote the restart file by hand, without its name, because that setting was only read when the server started. There was no proper way for a session to ask for a restart.

## What changes

**The server answers from the first seconds of a start.** A small listener opens the port right away and answers on the same network address the real server will use, so other machines reach it too. It tells callers "starting, try again in N seconds" and lists which parts are ready: config, the single-instance lock, multi-machine, the scheduler, messaging, sessions and the web server. The estimate comes from how long the last start took. When the real server is ready, it takes over the same port.

This listener existed before, but only on development machines, and only on the machine's own local address. It is now on for every agent, and anyone can switch it off with one setting.

**One name to check:** `bootReadiness.state` on `GET /health`. While the server starts, every answer, including `/health`, is "not ready yet" (503) with this field set to "starting". Once it serves, `/health` answers normally with "ready". Anything that already treats a normal `/health` answer as "the server works" stays right. The watchdog that restarts stuck servers recognises the "starting" answer as alive, so it does not cut off a slow start, and after 30 minutes of "starting" it treats the start as stuck. The planned-restart proof built by the machine-maintenance work reads this field.

**Restarts name who asked.** If someone writes the restart file without a name, the log now says "an unattributed writer". Every restart request is written to a small log, and after the restart `/health` shows who asked for it. Sessions get a proper way to ask, `POST /server/restart`, which requires a name and a reason. Agents are told to use it.

**The setting that caused this no longer needs a restart.** The trusted login is now read live.

## Safeguards

- The watchdog knows "starting" means alive, so it will not restart a slow start, and a start stuck for 30 minutes is still caught.
- Nothing treats a starting server as ready: the install flow, scripts and the Slack backup channel all wait for the real answer. (The old development-only listener said "fine" too early, so messages could be passed into a server that was not ready yet. That is fixed too.)
- A restart file without a name still works. It is labelled, not refused, so nothing silently fails to restart.
- The new restart route keeps the existing holds. It will not cut off a running Local Verify test.
- The new restart route is recorded as affecting only its own machine, and is left out of the public capability list. Agents learn about it from their instructions.

## What you need to decide

Nothing. It is on by default, and `monitoring.bootHealthBeacon.enabled: false` turns the early listener off for one agent.
