# Side-Effects Review — Dashboard PR Pipeline tab

**Version / slug:** `pr-gate-phase-a-commit-7-dashboard-tab`
**Date:** `2026-04-17`
**Author:** `Echo (instar-developing agent)`
**Second-pass reviewer:** `not required per /instar-dev Phase 5 criteria — no block/allow surface, no session lifecycle, no gate/sentinel. XSS-defense rules enumerated in artifact and asserted by smoke tests.`

## Summary of the change

Adds a read-only "PR Pipeline" tab to the dashboard. The tab fetches `/pr-gate/metrics` on activation and renders the current pipeline state. During Phase A (`prGate.phase='off'`, landing in commit 8), the endpoint returns 404 — the tab detects this and renders a "Gate disabled (phase=off)" placeholder rather than erroring.

Surface rules enforced **structurally** (not just by policy):
- **Read-only**: no action buttons; no POSTs; tests assert the loader contains no `/pr-gate/authorize`, `/pr-gate/eligible`, or `method: 'POST'` string.
- **XSS defense**: all PR-authored content is rendered via `textContent` / DOM-element construction; tests assert `.innerHTML` does NOT appear inside the loader's body. Card headers, PR numbers, SHAs, reasons, and timestamps all get text injected as textContent.
- **No new inline script sources**: the logic lives in the dashboard's existing inline `<script>` block; no new `<script src="…">` tags. Existing CSP untouched.
- **No new HTTP endpoint**: read-only consumer of `/pr-gate/metrics` (endpoint shipping in later phase).
- **No new SSE subscriber**: the tab does not open an EventSource. SSE piggybacks the existing `/events` stream's `pr-pipeline` channel filter when wired up in a future phase — this commit ships only the fetch-based view.

Files touched:
- `dashboard/index.html` — tab button in the nav (+1 line); prPipelinePanel container (+17 lines); TAB_REGISTRY entry (+6 lines); `loadPrPipeline` function (~100 lines, well-bounded).
- `tests/unit/dashboard-prPipelineTab.test.ts` — 5 smoke tests enforcing the structural invariants above.

This is commit 7 in the Phase A landing of `docs/specs/PR-REVIEW-HARDENING-SPEC.md`. Spec §"Dashboard PR Pipeline tab — concrete editing plan" and §"Dashboard surface rules" specify exactly this shape.

## Decision-point inventory

- **None.** The tab is a pure data viewer. No judgment, no block/allow, no classifier. Server-side decisions about eligibility are made elsewhere (future phases) and merely rendered here.

---

## 1. Over-block

**What legitimate inputs does this change reject that it shouldn't?**

No block/allow surface — over-block not applicable.

One edge behavior: if `/pr-gate/metrics` returns a 500 or a timeout, the tab renders "PR Pipeline metrics unavailable" and shows the empty-state placeholder. A user might expect a retry button — intentional over-restriction for Phase A (manual Refresh button is present; retry affordance not needed during the inert phase).

---

## 2. Under-block

**What failure modes does this still miss?**

No block/allow surface — under-block not applicable.

Related concerns:
- If `/pr-gate/metrics` returns a compromised response with unexpected fields, the tab silently ignores the bad fields (`typeof entry.pr_number === 'number'` and similar guards). A malicious response with a large `entries` array could DOS the browser tab — acceptable given the tab talks only to the local Echo server which requires a bearer token. A future ceiling on entries.length could be added (`entries.slice(0, 500)`) as a defense-in-depth if/when this endpoint is exposed beyond the dashboard's localhost/tunnel origin.
- If `/pr-gate/metrics` returns a response that looks like PR content in text fields (title, reason), the tab's `textContent` rendering is the defense. An attacker who controls the API response has already compromised the Echo server; at that point XSS via the dashboard is one of many available attack paths. The defense is not trying to hold against root compromise; it's preventing a rogue PR author from injecting script via their PR title or reviewer-quoted diff content.

---

## 3. Level-of-abstraction fit

**Is this at the right layer?**

