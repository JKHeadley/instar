# Side-Effects Review — Threadline name-resolver honors user-curated nicknames

**Version / slug:** `threadline-nickname-resolver-authority`
**Date:** `2026-05-08`
**Author:** Echo
**Second-pass reviewer:** required (touches Threadline send-path delivery correctness)

## Summary of the change

`POST /threadline/relay-send` now consults `.instar/threadline/nicknames.json` BEFORE asking the relay's discovery cache to map a name → fingerprint. User-curated nicknames are highest-authority; relay discovery is a signal the resolver only consults when no nickname matches.

The `ThreadlineNicknames` class (already on `feat/dashboard-grouped-nav`, commit `16c605ce`) is cherry-picked onto `main` byte-identical, plus one additive method: `resolveByName(name)` for case-insensitive name → fingerprint reverse lookup. The route handler wires nickname resolution at the top of the request, then propagates a single `nicknameResolvedFp` through the local-delivery match (now by-fingerprint instead of by-name when set) and the relay branch (skipping `relayClient.resolveAgent` when set).

When relay discovery and nicknames disagree on a name's fingerprint, the route logs a `[relay-send] Nickname/discovery mismatch …` warning and uses the nickname's fingerprint. The mismatch is not silently swallowed.

Files touched:
- `src/threadline/ThreadlineNicknames.ts` — cherry-picked from `16c605ce`; added `resolveByName(name)` method (single match | ambiguous | null).
- `src/server/routes.ts` — added import; added nickname-first resolution block at the top of `/threadline/relay-send`; switched local-delivery name-match to fingerprint-match when nickname resolved; replaced bare `relayClient.resolveAgent(targetAgent)` with the nickname-aware version.
- `tests/unit/ThreadlineNicknames.test.ts` — new, 7 cases covering `resolveByName`: null on missing/empty/whitespace, single match (case-insensitive), ambiguous detection, on-disk file read, corrupt-file tolerance, no-match.
- `tests/integration/threadline-relay-send-nickname.test.ts` — new, 3 cases reproducing the production bug (relay returns wrong fingerprint, nickname authority overrides), plus the no-nickname and raw-fingerprint pass-through cases.
- `upgrades/NEXT.md` — release note with reproduction + verified-after evidence.

## Decision-point inventory

- Top of `/threadline/relay-send` — **add** — new nickname-resolution block.
- Local-delivery `nameMatches` filter — **modify** — by-fingerprint when nickname resolved, otherwise existing by-name.
- Relay-delivery `resolveAgent` call — **modify** — uses `nicknameResolvedFp` directly when set; relay discovery only as a probe for the mismatch warning.
- `ThreadlineNicknames.resolveByName` — **add** — additive method on existing class.

---

## 1. Over-block

**What legitimate inputs does this change reject that it shouldn't?**

The nickname-first path overrides relay discovery whenever the user has an exact (case-insensitive) name match in their nicknames file. Concrete over-block surfaces:

- **User has a stale nickname mapping**: `.instar/threadline/nicknames.json` says "Dawn" → `8c79…`, but Dawn re-keyed to `9911…`. We'd route to `8c79…` (a dead fingerprint). Mitigation: the mismatch warning surfaces in operator logs (`[relay-send] Nickname/discovery mismatch …`). User can clear the mapping via the existing `DELETE /threadline/nicknames/:fingerprint` route once the dashboard PR (`feat/dashboard-grouped-nav`) lands, or by editing the JSON file directly. The previous behavior — silently routing to whatever the relay cached — is strictly worse: it masks the staleness instead of letting the user see and fix it.
- **User has nicknamed a remote agent with the same name as a local one**: e.g., user nicknames remote `fp_X` as "echo" and there's also a local agent literally named "echo". The route now routes to the remote one. The previous behavior would have routed locally. The user explicitly chose this nickname; honoring it is correct, and the tradeoff is documented (see Interactions §4 below).

For inputs that look like raw fingerprints (`/^[0-9a-f]{16,64}$/i`) or use the `name:fpPrefix` qualifier syntax, the nickname check is skipped — caller is being explicit about a fingerprint, no over-block possible.

## 2. Under-block

**What does this change fail to catch that the user expects it to catch?**

