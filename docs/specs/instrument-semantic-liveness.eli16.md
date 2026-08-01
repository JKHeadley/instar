# Instruments must be able to react to what they measure

A monitor is not useful merely because it runs. It must be able to tell apart
the world states its verdict claims to describe.

Echo found a delivery check that called a sleeping laptop a delivery failure.
The same red result also meant a reachable machine had violated the delivery
protocol. Because ordinary unavailability and a real contract defect became the
same verdict, the alert could never become quiet whenever that laptop was shut.
People naturally learned to ignore it.

The alignment grade had the opposite-looking version of the same problem. Ten
new decisions contained valid numeric confidence, but fifteen older decisions
contained words such as “high.” One old word forced the entire score to remain
unavailable. New good data could not repair the instrument for almost a month.

This change does not guess that an instrument is broken merely because its value
stays constant. A conflict list may correctly stay empty for years; it would
change as soon as a real conflict existed. Repetition cannot distinguish that
healthy case from a broken mapping, so there is no arbitrary “after N equal
runs, declare darkness” rule.

Instead, each script instrument may report whether it really assessed anything,
what verdict it reached, how many candidates it measured, and why it excluded
the rest. The scheduler checks that the numbers agree and saves the report. An
offline peer is now an explicit exclusion that lowers coverage, not a delivery
failure. A reachable peer returning the wrong typed answer is still a measured
failure and remains loud.

Alignment now follows the same honesty rule. Only rows with measurable numeric
confidence join the scored cohort, and that same cohort is used for every score
component. The response says both “10 rows measured” and “40 rows existed,” plus
the missing and invalid counts. This avoids mixing denominators while letting
valid new entries affect the grade immediately.

Finally, the scheduler retry counter now survives retry attempts. A script that
keeps failing gets six widening retries and then waits for its next scheduled
window. It can no longer reset itself to the first one-minute retry forever.
