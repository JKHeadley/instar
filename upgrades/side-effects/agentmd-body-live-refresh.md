# Side-effect review — AgentMD body live refresh

## Changed boundary

The existing trigger-time body drift probe now returns the validated body as
well as its hash. `JobScheduler` replaces only `JobDefinition.body` before the
trigger continues, so the prompt and run-history hash share one validated value.

## Expected effects

- A valid markdown body edit affects the next eligible invocation without a
  server restart.
- Repeated triggers with unchanged content do no mutation and emit no reload
  message.
- A later valid edit replaces the prior validated body.

## Failure and safety behavior

- Missing, non-regular, symbolic-link, oversized, or malformed files never
  replace the last validated prompt.
- Invalid disk states keep the existing deduplicated warning behavior.
- Frontmatter and schedule metadata are not hot-reloaded; their existing
  manifest authority and startup lifecycle are unchanged.
- The synchronous read stays bounded by the existing AgentMD total/body byte
  caps and occurs only at a job trigger boundary.

## Class-closure declaration

This is an instance of generated-artifact path/contract drift: the disk reader
proved a new body existed while the execution consumer stayed on its boot copy.
`tests/unit/scheduler/JobScheduler.body-drift.test.ts` closes the class at the
consumer seam by proving valid edits reach prompts and invalid edits cannot.
