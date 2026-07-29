# Empty intent windows no longer look conflict-free

Intent drift compares recent decisions with an earlier window. One metric is
the share of decisions that recorded a conflict.

Previously, a window with no decisions reported a zero-percent conflict rate.
That looks like a measured conflict-free period even though there was nothing
to inspect. A previous window could contain real decisions while the current
window was empty, leaving a real rate beside a fabricated zero.

The conflict rate is now null whenever the window's decision count is zero.
Conflict-spike detection compares the two windows only when both rates are
measured. The command-line formatter can render the absent rate as “n/a.” Real
zero-percent windows—decisions exist and none record a conflict—remain numeric
and continue to participate in spike detection exactly as before.

Tests cover both a fully empty journal and a previous-only journal. The latter
also asserts that no conflict-spike signal is invented from the missing current
window. Restoring the old zero fallback fails both absence assertions.
