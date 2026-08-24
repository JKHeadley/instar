# If you are a successor session: START at `../DEPLOY-RUNBOOK.md`.
It indexes every file here and states the order. Do not run anything in this directory
without reading the runbook's PRECONDITIONS first — the preflight refuses on a sha mismatch
by design, and the session-restart step has an Observer-1 notice that MUST precede it.
Live state: `../REF-DISPOSITIONS.md` (bottom sections are newest). Gating suite log:
`/private/tmp/echo-w25-suite5/full-suite.log` — read its own `EXIT=` line, never a wrapper's.
