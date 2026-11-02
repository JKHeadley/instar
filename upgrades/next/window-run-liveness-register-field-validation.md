# A misnamed field no longer leaves an autonomous run silently stuck

## What Changed

`POST /window-run-liveness/register` used to accept a request with a missing or misnamed id field: its check used `RegExp.test`, which turns a missing value into the text "undefined", and that text matched the id pattern. The binding was then projected onto a run named "undefined" and refused with `autonomous-run-not-found`, leaving the run in `preparing` with no Stop hook holding the session (topic 131439, 2026-11-01, about 4.5 hours idle). Now the authority requires every id to be a real string and names the bad one (`window-run-liveness-registration-invalid:<field>`), and both `/window-run-liveness/register` and `/window-run-liveness/work-advance` answer 400 for an unknown key (with a hint such as `runId (did you mean autonomousRunId?)`), a missing field, or a non-numeric topic id, listing the allowed fields. The CLAUDE.md template (and the update path for existing agents) now gives the exact five-field register body.

## What to Tell Your User

If one of my long runs is started with a mistake in its setup, the server now tells me exactly which part was wrong, so I fix it straight away instead of sitting idle for hours.

## Summary of New Capabilities

- The window-run register and work-advance requests name any missing or misspelled field and suggest the right one.
- The agent instructions show the exact register request.

## Evidence

Unit tests: each of the four id fields, when missing, is refused by name before anything is projected; a non-string id is refused; a terminal window from topic 134088 does not block topic 131439, and the new binding is projected onto its own run. Integration tests: the exact 2026-11-01 request shape gets a 400 naming `runId` and suggesting `autonomousRunId`, a request missing `lifecycleRunId` gets a 400 naming it, a `null` topic id is refused, `artifactPath` on work-advance gets a hint, and the existing binding is untouched. Migration test: an existing agent's CLAUDE.md gains the register line once, and a re-run changes nothing.
