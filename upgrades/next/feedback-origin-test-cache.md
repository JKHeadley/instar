# Upgrade Guide — vNEXT

<!-- internal-only -->
<!-- bump: patch -->

## What Changed

Confined feedback workers can run Telegram origin tests without writing to protected dependencies. Generated test workers now live in the ignored `.vitest` directory, and Vitest uses the confined runner's temporary cache when supplied.

## Evidence

The old paths failed with `EPERM` inside a live SecretStore feedback attempt. A focused production-sandbox replay passed with the new paths. Build, lint, and full unit tests passed with zero failures; integration, E2E, CI, and exact-head merge verification are required before merge.
