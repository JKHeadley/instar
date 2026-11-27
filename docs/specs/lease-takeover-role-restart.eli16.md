# A machine whose lease role changed restarts once: in plain words

**The problem.** The machine in charge runs the agent's scheduled jobs. But the job scheduler is only set up when
a machine starts, and only if it is in charge at that moment. So a backup that takes over never runs any jobs, and
a machine that loses its place keeps running them, which means jobs could run in two places.

**What changes.** When a machine's role changes from the one it started with, it restarts once. Starting up is
already the well-tested way to set everything up for a role, so the backup comes up with its jobs running and the
old holder comes up without them.

**Why not start the scheduler while running.** That means changing a lot of code on every multi-machine agent for
something that happens rarely. A restart costs about a minute after a takeover and reuses what already works.

**What keeps it safe.** A machine that loses its place pauses its jobs straight away, before any restart. The
restart can only happen once every 15 minutes, so an unstable connection can't cause a restart loop, and a
one-minute check finishes the job if the restart had to wait. It sits behind a switch that is off by default, and agents with a named preferred machine, like Echo, are
not affected at all. One-machine agents never see it.

**What this does not fix.** Listening to Telegram is handled by a separate part of the agent and needs its own
setting turned on. Takeover still has to pass real power-off and link-cut tests before it goes on for anyone.
