# Upgrade Guide — vNEXT

<!-- bump: minor -->
<!-- minor = new agent-facing capability without breaking changes -->

## What Changed

**feat(server): `/capabilities` now actually enumerates the primitives it claims to know about — and a lint locks the promise structurally.**

The agent CLAUDE.md template tells every new agent: *"Before EVER saying 'I don't have' or 'this isn't available' — check what actually exists: `curl /capabilities`. It is the source of truth about what you can do."* That promise was silently false. `GET /capabilities` is a hand-curated object literal in `routes.ts`, and several agent-facing primitives lived as registered routes without ever appearing in the response:

- **Secret Drop** — the safe-channel credential intake (`POST /secrets/request`, `/secrets/retrieve/:token`, `/secrets/pending`, `DELETE /secrets/pending/:token`). Agents that trusted `/capabilities` as authoritative reached for chat-paste / env-var workarounds because the discovery primitive didn't list it.
- **CommitmentTracker** — `/commitments/*` CRUD that feeds PromiseBeacon.
- **TokenLedger** — `/tokens/{summary,sessions,by-project,orphans}` for token-usage observability.
- **SemanticMemory** — `/semantic/*`, the successor to the deprecated `/memory` endpoint.
- **Private Viewer endpoints** — `POST /view`, `GET /views`, `GET/PUT/DELETE /view/:viewId` were behind a block that only reported a count.
- **Telegraph publishing endpoints** — `POST /publish`, `GET /published`, `PUT /publish/:pagePath` were behind a block that only reported a count and a warning.

This release surfaces all of the above in `/capabilities` with full endpoint listings, including a hardening note on the `secrets` block pointing at `.instar/scripts/secret-drop-retrieve.mjs` as the safe retrieval helper (raw `curl` against `/secrets/retrieve` leaks the secret into the Bash transcript).

The structural enforcement is a new unit test, `tests/unit/capabilities-discoverability.test.ts`, that walks `src/server/routes.ts` for every top-level route prefix and asserts each either appears in the `/capabilities` response body or is on an explicit `INTERNAL_ALLOWLIST` with a one-line reason. Adding a new route prefix that is neither surfaced nor allowlisted will fail CI until the author makes a deliberate choice about discoverability.

## What to Tell Your User

No user-visible behavior change. Agents will, however, become more accurate about what they can do: when asked "can you do X?" they will read their live self-discovery surface first, and that surface now actually lists the full picture. The most visible improvement is that agents will reach for Secret Drop when a user needs to share a credential, instead of falling back to "paste it in chat" or "put it in an env var."

## Summary of New Capabilities

For the agent: the same primitives existed before, but they were only discoverable by reading the CLAUDE.md template — a ~1500-line document that is easy to skim past. Now they are first-class entries in the live `/capabilities` response.

Quick check from an agent session:

```bash
curl -s -H "Authorization: Bearer $AUTH" http://localhost:$INSTAR_PORT/capabilities | jq '.secrets, .commitments, .tokens, .semantic, .privateViewer.endpoints, .publishing.endpoints'
```

## Evidence

The discoverability gap was reproduced before the fix: `curl /capabilities | jq 'keys'` on v1.1.4 returned a 25-key object with no `secrets`, `commitments`, `tokens`, or `semantic` blocks, and `.privateViewer` / `.publishing` exposed only counts. After the fix, the same call returns all six blocks with explicit endpoint listings.

The new lint test was verified end-to-end: with the `secrets` block removed from the response, `npx vitest run tests/unit/capabilities-discoverability.test.ts` fails with a precise error pointing the author at the missing entry; with the block restored, all 81 tests pass.

Origin: case study seeded into topic 11141 ("🔍 Discoverability Secret Access") on 2026-05-20, root-cause audit on 2026-05-21.