Names with NO nickname mapping fall through to the existing `relayClient.resolveAgent(targetAgent)` flow. The original silent-wrong-fingerprint bug can still manifest for un-nicknamed names — e.g., if the relay's discovery cache holds a stale entry for "Stranger" and the user has not nicknamed "Stranger", a send to "Stranger" will go to whatever the relay says. This fix defends the user-curated path; the underlying relay-discovery-can-be-wrong problem remains for un-nicknamed names. Acceptable scope: the user's authority lever is the nickname store; if they care about delivery correctness for an agent, they nickname it.

Names with `name:fpPrefix` syntax also bypass nicknames — the caller is overriding by being explicit; if their explicit choice is wrong, that's not the resolver's job to second-guess.

## 3. Level-of-abstraction fit

The wiring lives in the route handler (instar-specific code) rather than in `ThreadlineClient` (generic library code). This keeps `ThreadlineClient.resolveAgent` agnostic of instar's `.instar/` state directory and nicknames file. `ThreadlineNicknames` itself is reused — no new abstraction invented; the new `resolveByName` method is the single sensible reverse-lookup primitive on a class that already exposes `get` (forward), `set`, `delete`, `all`, `invalidate`.

The handler reads the nickname store inline rather than caching a long-lived instance — `ThreadlineNicknames` already has its own 30-second internal cache, so per-request construction is cheap and the cache-invalidation story stays simple (file edits visible within 30 s).

## 4. Signal-vs-authority compliance

This change is the canonical signal-vs-authority move:

- **Signal (low-context, can be wrong)**: `relayClient.resolveAgent(name)` — the relay's discovery cache is built from gossip, can hold stale presence, can hold imposter entries.
- **Authority (full-context, user-curated)**: `nicknames.json` — set explicitly by the user (via the dashboard ✎ pencil, the `PUT /threadline/nicknames/:fingerprint` route on the feature branch, or by hand-editing the JSON).

Authority wins. Signal is consulted only when authority is silent. When the two disagree, the conflict is observable (warning log) but the route still honors authority. This matches the existing patterns in `feedback_signal_vs_authority.md` and `feedback_side_effects_review.md` from agent memory.

## 5. Interactions

- **Local-delivery path (same-machine agents in `known-agents.json`)**: When a nickname resolves, the local-delivery loop now matches by fingerprint instead of by name. Same-name collisions (Dawn-the-remote vs. dawn-the-local) resolve to whichever fingerprint the user nicknamed. If the user nicknamed Dawn-the-remote, sends bypass the local "dawn" agent. This is intentional — the user curated the mapping. If they wanted the local one, they wouldn't have nicknamed the remote.
- **Self-guard (don't deliver to self)**: Unaffected. The fingerprint comparison against `identity.json` still runs on the resolved local target.
- **`name:fpPrefix` syntax**: Unaffected. The check happens before nickname resolution and short-circuits it. Callers who use the explicit qualifier retain their existing semantics.
- **MCP `threadline_send` tool**: Unaffected directly — the MCP server forwards `agentId` to `/threadline/relay-send` over HTTP, so the nickname-first resolution applies transparently to every MCP-initiated send. This is the path Echo's outbound messages to Dawn travel; the original bug was on this exact path.
- **Existing tests**: The local-delivery `nameMatches` filter was wrapped in `nicknameResolvedFp ? (...) : (...)`. When no nickname store exists (the case for every existing test that doesn't write `nicknames.json`), `nicknameResolvedFp` is null and the existing by-name filter runs unchanged. No regression risk for existing test fixtures.
- **`feat/dashboard-grouped-nav` merge conflict**: `ThreadlineNicknames.ts` is cherry-picked byte-identical from commit `16c605ce`, so when that feature branch lands, the file content already matches and only the additive `resolveByName` method is the merge delta. Trivial conflict resolution.

## 6. Rollback cost

Trivial. Single-commit revert. Three files changed plus one cherry-picked file plus two test files. No data-migration, no schema change, no deployment ordering. The nickname JSON file format is read-only here (no writes from the route), so even a partial rollback (revert routes.ts only, keep ThreadlineNicknames.ts) leaves the system in a consistent state.

## Sign-off

Change is self-contained, defends the user-curated authority lever, exposes mismatches via warning logs, leaves un-nicknamed paths unchanged, and is fully covered by integration test that reproduces the original Dawn-routing failure.
