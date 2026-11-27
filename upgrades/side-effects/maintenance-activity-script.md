# Maintenance activity report side-effects review

- The existing disabled activity schedule now produces both reports. It uses the same script-only admission and starts no model when the script gate is open or closed. Its default cadence remains every six hours. The maintenance report covers the 48 hours used by the existing maintenance review.
- Both reads use the authenticated local category endpoint. The script writes each category separately in the local report directory. If one category is unavailable, the other report can still be written and the run records a failure.
- The report contains factual counts. The maintenance review still interprets trends and overlap in housekeeping work. No schedule, retention policy or reporting destination changes on a live agent.
- Evidence is machine-local. Disabling the activity schedule stops future reports and leaves saved reports available. Reverting this change restores the guardian-only activity report.
- The saved maintenance category response matches the calculator's totals. The scheduler fixture checks both requested windows, both reports on disk, and zero model tokens and sessions.
