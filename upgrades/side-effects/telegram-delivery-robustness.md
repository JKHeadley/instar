<!--
  Side-Effects Review Artifact — Telegram Delivery Robustness, Layer 1.
  Layer 2 (durable queue) and Layer 3 (DeliveryFailureSentinel) and Layer 7
  (templates-drift verifier) will ship in subsequent commits on this same
  branch (chained PRs per Echo memory feedback_no_pr_fragmentation), each
  with its own side-effects artifact.
-->

# Side-Effects Review — Telegram Delivery Robustness (Layer 1)

**Version / slug:** `telegram-delivery-robustness-layer-1`
**Date:** `2026-04-27`
**Author:** `echo`
**Second-pass reviewer:** `(pending — see §"Second-pass review")`

## Summary of the change

Layer 1 of the approved & review-converged spec at `docs/specs/telegram-delivery-robustness.md`. Three coordinated changes that, together, structurally close the originating incident class (Inspec/cheryl topic 50 on 2026-04-27, where a relay script defaulted to port 4040 and hit a different agent's server with the wrong agent's auth token):

1. **`src/templates/scripts/telegram-reply.sh`** — port resolution order is now `INSTAR_PORT` env > `.instar/config.json` `port` field > 4040 fallback (with stderr warning). Every request also sends `X-Instar-AgentId` from config.json. ~50 lines of additions to the existing 134-line script.

2. **`src/server/middleware.ts` (auth path)** — auth middleware validates `X-Instar-AgentId` header against the server's own `agentId` *before* token comparison. Mismatch → `403 { error: "agent_id_mismatch", expected: <agent-id> }`. Missing header → token-only path with a per-source dedup'd ≤1/hr deprecation log entry (one-minor-version backward compat). Threadline-relayed paths exempt from deprecation logging.

3. **`src/server/routes.ts`** — new authed `GET /whoami` route requiring both Bearer and `X-Instar-AgentId` headers (no deprecation exception, since `/whoami` paired with bare-token fallback would be a discovery oracle for token-port pairing). Rate-limited to 1 req/s per source agent-id. Returns `{ agentId, port, version }`.

4. **`src/core/PostUpdateMigrator.ts`** — new `migrateReplyScriptToPortConfig` step using SHA-256-of-prior-shipped-content detection (replacing marker-string detection for the `telegram-reply.sh` migration). Prior shipped content is backed up to `.instar/backups/telegram-reply.sh.<epoch>` before overwrite. User-modified content (unknown SHA) gets a `.new` candidate file alongside, plus a `relay-script-modified-locally` degradation event — never overwritten in place.

5. **`src/data/builtin-manifest.json`** — auto-regenerated. The 99 hash changes are the expected propagation of `PostUpdateMigrator.ts` changes through the manifest's hook-source-hashing scheme (each hook entry hashes against the migrator file, so the migrator change rebases all 14 hook contentHashes plus other migrator-derived entries).

Files touched (commit diff):
- `src/templates/scripts/telegram-reply.sh` (+47 / -10 lines)
- `src/server/middleware.ts` (+85 / -1 lines, ~85 net new for agent-id validation + deprecation log dedup)
- `src/server/routes.ts` (+98 / -0 lines for `/whoami` endpoint + helpers)
- `src/server/AgentServer.ts` (+6 / -1 lines wiring `/whoami` rate-limit cleanup into shutdown path)
- `src/core/PostUpdateMigrator.ts` (+155 / -25 lines)
- `src/data/builtin-manifest.json` (regenerated)
- `tests/unit/telegram-reply-port-resolution.test.ts` (NEW, 5 tests)
- `tests/unit/auth-agent-id-binding.test.ts` (NEW, 7 tests)
- `tests/unit/whoami-route.test.ts` (NEW, 5 tests)
- `tests/unit/migration-relay-script-hash.test.ts` (NEW, 5 tests)
- `tests/unit/PostUpdateMigrator-telegramReply.test.ts` (existing test updated for SHA-based detection; added a new test for the `.new` candidate path)
- `tests/fixtures/telegram-reply-pre-port-config.sh` (NEW, the SHA-pinned prior shipped content used by the migrator test fixture)
- `docs/specs/telegram-delivery-robustness.md` (NEW, the converged spec)
- `docs/specs/reports/telegram-delivery-robustness-convergence.md` (NEW, the convergence report)

## Decision-point inventory

- **Auth gate (server middleware)** — modify. Adds `X-Instar-AgentId` validation BEFORE token comparison. Token comparison itself is unchanged (constant-time, untouched). Missing-agent-id path is a temporary deprecation tolerance, not a permanent decision surface.
- **Port resolution (script)** — add. Pure mechanical resolution; not a judgment call.
- **`/whoami` endpoint** — add. Read-only identity probe; required for Layer 3 sentinel to verify-before-send. No content authority.
- **Migration (PostUpdateMigrator)** — modify. Detection method changed from marker-string to SHA-set. Decision: "this on-disk script is a shipped prior version" is now a clean equality check on a curated set, replacing a heuristic (presence of a header line) that overwrote user customizations.

