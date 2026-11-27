# Measuring startup tokens for memory hygiene

Six saved memory hygiene reviews used Bash and the local Skill tool and did not call a project integration directly. Their first model requests used a median of about 80,497 input tokens, including cached input. That gives us a baseline to compare against a smaller startup context.

The trial starts disabled. The baseline mode leaves integrations in place and measures startup. The treatment mode asks Claude Code to launch with an empty project integration list. Both keep Bash and Skill and use the review's existing prompt, model routing and schedule. An explicit job policy, missing local skill or usage ledger, constrained tool list, or unsupported launcher keeps the existing launch. There is no automatic second launch after a session starts.

The authenticated memory hygiene job history shows baseline, treatment and fallback runs with the first measured request from each run's bound transcript. Missing usage appears as unknown. The historical baseline includes cached input and does not establish billed cost. A local fixture exercises the comparison, and a real treatment measurement requires enabling the trial after verification.
