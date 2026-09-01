# One-click Claude sign-in repair across your machines

Today, a Claude account can be signed out on the Laptop while the dashboard you opened lives on the Mac Studio. The old repair feature could do the hard login work, but its approval lived on the machine with the broken account. That left an awkward gap: you could see the problem centrally without being able to fix that exact machine centrally.

This change closes that gap. In the Subscriptions grid, the broken account's exact machine cell shows **Repair sign-in**. Once you have unlocked the dashboard, one click sends a short-lived, signed permission slip to that machine and starts the existing bounded repair flow there. The permission slip names the exact account, machine, repair episode, evidence snapshot, and action, so it cannot be reused for another account or for ordinary account setup.

The cell continues to be useful after the first click. A safely failed repair offers **Try repair again**. Work in progress offers **Cancel repair**. If the repair feature is intentionally unavailable, or if a repair is refused for safety, the normal manual sign-in option remains available. If the machine's status cannot be trusted because it is offline or unreachable, competing actions are hidden until the dashboard can see the truth again.

The target machine still owns all credentials and browser state. The central dashboard never receives passwords, cookies, codes, or login profiles. CAPTCHA, phone verification, unexpected sites, identity ambiguity, permission changes, and billing/security changes continue to stop safely for operator help instead of being bypassed.
