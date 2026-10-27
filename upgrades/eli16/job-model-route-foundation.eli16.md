# How the job model route will be chosen

Some scheduled jobs need a full AI session. Instar currently starts those sessions on the agent's usual AI provider and model. The next cost improvement is to let a job use a cheaper model when a benchmark shows it can do that specific job just as reliably.

This change adds the place where that choice will happen. A job can name an exact provider and model, but the scheduler will use that choice only when the benchmark matches the job's current instructions and this machine has the provider, a usable account, the required safety hooks and a recent safety test. If any fact is missing, the job still runs on its usual route. The run record says why the proposed route was not used, so a missing optimization is visible.

There is one more requirement before any proposed route can run: every AI call must be recorded with enough detail to review its cost and correctness later. The code gate for that requirement is closed in this change. The machine checks and audit adapter are still being built, and no job template carries a model pin. This gives the next part of the work a tested fallback path without claiming a saving or a quality result that has not been measured.
