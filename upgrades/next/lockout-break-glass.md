# Account lockout and emergency-code safety

## What Changed
Shipped browser helpers read full page text before actions and refuse account suspension, locking, hold, recovery-code use or disabling two-factor warnings without one-action operator approval. Secret retrieval and credential-store protect recovery/backup-code names. Existing agents receive the helpers and skill rule on update.

## What to Tell Your User
I will stop before using an emergency recovery code or acting past an account-lockout warning. You can approve one exact action from the approval link; normal sign-ins continue as before.

## Summary of New Capabilities
- Default-on checks in the shipped browser and credential helpers.
- Five-minute, single-use approvals through the existing dashboard PIN surface.

## Evidence
Related unit, approval HTTP, installed helper lifecycle, init and update tests; see upgrades/side-effects/lockout-break-glass.md. Feedback fb-0fd1d7e7-232.
