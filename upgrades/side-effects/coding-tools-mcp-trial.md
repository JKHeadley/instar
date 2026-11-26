# Coding-tools project integration trial

- The trial flag is absent by default and read when the scheduler builds the launch. Only the user-origin coding-tools job with no explicit manifest policy is eligible. Explicit manifest choices keep precedence. The existing framework launch path interprets the option. Claude can start without configured integrations; other frameworks keep their existing behavior.
- Turning the flag on can remove tools needed by an uncommon recovery path. The six audited runs used Bash for all 52 recorded tool calls. The trial preserves Bash and makes no changes to job tasks, effort, framework, cadence or authorization.
- The assessment remains with the coding-tools job. The flag controls startup context. It authorizes no update or external action.
- The flag belongs to the scheduler's agent settings. Each trial run reflects the settings and integrations on its executing machine. No live settings were modified during this measurement.
- Rollback sets the flag to false or removes it. This takes effect on subsequent launches. No state migration is needed.

## Controlled measurement

On November 25, 2026 Pacific, two passive headless Claude Opus runs used the profile associated with the recorded coding-tools jobs, low effort, the same project directory and the same prompt. Both returned the requested one-word response and made zero tool calls. The second used the scheduler's strict empty integration configuration. The default shell profile's initial attempts produced no usable model usage, so they were excluded.

| Measure | Existing integrations | Empty integration configuration |
| --- | ---: | ---: |
| Connected integrations | 3 | 0 |
| Uncached input | 2 | 2 |
| Cache creation input | 74,768 | 57,564 |
| Cache read input | 0 | 2,232 |
| Total observed input | 74,770 | 59,798 |
| Output | 4 | 4 |
| Wall time | 16.00 s | 12.49 s |

The treatment used 14,972 fewer total observed input tokens, about 20.0%. The total includes cache reads and writes. One ordered pair measures initial context in that environment. It does not establish savings per complete production run, billed cost or recovery-path parity.
