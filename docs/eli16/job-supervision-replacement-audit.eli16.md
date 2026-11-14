# Outage backup benchmark: count only valid, audited answers

When Jev cannot check a scheduled script result, Haiku or Luna may eventually
serve as its backup. This work tests those candidates on a fixed set of 35
synthetic results. Every test call is first recorded in a local SQLite audit
journal, including the chosen model and prompt identity. The journal then
records the answer, error, token usage, and later benchmark grade.

An early Haiku trial returned extra prose around its JSON answer. The old
safe parser turned malformed output into “cannot tell.” That was safe for a
live decision, but it could make a benchmark case appear correct by accident.
The benchmark now requires exact JSON. A malformed reply leaves the result
unchecked and records a failed model call, including any token usage the CLI
already reported. Haiku's next trial also requests
a JSON schema and reads the served model from the CLI response. Codex's
automatic model change is disabled for these audited calls.

The October 30 Luna trial produced the expected parsed label in 17 distinct
cases. Four “cannot tell” cases need a strict-format rerun, and 18 corpus
cases remain. Haiku is unqualified. These changes do not turn on production
Jev or its outage backup. The daily token cap stops further calls today.