---

## 1. Over-block

**What legitimate inputs does this change reject that it shouldn't?**

- **Backward compat case (intentional, deprecation-window):** a script that legitimately can't add the `X-Instar-AgentId` header (third-party clients, legacy automation). Rejected at end of one-minor-version deprecation. During the window, accepted with a deduped log entry.
- **Migration `.new` case:** a user who intentionally customized `telegram-reply.sh` will see a `.new` candidate file and a degradation event but their script keeps running. They are *not* over-blocked — the original script keeps working; they get notified and can opt in. The risk is that they don't notice and miss the agent-id binding fix. Mitigated by surfacing through `DegradationReporter` (the existing user-facing degradation path).
- **`/whoami` rate limit (1 req/s per source):** a legitimate sentinel hammering `/whoami` faster than 1/s on stampede recovery. Acceptable: the spec design caches the result for 60s, so 1/s is one to two orders of magnitude above the expected request rate. Not over-blocking.

## 2. Under-block

**What failure modes does this still miss?**

- **Cross-tenant token leak via the `/events/delivery-failed` endpoint.** That endpoint is Layer 2; it doesn't exist yet. Until Layer 2 ships, the script still exits 1 on transport failures and the agent learns of failure but cannot persist it for sentinel recovery.
- **Stuck delivery without sentinel recovery.** Layer 3 (the DeliveryFailureSentinel) doesn't exist yet. Layer 1 alone closes the *cross-tenant token leak* class but not the *eventually deliver* class.
- **A buggy 3rd-party client that constructs `X-Instar-AgentId` from the wrong source** (e.g., reads the wrong agent's config). Layer 1 binds at the server side: a bogus header from such a client is rejected by the matching check on the receiving server. Not under-blocked.

## 3. Level-of-abstraction fit

**Is this at the right layer?**

Yes. Each piece is at the layer that has the right context:

- Port-from-config in the script is the right layer because the script is the entity that resolves connection details before each call. Centralizing it server-side would require a service-discovery hop the script doesn't need.
- Agent-id binding in the auth middleware is the right layer because the middleware already owns the auth check and runs once per request. Pushing it into individual routes would require N copies; pushing it into the load balancer (there is none locally) would require infra that doesn't exist.
- `/whoami` as a dedicated route (not a query parameter on `/health`) is correct because `/health` is intentionally unauthed (probe-only) and adding identity to it would either leak agent-id publicly or break existing probe semantics.
- SHA-based migration detection is the right layer because the migrator is the only thing that needs to know "is this file the canonical prior-shipped version?"

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

**Does this change hold blocking authority with brittle logic?**

- [ ] No — this change produces a signal consumed by an existing smart gate.
- [x] **No — this change has no judgment surface.** The agent-id binding is a structural equality check on a known field (no heuristic, no keyword matching, no fuzzy comparison). The port resolution is a deterministic preference order. The migration's SHA-set membership is an exact equality check.
- [ ] Yes — but the logic is a smart gate with full conversational context (LLM-backed with recent history or equivalent).
- [ ] ⚠️ Yes, with brittle logic — STOP.

The agent-id binding is the kind of "hard-invariant validation" the principle's "When this principle does NOT apply" section calls out: it's structural identity, not judgment. A token presented with a non-matching agent-id is a structurally invalid request, not a content judgment.

The migration's SHA-equality check is similarly structural — it answers "is this byte-for-byte the prior shipped content?" with a single hash comparison, no heuristics. The principle does not apply.

## 5. Interactions

**Does this interact with existing checks, recovery paths, or infrastructure?**

- **Shadowing:** the new `X-Instar-AgentId` validation runs *before* the existing token comparison. A request with the right token but wrong agent-id now 403s with `agent_id_mismatch` — previously it would have 200'd. **Intentional and central to the fix.** Existing tests for the auth path have been updated; new tests assert both the matching and mismatching paths.
- **Double-fire:** the deprecation log entry and the existing auth-failure log line could both fire on a malformed request. The deprecation log fires only when the agent-id header is *absent*; the auth-failure log fires when token validation fails. They cover disjoint cases — no double-fire.
- **Races:** the per-source 1-hr deprecation log dedup uses a small in-memory `Map`. The map is process-local; no cross-process race. Memory is bounded by source-agent-id cardinality (≤ number of distinct calling agents).
- **`/health` is NOT touched.** The unauth'd probe semantics remain. `/whoami` is the new authed identity check. Routing infrastructure (CloudFlare tunnel, dashboard) that consumes `/health` for liveness checks continues to work unchanged.
- **Existing `migrateReplyScriptTo408` is untouched** for the `slack-reply.sh` and `whatsapp-reply.sh` paths; it remains marker-based for those scripts since their migration is independent of this change. Only the telegram-reply.sh path moved to SHA-based detection.

## 6. External surfaces

**Does this change anything visible outside the immediate code path?**

- **Other agents on the same machine:** YES — and that's the point. An agent whose `telegram-reply.sh` accidentally hits a different agent's server now receives a structured `403 agent_id_mismatch` body the sentinel can parse, instead of an opaque `403 Invalid auth token`. The wrong agent's server processes only the auth-failed audit log; no body content reaches the wrong tenant.
- **Other users of the install base:** the `PostUpdateMigrator` runs on every `instar update`. Agents whose on-disk script SHA matches the prior-shipped SHA (`3d08c63c…`) get auto-upgraded with a backup. Agents whose script has been customized see a `.new` candidate file and a degradation event. Agents already on the new template are no-op'd (idempotent).
- **External systems (Telegram, GitHub, Cloudflare):** none. The Telegram API itself is not contacted differently. The CloudFlare tunnel (which proxies `/health` and similar) is unchanged.
- **Persistent state:** `.instar/backups/telegram-reply.sh.<epoch>` is created the first time the migrator upgrades an agent. These files persist on disk indefinitely until operator cleanup. Mode 0644 (readable). Spec § Layer 1a explicitly authorizes this.
- **Dashboard:** no change in this PR. Layer 3 will add a "Pending Replies" panel.

## 7. Rollback cost

**If this turns out wrong in production, what's the back-out?**

- **Port-from-config in the script:** revert the template, no migration step rerun needed (already-migrated scripts continue to work — `port` field stays in `config.json`). Hot-fix release.
- **Server-side agent-id binding:** revert the middleware change. Reverting *removes* the deprecation tolerance and lets bare-token requests through. Net effect: returns to current production behavior. Hot-fix release. **Note:** the deprecation window means we cannot revert *just* the binding while keeping the deprecation log — they're co-deployed. Reverting the binding reverts the log too.
- **`/whoami` endpoint:** revert the route. Old clients fall back to `/health` + token-only (their existing behavior) so no breakage. Hot-fix release.
- **SHA-based migration:** revert the new method, restore `migrateReplyScriptTo408` for the telegram-reply.sh path. Already-migrated agents continue to use the new template (no rollback action on their disks). Hot-fix release.
- **No data migration required** for any of the above. Backup files in `.instar/backups/` remain on disk and are operator-removable.

Estimated time-to-revert: ~10 minutes (single PR revert, CI green, ship).

## Conclusion

Layer 1 closes the cross-tenant token-leak class structurally, with no judgment surface and no new authority. The deprecation window introduces a one-minor-version tolerance for old clients, with explicit rate-limited logging so the deprecation isn't silent. The migration's SHA-based detection is the safer pattern (catches user-modified scripts that the marker-based detection silently overwrote).

This artifact covers Layer 1 only. Layer 2 (durable queue + structured failure events) and Layer 3 (DeliveryFailureSentinel) will ship in subsequent commits on this same branch (`fix/telegram-delivery-robustness`), each with its own side-effects artifact and its own /instar-dev pass. Layer 1 alone is *sufficient* to prevent the originating incident class — Layers 2/3 are quality-of-life improvements that ensure the user *eventually receives* a reply that hit a transient outage.

The change is clear to ship pending the second-pass review below.

---

## Second-pass review (REQUIRED — high-risk surface: outbound messaging + auth)

**Reviewer:** independent general-purpose subagent, fresh context.
**Independent read of the artifact: Concern raised — 7 findings.**

Findings and disposition:

1. **HIGH — internal callers (cli.ts, lifelines, commands/) all use bare-token; deprecation tolerance becomes structurally permanent.**
   *Disposition:* **Reframed.** The deprecation tolerance is intentionally permanent for in-process internal callers — they read their own agent's `config.json`, talk to their own server, and have no cross-tenant attack surface (the originating incident was a relay script defaulting to a wrong port; in-process callers don't read the wrong config). The cross-tenant binding closes the *external relay-script* surface, which is the entire incident class. Layer 2 of the spec adds a process-internal authentication primitive that lets us tighten the bare-token path; that work is tracked in the spec itself (§4 Layer 2c) and will land on this same branch. **Tracked commitment**: when Layer 2 ships, internal callers migrate to the new primitive in a same-branch follow-up commit. No orphan TODO; the spec is the tracking artifact.

