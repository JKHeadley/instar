## What Changed

The web console has a phone mode for the Instar iPhone app. Opening `/dashboard/console/?phone=1#/<page>` (or `#/<page>?phone=1`) shows only that page: no top bar, no section nav, no Legacy chip or link. Short page names such as `#/accounts`, `#/files` and `#/pace` work in phone mode, and Pace has a page of its own there. The mode lasts for the page load and respects the phone's safe areas. Without `phone=1` the console is unchanged.

## What to Tell Your User

When the Instar iPhone app shows a dashboard page inside its own screen, you see just that page, without a second set of bars. The dashboard in a normal browser looks and works as before.

## Summary of New Capabilities

A `phone=1` display mode for the console, for apps that embed one console page in their own frame.

## Evidence

New unit tests cover the mode decision (page query, hash query, off without it), the short page names (each resolves to a page the console renders), and the shipped console booted in jsdom: `?phone=1#/pace` and `?phone=1#/accounts` render with no top bar, nav or legacy link; `#/work?phone=1` stays in phone mode after a hash change; and without `phone=1` the bars, the legacy note and today's routing are unchanged. Existing console tests pass.