Yes. The spec explicitly calls for a direct edit to `dashboard/index.html` (the 6000+ line monolithic HTML page), not a module extraction. The spec's §"Dashboard surface rules" notes "If a future tab needs richer rendering, the move is to extract the dashboard to a proper module — out of scope for this spec." The edit follows the pattern established by the existing tabs (Sessions, Files, Jobs, etc.) — each tab is a `<div>` section plus a TAB_REGISTRY entry plus a loader function.

---

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

**Does this change hold blocking authority with brittle logic?**

- [x] No — this change has no block/allow surface. It is a presentation layer over a read-only API endpoint. No classification, no filtering, no decision is made by the UI. XSS defense via `textContent` is a hard-invariant safety guard (carve-out per signal-vs-authority.md) — a mechanical property of how DOM APIs work, not a judgment.

---

## 5. Interactions

**Does this interact with existing checks, recovery paths, or infrastructure?**

- **Shadowing:** the new tab sits alongside existing tabs. The existing `switchTab()` dispatcher handles panel show/hide generically via TAB_REGISTRY. No shadow.
- **Double-fire:** the loader is re-invoked only on explicit panel re-activation or Refresh-button press. No auto-poll.
- **Races:** `loadPrPipeline` is async but single-caller per tab activation. Two rapid activations would cause two in-flight fetches; the later one wins because the DOM updates are idempotent write-into-container-then-clear. No corruption possible.
- **Feedback loops:** none. The UI reads; it does not write back.
- **Interaction with `apiFetch`:** deliberately bypassed because apiFetch throws on non-200, and the Phase A semantic for `/pr-gate/metrics` is "404 when phase=off" — needed to distinguish 404 from other errors. Used raw `fetch(..., { headers: { Authorization: `Bearer ${token}` } })` matching apiFetch's auth convention. Token variable is the existing module-scoped `token` used by every other dashboard fetch.
- **Interaction with `/events` SSE:** none added. Future phases may subscribe to a `pr-pipeline` channel; this commit doesn't.
- **Interaction with CSP:** the page already ships a CSP (inspected via existing inline scripts without `unsafe-inline` exceptions needing to change). This commit adds no new inline script sources, no `<script src=>` tags, no `eval`, no dynamic `Function()` construction. CSP unchanged.

---

## 6. External surfaces

**Does this change anything visible outside the immediate code path?**

- **Other agents on the same machine:** none.
- **Users of the install base:** the dashboard ships with one more tab button. When clicked on an agent with `prGate.phase='off'` (every agent until Phase B), the tab shows "Gate disabled (phase=off)" and an empty list. No auto-polling, no connection, no visible side effect.
- **External systems:** none.
- **Persistent state:** none. Tab is rendered from live API response each activation.
- **Timing:** initial fetch ~instant on local Echo. Rendering is O(n) on entries (small; spec caps `live` table at 10,000 rows — server will paginate before that becomes relevant).
- **Dashboard page weight:** HTML file grew by ~130 lines (~5KB). Negligible.

---

## 7. Rollback cost

**If this turns out wrong in production, what's the back-out?**

Pure code revert. The four edits (button, panel, registry, function) undo cleanly. Already-served dashboard pages (browser-cached) will disappear the tab on next hard reload; there is no persistent user state tied to this tab. Zero operational complexity.

---

## Conclusion

Read-only dashboard tab with structurally-enforced XSS defense (textContent only, no innerHTML in the loader body) and 404-aware phase-off handling. 5 smoke tests assert the structural invariants that protect against accidental regression. tsc clean; no sibling tests affected.

Clear to ship as Phase A commit 7 of 8.

---

## Second-pass review (if required)

Not required per `/instar-dev` Phase 5 criteria. The tab has no block/allow authority, no session-lifecycle surface, and no gate/sentinel/watchdog name. The security-relevant property (no innerHTML, no POSTs to mutate state) is structural and asserted by tests.

---

## Evidence pointers

- Source: `dashboard/index.html` — 4 edits (tab button, panel container, TAB_REGISTRY entry, loadPrPipeline function).
- Tests: `tests/unit/dashboard-prPipelineTab.test.ts` — 5 smoke tests, 31ms.
- Type check: `npx tsc --noEmit` — clean.
