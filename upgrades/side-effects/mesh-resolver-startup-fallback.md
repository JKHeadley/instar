# Side-Effects Review — Mesh resolver startup fallback

**Version / slug:** `mesh-resolver-startup-fallback`
**Date:** `2026-08-27`
**Author:** `Echo`
**Second-pass reviewer:** `Lorentz (concurred after revision)`

## Summary of the change

`src/core/resolveMeshPeerUrl.ts` adds one peer-routing funnel used by the production session-pool closure in `src/commands/server.ts`. It preserves preferred multi-rope resolution when optional mesh initialization succeeds and uses the existing registry URL when initialization degrades before assigning `meshResolver`. The change repairs a live restart crash without changing mesh ordering or inventing reachability.

## Decision-point inventory

- `resolveMeshPeerUrl()` — add — mechanical selection between an available resolver result and the already-authoritative legacy registry URL.
- Session-pool `peerUrl` closure — modify — delegates URL selection to the undefined-safe funnel.

## 1. Over-block

No block/allow surface — over-block not applicable. A peer with neither an initialized resolver candidate nor a legacy URL remains unreachable exactly as before.

## 2. Under-block

The fallback does not repair the earlier mesh initialization failure; it contains its blast radius so the server starts and legacy routing remains usable. Other call sites that independently dereference optional mesh state would require their own funnel, but focused search found this production closure as the crashing independent consumer.

## 3. Level-of-abstraction fit

The helper sits at the peer-URL resolution boundary, below session routing and above the resolver implementation. It reuses `PeerEndpointResolver` and the existing legacy registry URL rather than duplicating endpoint validation or transport policy.

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [x] No — this change has no block/allow surface.

This is deterministic availability plumbing. It does not interpret intent, filter messages, or make a judgment call; it preserves a previously supported route when an optional dependency is absent.

## 4b. Judgment-point check (Judgment Within Floors standard)

No new static heuristic at a competing-signals decision point. The choices are fully enumerable: use the initialized resolver's first candidate, else the persisted legacy URL, else no route.

## 5. Interactions

- **Shadowing:** when the resolver exists, its result is authoritative—including an empty result. The legacy fallback runs only when resolver construction never completed.
- **Double-fire:** the helper performs no I/O and triggers no action.
- **Races:** it reads only values already captured by the calling closure; no mutable state is added.
- **Feedback loops:** it records nothing and cannot feed back into mesh health.

## 6. External surfaces

Agents whose optional mesh bootstrap degrades now retain server availability and legacy peer routing. No message shape, API, credential, database, ledger, or operator action changes. Timing remains owned by the existing startup and resolver paths.

## 6b. Operator-surface quality (Operator-Surface Quality standard)

No operator surface — not applicable.

## 7. Multi-machine posture (Cross-Machine Coherence)

**Replicated behavior:** every machine executes the same local resolution funnel against its own live resolver and replicated machine-registry entry. A degraded machine may temporarily use the peer's single legacy URL while a healthy machine uses multiple ropes; that difference reflects machine-local transport health rather than divergent authority. The change emits no notices, holds no durable state, and generates no new URLs.

## 8. Rollback cost

Pure code hotfix: revert and ship another patch. No persistent state, migration, or agent repair is required. Rollback would reintroduce the startup crash on the demonstrated degraded-mesh state.

## Conclusion

The fallback contains an optional-subsystem failure at the correct dependency boundary while keeping successful mesh behavior unchanged. The live before/after restart and all three test tiers support shipping after independent lifecycle review and green CI.
The production closure now also states its best-effort initialization contract at the call site.

## Second-pass review (if required)

**Reviewer:** Lorentz
**Independent read of the artifact:** concur after revision. The first pass found that a nullish chain also fell back when an initialized resolver deliberately returned no safe candidates. The helper now branches only on resolver absence, and unit/integration tests pin the empty-result boundary.

## Evidence pointers

- Live before: Echo restart terminated at `meshResolver.resolve` with an undefined resolver.
- Live after: the same installed build with the funnel guard bound port 4042 and answered `/updates/status`.
- `tests/unit/resolve-mesh-peer-url.test.ts`
- `tests/integration/resolve-mesh-peer-url.test.ts`
- `tests/e2e/mesh-resolver-startup-lifecycle.test.ts`

## Class-Closure Declaration (display-only mirror)

No agent-authored-artifact defect and no self-triggered controller change — not applicable.
