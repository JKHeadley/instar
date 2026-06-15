---
title: Playwright Profile Registry
description: A structured, machine-local registry of the browser profiles the agent can drive and the accounts each one holds — so the agent self-unblocks instead of asking you to drive the browser.
---

The agent unblocks itself by driving a real browser (Playwright MCP) logged into real
accounts. The credentials live in the agent's encrypted vault; the browser session
("who am I logged in as") lives in a profile directory on one machine. The **Playwright
Profile Registry** is the missing layer that records *which profile holds which account*
— so the agent knows, at session start, what browser access it actually has, and can
select and switch to the right profile on its own.

Before this, that knowledge existed only as scattered, partly-contradictory operational
notes, which led the agent to ask the operator to act (or grind a credential treadmill)
instead of resolving the right profile itself.

## What it stores

A durable, **machine-local** file (`state/playwright-profiles.json`) mapping each
**profile** (a physical browser user-data-dir on this machine) to the **accounts** it is
responsible for. Accounts are referenced by their vault-secret **NAME only — never the
value**. Each account records its `service`, `identity`, an `owner` marker
(`agent` or `operator`), its `loginMethod`, and a last-asserted login state with the
timestamp it was last verified.

## Three honesty disciplines

A registry that drifts into stale, unattributed, authority-shaped state would just
re-create the scattered-notes problem in a tidier file. So it is built around:

- **Staleness** — a login claim renders its age (`seen 2d ago` / `unverified`) and is
  treated as advisory, never a guarantee. The agent re-verifies in-browser before any
  privileged action.
- **Provenance** — every write is appended to an audit log; each account is marked as
  `agent`-owned or `operator`-owned (Know Your Principal), so the agent never acts as the
  operator unbidden.
- **Fail-toward-truth** — vault references are re-checked on read (a dangling reference
  is flagged), a missing profile directory is surfaced, and a corrupt registry file is
  never silently overwritten.

## Boot awareness

At session start a compact, advisory pointer is injected (from
`GET /playwright-profiles/session-context`) listing the profiles on this machine, the
accounts each holds, who owns them, and how fresh each login is. It is deliberately small
— the full detail lives behind `GET /playwright-profiles`.

## Selecting and switching

`GET /playwright-profiles/resolve?service=&identity=` picks the owning profile for a
target account and refuses to silently choose among multiple accounts of the same
service. `POST /playwright-profiles/:id/activate` rewrites the Playwright MCP
`--user-data-dir` and restarts the session onto the chosen profile.

`POST /playwright-profiles/:id/activate` ships in **dry-run by default** — it logs the
intended config rewrite and session refresh and performs neither until that is
deliberately turned off. It is reversible by activating the `default` profile.

## Routes

- `GET /playwright-profiles` — list every profile and the accounts it holds (full
  detail; vault key NAMES only).
- `GET /playwright-profiles/session-context` — the compact boot-awareness pointer
  (`?full=1` bypasses the byte cap).
- `GET /playwright-profiles/resolve?service=&identity=` — resolve the owning profile for
  an account.
- `POST /playwright-profiles` — create a custom profile.
- `POST /playwright-profiles/:id/accounts` — assign an account (by vault reference) to a
  profile.
- `PATCH /playwright-profiles/:id/accounts` — update an account's last-asserted login
  state / note.
- `DELETE /playwright-profiles/:id` — remove a profile (the default profile is refused).
- `DELETE /playwright-profiles/:id/accounts` — remove an account from a profile.
- `POST /playwright-profiles/:id/activate` — switch the browser onto a profile (config
  rewrite + session restart; dry-run by default).

## Rollout and safety

The whole feature is **dev-gated** — live on a development agent, dark on the fleet
(routes return 503 and the boot block injects nothing). It is **machine-local by
design**: a browser profile's logged-in session lives in cookies on one machine's disk
and cannot be moved by copying metadata, so the registry honestly describes only the
machine it is on. No secret value is ever stored, returned, injected, or resolved — the
file is plaintext machine-local and lists account identities + vault key names, so
filesystem access to the machine reveals the access *map*, never the credentials.
