# Projects can finally reach the "merged" stage (#866)

The /projects system tracks a multi-spec initiative through stages: outline → spec → approved → building → merged. The last hop, "building → merged," verifies the work's PR actually merged by asking GitHub about it. The problem: the code that does that verification needs a small helper handed to it ("here's how to ask GitHub about a PR"), and the API route that drives the transition never handed it over. So EVERY attempt to move a project item to "merged" failed with "GitHub-PR-view helper not provided" — meaning no project, on any install, could ever record a step as merged through the live API. The project registry silently lagged reality forever.

This is the textbook wiring-integrity failure the project's own testing standard warns about: the verification logic was unit-tested (with a fake helper passed in), so it looked covered — but in production the real helper was never wired, so the feature was dead. I hit it firsthand tonight trying to mark the multi-machine-coherence P0 round "merged" after its PR landed.

The fix injects two small READ-ONLY helpers at the route: one runs `gh pr view <n>` to check the PR's merge state, the other runs `git merge-base --is-ancestor` to confirm the commit is really on the branch — both against the project's own target repo. Nothing destructive; just reads.

The test is the meaningful part: it proves the helper is now actually wired by asserting that a building→merged attempt can NEVER again return "helper not provided" — any real failure (no such PR, gh not installed) now surfaces as "PR-view failed" instead. The only way to get the old error back is to un-wire the helper, which the test would catch. That's the wiring-integrity check the missing piece needed all along.

_Follow-up: the read-only merge-base catch carries an `@silent-fallback-ok` note — a non-zero `--is-ancestor` exit IS the negative answer (not an ancestor), not a degradation._
