# Stored sign-in survives a gateway outage
<!-- bump: patch -->

## What Changed
At boot, a gateway answer that means the agent could not be reached (502, 504, 520-530) keeps an already stored sign-in, as a network error already did. Agent answers such as 401, 403 and 503 still lead to sign-in, and a typed sign-in still needs a live success.

## What to Tell Your User
If the dashboard opens while your agent can't be reached, it keeps you signed in and shows that it's still trying to connect, instead of asking for your PIN again.

## Summary of New Capabilities
No setup or new permissions. This fixes an unnecessary sign-out.

## Evidence
Focused sign-in and network-state unit tests. See upgrades/side-effects/dashboard-proxy-boot-signin.md.
