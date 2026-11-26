# Upgrade Guide — vNEXT

<!-- bump: patch -->

## What Changed

Optional expiring ordered-account placement now applies to new headless routine Codex Sol helpers and shipped Sol source reviews. It checks fresh local capacity and the current home again before launch, refuses other/default accounts when the named candidates are unavailable, and leaves busy conversations, jobs, resumes and manual pins alone. Disabled/absent policy adds no reviewer server dependency. Existing installed default review drivers receive the configuration loader update.

## What to Tell Your User

New routine Sol work can use the next accounts with room while your busy conversations keep running. The temporary preference expires automatically. If neither chosen account is usable, the engine reports the problem instead of borrowing another account.

## Summary of New Capabilities

| Capability | How to Use |
|---|---|
| Temporary routine Sol account preference | Set subscriptionPool.routineCodexPlacement with enabled, ordered accountIds and expiresAt on each approved engine instance |
| Read-only source-review placement | GET /subscription-pool/routine-codex-placement?model=gpt-6.2-sol with normal authentication |

## Evidence

Targeted selector, account-home/environment, HTTP, lifecycle, rollback, queued-change and installed-script migration tests use no paid model calls. Complete verification and guarded activation remain separate release steps; no full-suite or live result is claimed here.
