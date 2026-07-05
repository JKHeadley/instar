# Side-Effects Review — Read-only Routing Map surface (Surface 3)

**Version / slug:** `routing-map-surface`
**Date:** `2026-07-05`
**Author:** `Echo (instar-dev build hand)`
**Second-pass reviewer:** `not required (Tier 1, read-only surface)`

## Summary of the change

Adds a READ-ONLY "routing map" surface: a Bearer-auth API route `GET /intelligence/routing/chains` and a "Routing Map" dashboard tab. For every known internal job-kind (`knownComponents()`), it shows its nature/lane (`LLM_ROUTING_NATURE`), the ordered `NATURE_ROUTING_DEFAULT_CHAINS` fallback positions resolved to concrete model ids (`ROUTING_LABEL_TO_MODEL_ID`), and per-position/per-component flags (door class, per-position injection-safe, money-gated, metered-skipped-in-Increment-A, critical-gate, per-component untrusted-input, and the FD5b `LLM_ROUTING_INJECTION_EXPOSURE` classification — exposed + user/model/tool channels — surfaced now that it is on the rebased base). Files touched: new `src/core/natureRoutingMap.ts` (pure composer), `src/server/routes.ts` (one new sibling route + import), `dashboard/index.html` (nav button + panel + registry entry + `loadRoutingMap()`), and two new tests. It aligns with the spec's FD11 "readable canary" (`docs/specs/nature-axis-routing.md` §475). It composes existing static maps only — it changes NO routing behavior.

## Decision-point inventory

The change adds NO decision point. It is pure display of existing routing decisions.

- `resolveRoute` / selection logic — pass-through (NOT touched; the map imports only the static data maps + `resolvePositionModelId`-equivalent label resolution).
- `GET /intelligence/routing` (legacy category→framework view) — pass-through (untouched; a sibling route was added instead of extending it, to keep it byte-identical).

---

## 1. Over-block

No block/allow surface — over-block not applicable. The route only returns data; it never rejects any input except an unknown `?trace=` name (a 404, correct).

---

## 2. Under-block

No block/allow surface — under-block not applicable.

---

## 3. Level-of-abstraction fit

