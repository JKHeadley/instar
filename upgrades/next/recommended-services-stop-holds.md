## What Changed
Recommended-service setup now stays stopped when a person stops it. An emergency stop in Telegram or Slack, or ending the session from the dashboard, puts setup on hold. A setup session can hold itself through POST /recommended-services/:id/hold when the person says not now. The Jev offer now says credits are needed before a key. The setup rule on private folders covers sign-in codes too. All of this stays off on real agents, because setup only runs on throwaway or development agents proving a recipe.

## What to Tell Your User
Nothing yet. Recommended-service setup isn't on for real agents.

## Summary of New Capabilities
- A stop during service setup holds, until a repeat yes, a no, or a passing check.
- The list of recommended services shows `held` for a service on hold.
- The hold route refuses with no-recipe on an agent not proving a recipe.

## Evidence
Second live Jev run on a throwaway, 2026-11-05: an emergency stop was followed by a restart within seconds, in the server log. Tests in tests/integration/recommended-services-setup.test.ts fail without the check in reconcile.
