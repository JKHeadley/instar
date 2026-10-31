<!-- bump: patch -->

## What Changed

The console no longer treats held or expired replies as a dashboard feature or an operator task. Its message page now reads only the message footer setting. When that setting cannot be loaded, the page offers Unlock or Retry without showing an editable control that opens into an error. The older dashboard also withholds its display-settings tile until the settings load and removes the held operation count from its recording summary. Delivery recovery records remain available internally.

## What to Tell Your User

Held replies should no longer appear as a card or list in the dashboard. Message settings only appear when they are ready to use; otherwise you see a clear Unlock or Retry step. Instar still tracks and repairs delivery problems internally.

## Summary of New Capabilities

No new capability. This corrects how the dashboard presents delivery failures and unavailable settings.

## Evidence

Focused console and legacy dashboard DOM tests cover a failed settings response, the PIN flow, and a successful save. The full test suite and release checks remain gates before publication.
