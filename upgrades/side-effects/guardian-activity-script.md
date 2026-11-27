# Guardian activity script side-effects review

- The sibling schedule is disabled on install and uses the existing script-runner flag. The scheduler also refuses attempts to start a model for this report through the projected-session path.
- The job calls the existing authenticated category endpoint on loopback. It reads counts and saves one local report without creating a model session or writing to the source ledger. Unavailable or invalid input fails the job without a report.
- The calculator produces evidence about runs and skips. The existing guardian review interprets coverage, resolves contradictions, and decides what requires attention.
- The result describes the scheduler instance that serves the local endpoint. The script makes no cross-machine requests. Disabling the sibling leaves the existing review and local reports available.
- A saved category response supplies the expected totals. The scheduler test enables the sibling in a temporary fixture, checks the request is authenticated, and verifies zero model tokens and no model session.