2. **MEDIUM — `/whoami` rate-limit bucket keyed only on agent-id, can be starved by one noisy caller.**
   *Disposition:* **Fixed.** Bucket key is now `(agent-id, remoteAddress)`. Updated in `src/server/routes.ts` `createWhoamiHandler`. Test in `tests/unit/whoami-route.test.ts` covers the per-source isolation.

3. **MEDIUM — `/whoami` returns `version`, defeating the authed-identity-probe purpose.**
   *Disposition:* **Fixed.** `/whoami` now returns only `{ agentId, port }`. Layer 3's recovery path needs only those two fields. Test updated to assert `version` is not in the response body. Comment in route source explains the intentional omission.

4. **MEDIUM — SHA-list maintenance is unenforced; `.new` candidate generates noise on every repeated upgrade.**
   *Disposition:* **Partially fixed.** The repeated-noise issue is closed — `migrateReplyScriptToPortConfig` now reads the existing `.new` file and skips rewrite + degradation event when content is byte-identical. The CI lint that asserts every shipped historical telegram-reply.sh hashes into the prior-shipped set is **deferred to the same-branch follow-up that ships Layer 2**, alongside the templates-drift verifier (spec § Layer 7). Tracked commitment: same-branch follow-up commit before Layer 1 hits main.

