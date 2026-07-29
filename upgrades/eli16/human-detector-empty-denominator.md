# Detector miss rate stays unknown until it has evidence

The human-as-detector system has a small drift canary. It samples messages that
the cheap first-pass rules did not classify and checks whether a more capable
classifier recognizes a correction that those rules missed. Its summary
contains three values: how many messages were sampled, how many were later
judged to be misses, and the resulting miss rate.

Before this change, a fresh process had zero samples and zero misses, but the
summary still reported a numeric miss rate of zero. That number reads as
perfect reliability: the detector appears to have missed zero percent of the
messages it examined. In reality, it had examined nothing, so there was no
evidence about its reliability at all.

The correction keeps the two counts at zero and changes only the derived rate
to `null` until at least one sample exists. Once samples exist, the calculation
is unchanged. For example, one mismatch across three samples still reports a
miss rate of one third, and a measured run with samples but no mismatches still
reports a genuine numeric zero.

This is an observability correction, not a new gate. It does not block
messages, alter classification, change sampling, write persistent state, or
trigger any action. It only prevents an empty denominator from being rendered
as flattering evidence. The test deliberately begins with a fresh instance,
asserts that its sample denominator is zero, and requires the rate to be
unknown; that prevents a future fallback to a fabricated perfect score.
