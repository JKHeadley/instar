# Side-Effects Review — Capabilities Discoverability

**Version / slug:** `capabilities-discoverability`
**Date:** `2026-05-21`
**Author:** `Echo (instar-developing agent)`
**Second-pass reviewer:** `not required` (additive observability change with no decision-point surface)

## Summary of the change

Surfaces six previously-invisible primitives in the `GET /capabilities` response — `secrets`, `commitments`, `tokens`, `semantic`, plus explicit endpoint arrays on the existing `publishing` and `privateViewer` blocks. Adds a new unit test `tests/unit/capabilities-discoverability.test.ts` that walks `src/server/routes.ts` for every top-level route prefix and asserts each either appears in the `/capabilities` response body or is on an explicit `INTERNAL_ALLOWLIST` with a one-line reason.

Files touched:

- `src/server/routes.ts` — six additive blocks inside the existing `GET /capabilities` handler.
- `src/data/builtin-manifest.json` — regenerated content hashes for the `route-group` entries that cover routes.ts.
- `tests/unit/capabilities-discoverability.test.ts` — new lint test.
- `upgrades/NEXT.md` — release notes.
- `docs/specs/capabilities-discoverability.md` + `docs/specs/capabilities-discoverability.eli16.md` — spec + ELI16 companion.

## Decision-point inventory

- `GET /capabilities` response body — **modify (additive)** — the agent's authoritative self-discovery surface. Six new fields added; no existing field removed or shape-changed.
- New lint test — **add** — fails CI if any route prefix isn't either surfaced or allowlisted. No runtime block authority.

---

## 1. Over-block

**What legitimate inputs does this change reject that it shouldn't?**

No block/allow surface — over-block not applicable. The runtime change is pure response-body enrichment. The lint test only blocks at CI when a new route prefix is registered without a discoverability decision being made; that's the intent.

---

## 2. Under-block

**What failure modes does this still miss?**

The lint asserts each prefix appears *somewhere* in the response body. It does NOT verify the surfaced entries actually match the live routes — a typo in the endpoint listing string ("POST /secrtes/request") would slip through. This is the minimum-viable bar; a follow-up could compare the endpoint strings against the actual registered routes. Tracked but not blocking.

The lint also does not catch the case where a route prefix exists, is allowlisted as "surfaced inside X block," but X block was later removed. The allowlist is comment-anchored, not code-anchored. Acceptable because each allowlist entry has a one-line reason; reviewer catches drift on the next PR that touches X.

---

## 3. Level-of-abstraction fit

**Is this at the right layer?**

The runtime change is at the right layer: it enriches a response handler that already exists, no new module needed. The lint is at the right layer: a unit test that parses source, no server runtime needed, fast enough to run on every push.

The deferred follow-up (introspecting `/capabilities` from `FeatureRegistry` + live router) would be a refactor at a higher layer — replacing the hand-curated object literal with a derivation. That's the right home for a future PR but would balloon scope here.

---

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

**Does this change hold blocking authority with brittle logic?**

- [x] No — this change has no block/allow surface at runtime.

The lint test holds CI-time block authority (it can fail a build), but that authority is delegated to a human reviewer + branch-protection rules; the lint itself just emits a signal. The runtime change is pure observability — no decision point is gated on the new fields.

---

## 5. Interactions

**Does this interact with existing checks, recovery paths, or infrastructure?**

- **Shadowing:** the `/capabilities` response is consumed by agents, by the dashboard, by `feature-delivery-completeness.test.ts`, and by `SeedMigration.test.ts`. All consumers do field-presence checks, not exact-shape assertions; additive fields are safe. Verified by running the full unit suite — no new failures introduced.
- **Double-fire:** no overlap with other checks; `/capabilities` is a single read endpoint.
- **Races:** no shared state introduced.
- **Feedback loops:** none. The response is read-only.

The new lint test reads `src/server/routes.ts` and the `INTERNAL_ALLOWLIST` literal. Its only "interaction" is with future PRs that add route prefixes — the lint will fail loudly until those PRs either surface or allowlist the new prefix. That's the intent.

---

## 6. External surfaces

**Does this change anything visible outside the immediate code path?**

- **Agents on the same machine:** yes — agents will see additional fields in `/capabilities`. All new fields are nested under new keys (`secrets`, `commitments`, etc.) or are new keys (`endpoints`) on existing nested objects. No existing key changes shape. Agents that ignore unknown keys continue to work; agents that iterate keys now see more capabilities, which is the intended behavior.
- **Other users / install base:** no behavioral change. The next release will publish the enlarged response.
- **External systems:** no external surface touched.
- **Persistent state:** none — `/capabilities` is a read endpoint, no writes.
- **Timing / runtime conditions:** the new blocks include `secretDrop.listPending().length` and reads of `ctx.publisher?.listPages()`, `ctx.viewer?.list()`. All three are cheap in-memory reads that the response already touched. No new latency surface.

---

## 7. Rollback cost

**If this turns out wrong in production, what's the back-out?**

Pure code change. Revert the two files (`src/server/routes.ts` and the new test) and the manifest will regenerate on the next build. No persistent state, no agent-state repair needed.

User-visible regression during rollback window: the new `/capabilities` fields would disappear, and any agent that had started relying on them in the meantime would see a temporary loss of discoverability for those primitives. The primitives themselves keep working — only the discovery surface contracts.

Realistic rollback cost: under 5 minutes, single revert + patch release. No downtime.

---

## Conclusion

This is a low-risk additive observability change. It closes a structural-honesty gap in the agent's self-discovery surface and locks the promise with a lint that catches future regressions. The runtime change is pure response enrichment with no decision-point surface; the lint is a signal-only test that delegates block authority to the CI gate. Two follow-ups are explicitly deferred and tracked in the spec. No second-pass review required.

---

## Evidence pointers

- Spec: `docs/specs/capabilities-discoverability.md`
- ELI16: `docs/specs/capabilities-discoverability.eli16.md`
- Repro of the gap (pre-fix): `curl /capabilities | jq 'keys'` on v1.1.4 returns no `secrets`, `commitments`, `tokens`, or `semantic` blocks.
- Repro of the fix: the new unit test passes 81/81 with the additions in place; removing the `secrets` block from the response makes the corresponding test fail with a precise error pointing the author at the missing entry.
- Origin: topic 11141 ("🔍 Discoverability Secret Access"), case study seeded 2026-05-20.
