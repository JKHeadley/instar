# Windows desktop update handoff diagnostics

## What Changed

Instar keeps the Windows desktop unavailable if its already running companion cannot return a signed update token. Mama PC showed this failure after the first diagnostic release. The installer now records a fixed reason for that handoff: a connection refusal, an unreachable address, a timeout, an HTTP refusal, or an invalid reply. The diagnostic contains no network address, Windows path, request body, or secret. The companion still must return its update token and stop before Instar replaces its executable.

## What to Tell Your User

Mama PC's Instar agent remains reachable while its Windows desktop helper is off. The new diagnostic narrows down the repair, but this release alone does not make the Windows desktop ready. The normal desktop flow still asks for only the dashboard PIN.

## Summary of New Capabilities

The authenticated `/desktop/diagnostics` maintenance endpoint gives a fixed code for a failed Windows companion update handoff. It grants no screen or input access.

## Evidence

Focused unit tests cover the update transport failure classes and the redacted status. The existing HTTP route and production-boot tests cover the diagnostic provider path. Live Mama PC screen, input, and Stop proof remain required after the repair.