Correct layer: an observability read surface, mirroring the existing `GET /intelligence/routing` + `LLM Activity` tab pattern. The composition logic lives in a pure `src/core/natureRoutingMap.ts` module (not in the route handler) so it is unit-testable in isolation and reusable; the route is a thin adapter that adds the one live read-only annotation (each component's currently-enforced legacy framework via `IntelligenceRouter.for`). It re-uses the shipped static maps rather than re-deriving routing — no parallel implementation of routing logic.

---

## 4. Signal vs authority compliance

**Required reference:** docs/signal-vs-authority.md

- [x] No — this change has no block/allow surface.

It is a pure read. It holds zero authority: it cannot route, gate, block, or mutate anything. It only reads and formats existing data.

---

## 5. Interactions

- **Shadowing:** none. The new route path (`/intelligence/routing/chains`) is distinct from the legacy `/intelligence/routing`; Express matches the exact path, no overlap. The 503-when-no-router guard mirrors the legacy route.
- **Double-fire:** none — read-only, idempotent, no events emitted.
- **Races:** none — reads shared IMMUTABLE static config maps (`NATURE_ROUTING_DEFAULT_CHAINS` etc.) and returns; writes nothing, holds no state.
- **Feedback loops:** none — it does not feed any system; nothing consumes its output except a human reading the dashboard.

Verified: an integration test asserts the legacy `GET /intelligence/routing` still returns its own shape (no `chains` key) and is not broken by the sibling.

---

## 6. External surfaces

- **Other agents / install base:** none — a new read route + a new dashboard tab, both additive.
- **External systems:** none — no Telegram/Slack/GitHub/Cloudflare calls; zero egress.
- **Persistent state:** none — the composer and route write nothing to disk, config, ledgers, or memory. Purity is asserted by test (repeated calls deep-equal; the shared static input map is unchanged after a build).
- **Operator surface (Mobile-Complete):** the new dashboard tab IS the operator surface, and it is fully phone-reachable via the standard dashboard (PIN-gated) — no API-only action. There is no operator ACTION here (nothing to do but read/refresh), so Mobile-Complete is trivially satisfied.
- **Timing/runtime:** none.

---

## 6b. Operator-surface quality (Operator-Surface Quality standard)

This change touches an operator surface (`dashboard/index.html`), so the operator-surface quality review is required.

1. **Leads with the primary action?** Yes. The tab's purpose is to READ the routing map; on arrival it shows the four lanes and the by-job-kind table immediately (the loader fires on tab activation). There is no primary "action" to lead with beyond the content itself; a single Refresh button sits top-right, matching the sibling `LLM Activity` tab.
2. **Zero raw internals as primary content?** The subject matter here IS technical identifiers (door names and model ids) — that is the whole point of a routing map, exactly as the `LLM Activity` tab shows provider + model names. They are presented in labeled table columns and plain-language flag chips ("metered · skipped now", "money-gated", "unsafe for untrusted input", "no-Claude"), NOT as raw JSON blobs, UUIDs, or hashes. A plain-English intro paragraph frames the page in non-engineer language. There are no inputs asking the operator to paste raw text (verified: the surface has no `<input>`/`<textarea>`; the raw-input lint passes).
3. **Destructive actions de-emphasized?** No destructive actions exist on this surface (read-only) — nothing to revoke/delete/stop.
4. **Plain language + phone width?** The lane cards use an auto-fit responsive grid (`minmax(240px,1fr)`) that stacks at phone width; the by-job-kind table lives in an `overflow-x:auto` container (matching the `LLM Activity` table pattern) so it scrolls inside its own box rather than breaking the page. Labels read plainly ("Job-kind", "Lane", "Enforced now", "Critical gate", "Untrusted input", "Fallback order").

---

## 7. Multi-machine posture (Cross-Machine Coherence)

**machine-local BY DESIGN — pure per-machine observability.** The routing map is composed from static code-shipped data (identical on every machine of the same version) plus each machine's own live enforced-framework read. There is no durable state to strand on a topic transfer, no user-facing notice (so no one-voice gating needed), and no generated URL (so nothing to survive a machine boundary). An operator viewing the tab on any machine sees that machine's map; since the static data is version-pinned, the map is the same across machines at the same version (a version-skew would show honestly via the machine's own model ids). No pool-wide merge is warranted — "which doors does THIS machine's build route to" is a per-machine truth.

---

## 8. Rollback cost

- **Hot-fix release:** pure additive code change — revert the route + module + dashboard additions and ship as the next patch.
- **Data migration:** none — no persistent state introduced.
- **Agent state repair:** none — no existing agents need notification or reset; the surface simply disappears on revert.
- **User visibility:** none beyond the tab vanishing; no regression to any existing behavior during the rollback window (the legacy route and all routing logic are untouched).

---

## Conclusion

This review produced no design changes. The feature is a pure, additive, read-only observability surface that displays the existing routing map without altering any routing behavior, holding any authority, or writing any state. It is clear to ship. Scope was deliberately confined to Surface 3 (the read-only map); the money/PIN-gated write controls (Surfaces 1/2) are explicitly out of scope and untouched.

---

## Second-pass review (if required)

Not required — Tier 1, read-only surface, no block/allow authority, no persistent state.

---

## Evidence pointers

- `tests/unit/nature-routing-map.test.ts` — composer resolves known components to expected ordered chains + model ids + flags; purity assertion (repeated calls deep-equal, static input unmutated).
- `tests/integration/intelligence-routing-chains-route.test.ts` — alive test (200 + full map, not 503); `?trace` + 404; 503 when no router; legacy route unchanged; deterministic across calls.

---

## Class-Closure Declaration (display-only mirror)

No agent-authored-artifact defect and no self-triggered controller — not applicable. This change adds no loop/monitor/sentinel/reaper/scheduler/recovery path; it is a passive read surface.
