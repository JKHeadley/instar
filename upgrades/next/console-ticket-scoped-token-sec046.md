# Phone-tap dashboard sign-in uses the short-lived pass too (ships dark)

## What Changed

The dashboard scoped-session feature (SEC-002b, still switched off) gives your browser a short-lived, revocable pass instead of the permanent master key when you unlock with your PIN. But the **phone-tap** sign-in (the owner-phone "console ticket") was missed — it kept handing back the permanent key even with the feature on, a second door outside the safer model. This closes that gap: when the feature is on, the phone-tap sign-in now mints the **same short-lived `dst_` pass** the PIN unlock does.

Ships **dark** (`security.dashboardScopedToken.enabled` default false); with it off, the console sign-in returns the master token exactly as before (byte-identical).

## Summary of New Capabilities

- The owner-phone console-ticket redeem returns a scoped `dst_` session token (not the master) when `security.dashboardScopedToken.enabled` is on — mirroring `/dashboard/unlock`, so every dashboard sign-in path uses the short-lived, revocable pass.
- Dark-gated: returns the master token byte-identically when the feature is off.

## What to Tell Your User

Nothing changes yet — this ships switched off, like the feature it completes. When that feature is turned on (after its full live dashboard test), signing in to your dashboard by tapping on your paired phone will give your browser the same short-lived, revocable pass that typing your PIN does — instead of a permanent key. Both doors behave the same way, so there's no permanent key left in your browser from either path.
