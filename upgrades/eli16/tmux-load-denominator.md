# Missing CPU counts no longer look like an idle host

The degraded-tmux watcher uses load per CPU core to distinguish a slow shared
terminal server from a generally busy machine. That calculation needs a CPU
core count.

Previously, if the operating system returned no cores, the production provider
returned zero. The watcher then treated an unavailable load measurement as a
perfectly idle host and allowed slow-call corroboration to advance. That could
raise a confident degraded-tmux notice without the load evidence the guard's
design requires.

The provider now returns an explicit unknown value when the denominator is
missing. A real zero load remains zero. The guard consumes unknown by pausing
corroboration for that cycle, just as it pauses when measured load is above the
busy-host threshold. The watcher remains signal-only and never kills or
refreshes tmux.

Tests cover the production conversion boundary, the downstream decision, and a
throwing load provider. Reintroducing the old fabricated zero makes the tests
fail.
