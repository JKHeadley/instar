# Mentor tick records keystone cycles — explained simply

When the automated mentor job runs a "tick" (it watches the mentee, gathers
findings), it used to log those findings to one place — but it never recorded a
proper "cycle" of the mentorship the way the apprenticeship program tracks them.

That mattered because the program's #1 failure mode is "role drift": the easy work
gets logged, but the actual keystone — the mentor↔mentee differential — quietly
never gets exercised. The manual loop I run by hand records those keystone cycles;
the automated job didn't.

This change wires the automated tick to ALSO record a real
`mentor-mentee-differential` cycle each time: the mentee's output becomes the
cycle's menteeOutput, the forensics findings become the differential. It only
does this when an apprenticeship instance is configured (a new
`mentor.apprenticeshipInstanceId` setting) — so by default nothing changes; it's
opt-in. Now the automated loop fires the same keystone axis the manual loop does,
which is the structural fix for that drift.