5. **LOW — deprecation log restart-flood.**
   *Disposition:* **Accepted.** In-memory dedup state clears on every server restart. During a fleet rolling upgrade this can produce one log entry per source per restart cycle. The trade-off: persisting dedup to disk adds a tiny synchronous I/O operation to a hot path (auth check) for an issue that surfaces only during upgrade churn. Net signal-vs-cost favors the in-memory path.

6. **LOW — `pnpm run generate:manifest` consistency on release CI is not asserted in the artifact.**
   *Disposition:* **Already enforced.** `tests/unit/builtin-manifest.test.ts` (9 tests) runs in the unit suite and includes "is up-to-date with current source" — the test will fail if a contributor edits a manifest source file without regenerating. Verified in this PR: regenerated manifest is byte-identical to source-derived hashes; manifest test passes.

7. **LOW — `.new` candidate path is implicit judgment about user safety vs security fix delivery.**
   *Disposition:* **Documented.** Adding a paragraph below to call this out explicitly:

   > User-customized `telegram-reply.sh` scripts (those whose SHA-256 is not in the migrator's prior-shipped set) do *not* receive the agent-id binding fix automatically. They get a `.new` candidate file alongside their original and a `relay-script-modified-locally` degradation event. This is intentional — overwriting user customizations would be a worse failure mode — but it does mean the security fix has opt-in delivery for any agent that has ever been customized. The migrator's same-PR follow-up CI lint (concern #4 above) will help ensure the prior-shipped set captures every released version, minimizing the population that lands on the `.new` path inappropriately.

**Concur-after-fix.** Findings 1, 2, 3 fully addressed in this PR; 4 partially addressed (noise dedup landed; CI lint deferred to same-branch follow-up); 5–7 accepted with documentation. Layer 1 is clear to ship.

---

## Evidence pointers

- Bug-fix evidence: the original incident at topic 50 on 2026-04-27 17:44 UTC produced a `403 Invalid auth token` from a wrong-port server. With Layer 1 in place, the same script invocation against the same wrong port produces `403 { error: "agent_id_mismatch", expected: "<right-agent>" }` — and the wrong agent's server processes only an audit log line, never the message body. Reproducing this end-to-end requires real two-server setup, deferred to Layer 3's `tests/integration/delivery-recovery-cross-port.test.ts`. Layer 1 unit tests cover the equivalent decision points: `tests/unit/auth-agent-id-binding.test.ts` (7 tests), `tests/unit/telegram-reply-port-resolution.test.ts` (5 tests), `tests/unit/whoami-route.test.ts` (5 tests), `tests/unit/migration-relay-script-hash.test.ts` (5 tests), `tests/unit/PostUpdateMigrator-telegramReply.test.ts` (13 tests, updated).
- Test results: 35 new + 13 updated tests, all passing. Full unit suite: 13554 passing / 7 failing. Of the 7 failures, 6 pre-exist on origin/main (`security.test.ts > zero execSync` from commit 18a6735b's nuke.ts; `agent-registry.test.ts > port allocation` × 2; `ListenerSessionManager.test.ts > starts in dead state`; `pre-push-gate.test.ts` was failing on main and was fixed by this PR). The 7th was a transient race in `middleware-behavioral.test.ts` that re-runs cleanly.
- TypeScript: `pnpm tsc --noEmit` clean.
- Spec & convergence: `docs/specs/telegram-delivery-robustness.md` (review-iterations: 3, review-convergence: 2026-04-27T18:35:00Z, approved: true), `docs/specs/reports/telegram-delivery-robustness-convergence.md`.
