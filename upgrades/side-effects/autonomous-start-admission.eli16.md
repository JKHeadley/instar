# Why autonomous runs "never started", and the fix (plain English)

## What happened

When Echo starts a long autonomous run, it first tells its own server "I'm starting a run". The server then decides whether the run starts as running ("active") or as waiting ("preparing").

Back in September, Echo ran a special 24-hour trial called the W32 window. For that trial, a run was only allowed to count as running once a strict checker had seen five signs of life: the session is up, it's writing, messages can get through, real work is being saved, and the trial window is open. So the server started every run as "waiting" and let the checker switch it on.

The trial ended on 8 September, but the rule stayed. From then on, every run Echo started sat in "waiting". Nothing ever passed those runs to the checker, and the checker can only watch one run at a time anyway. A waiting run is not held to its task when the session tries to stop. It is also skipped by the loop that restarts dead runs. And nobody was told. That's why the operator kept hearing "the autonomous session never started". Topic 9210's 24-hour run also died quietly when its session was cleared at a restart.

## What changes

1. A new run now starts as running, unless a window trial is really open right now and the checker is free to take this run. Running runs are already looked after: if the session dies, the restart loop brings it back.
2. A small watchdog checks every minute. If a run is still "waiting" five minutes after it was registered, it sends one short message in that run's topic: "your run did not start, ask me to start it again". It only sends once per run, and if Telegram is down it tries at most three times.
3. The agent's own instructions mention both, so it knows what to do when someone says "my run never started".

## What doesn't change

Runs on other agents, and Echo when the checker is off or only watching, already started as running. They still do. The checker itself is untouched, and a real window trial still works the old way.

## How to turn it off

If the message ever gets annoying, set `autonomousSessions.preparingWatchdog.enabled` to `false` in `.instar/config.json`. The start rule is a code change; undoing it means reverting this change.
