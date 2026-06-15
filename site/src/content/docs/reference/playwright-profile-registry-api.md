---
title: Playwright Profile Registry API
description: HTTP routes for the machine-local registry of browser profiles and the accounts each holds.
---

All routes require the `Authorization: Bearer <authToken>` header. The whole feature is
**dev-gated** — on a development agent the routes are live; on the fleet they return
`503` and the session-start awareness block injects nothing. No route ever returns or
resolves a secret value; accounts are referenced by vault-secret **NAME only**.

See the [Playwright Profile Registry feature page](/features/playwright-profile-registry/)
for the design and the honesty disciplines (staleness, provenance, fail-toward-truth).

## Read

### `GET /playwright-profiles`

Lists every profile on this machine and the accounts it holds — full detail: `service`,
`identity`, `owner` (`agent` | `operator`), vault key NAMES, `loginMethod`, last-asserted
login state, `lastVerifiedAt`, and any dangling-reference flags.

### `GET /playwright-profiles/session-context`

Returns the compact, advisory boot-awareness pointer that is injected at session start
(one line per profile: accounts, owner marker, login staleness). Append `?full=1` to
bypass the byte cap.

### `GET /playwright-profiles/resolve?service=&identity=`

Resolves the owning profile for a target account. Exact `(service, identity)` wins; a
service-only query that matches more than one profile returns
`{ profile: null, ambiguous: true, candidates: [...] }` rather than silently choosing a
(possibly privileged) account. The result reports `dirExists` so the caller never trusts
a profile whose browser directory is not present on this machine.

## Write

### `POST /playwright-profiles`

Creates a custom profile. Body: `{ id, description?, userDataDir? }`. A supplied
`userDataDir` is path-jailed to the agent home; omitted, it is auto-allocated.

### `POST /playwright-profiles/:id/accounts`

Assigns an account to a profile. Body:
`{ service, identity, owner, vaultRefs[], loginMethod?, note? }`. `owner` is required;
each `vaultRef` is validated against the live vault NAMES (validation fails closed if the
vault is unreadable).

### `PATCH /playwright-profiles/:id/accounts`

Updates an existing account's `lastAsserted` / `lastVerifiedAt` / `note` — the agent
calls this after it confirms a login in-browser or finds a session dead.

### `DELETE /playwright-profiles/:id`

Removes a profile. The `default` profile is refused.

### `DELETE /playwright-profiles/:id/accounts`

Removes a single account (`{ service, identity }`) from a profile.

### `POST /playwright-profiles/:id/activate`

Switches the browser onto a profile: rewrites the Playwright MCP `--user-data-dir` (in
`.claude/settings.json` or `.mcp.json`, whichever is authoritative) and restarts the
session. Ships **dry-run by default** — it logs the intended rewrite and refresh and
performs neither until `playwrightRegistry.dryRun` is set false. An already-active
profile is a no-op. Reversible by activating `default`. Every write across these routes
is recorded to an append-only audit log (`logs/playwright-profiles.jsonl`).
