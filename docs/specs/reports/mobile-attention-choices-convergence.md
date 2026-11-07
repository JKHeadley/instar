# Convergence report: Done and Ignore for a Needs-you item

One review round, by an independent reviewer reading the spec and the code. The change adds one device route beside the health quick actions, under the same device rules, and runs the dashboard's existing PATCH. Findings and changes are below.

## ELI10 overview

Notices on the phone's Needs-you list get the machine they came from, plus Done and Ignore buttons, through the dashboard's own close route.

## Original vs converged

- **Dot-only ids are refused.** The reviewer found that `.` and `..` passed both the allowlist and the route's check, and the loopback URL would read them as path steps. Both patterns now need a letter or digit.
- Everything else was confirmed as designed: encoded characters refused before the signature, owner-only twice, machine-local, and no Face ID, as with the health quick actions.

| Round | Findings | Changes |
|---|---|---|
| 1 | 1 latent design defect | id patterns require a letter or digit |
