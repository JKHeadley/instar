# Use genuinely fresh Codex allowance during a manual account move

When a Codex account resets, its quota reading can already show a full allowance while the forecasting tool still needs hours of history. The manual account move previously required a complete forecast for every destination. This could leave a group of projects on an account that was running low while a different, verified subscription had just reset.

The manual move now prefers destinations when Codex itself has verified zero usage in the new weekly window and the only missing evidence is the normal forecast warm-up. The account still needs a valid local login and room in any other quota window it offers. If several freshly reset accounts qualify, the choice favors more time remaining and accounts serving fewer sessions. When none qualify, the existing forecast-based ordering applies.

This change applies to an explicit manual request. The existing work and recovery checks still decide whether the session itself can safely move. Missing quota data, an unverified reset, and older zero readings do not establish eligibility.
