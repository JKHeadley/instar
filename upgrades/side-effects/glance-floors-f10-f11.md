# Side-Effects Review — Dashboard glance floors F10/F11 (Phase 1)

**Version / slug:** `glance-floors-f10-f11`
**Date:** `2026-07-10`
**Author:** `echo`
**Second-pass reviewer:** `not required` (no block/allow, session-lifecycle, or gate/sentinel/guard surface — this is a display-only front-end component; see §5)

## Summary of the change

Adds the two "glance floors" (F10 glance + F11 universal drill-down) to the Dashboard
UX Standard and ships their enforcement: one shared front-end component
`dashboard/glance.js` (a plain-English headline + ≤5 labeled tiles + a drill-down
container that opens a filtered list then a full record), a pure `validateGlanceSpec`
that refuses an over-budget or jargon-carrying glance, and three test tiers
(unit F10 + F11, integration against the real `/commitments` route, e2e feature-alive).
One view — the Commitments tab — is wired onto the component as the reference
implementation (glance layer → existing list as Layer 2 → full record as Layer 3).
Files: `docs/specs/dashboard-ux-standard.md` (+ `.eli16.md` + convergence report),
`docs/STANDARDS-REGISTRY.md`, `dashboard/glance.js` (new), `dashboard/index.html`
(Commitments panel markup + CSS + `loadCommitments` rewrite), and four test files.
**No `src/*.ts` change, no new server route, no config, no hooks.**

## Decision-point inventory

**No decision-point surface.** Nothing here gates information flow, blocks actions,
filters messages, or constrains agent behavior. `validateGlanceSpec` is a build-time
quality assertion over component-authored UI copy — it decides how a dashboard tab
*renders*, never what the agent may do. The one "refusal" (the component refusing to
render an over-budget/jargon glance) affects presentation only and falls back to an
honest degraded glance, never a raw dump — it holds no authority over any pipeline.

- `validateGlanceSpec` (dashboard/glance.js) — add — a pure UI-copy budget/jargon
  check; presentation-only, no runtime authority.

---

## 1. Over-block

**No block/allow surface — over-block not applicable.** The nearest analog is the
jargon check possibly rejecting legitimate glance copy. It is scoped to
*component-authored* Layer-1 strings only (headline + tile labels + values); agent/
user free text lives at Layer 2/3 and is displayed (sanitized), never vocab-gated — so
a user phrasing a promise with jargon can never blank the operator's glance. If the
check does reject a builder's copy, the component renders an honest degraded glance
(truncated headline + a drill), never a raw dump — no operator-visible data is lost.

---

## 2. Under-block

**No block/allow surface — under-block not applicable.** As a readability floor the
jargon detector is deliberately heuristic (it is NOT a secret-redaction boundary —
secret handling stays at the API/data layer, untouched here). It can miss novel
concept-jargon expressed in ordinary words; that residual is a tracked later-phase
tightening, and the curated insider-TERM denylist + form heuristics cover the known
classes (internal IDs, machine ids, config keys, cadences, state-machine names) with
bypass-variant tests.

---

## 3. Level-of-abstraction fit

Right layer. F10/F11 are enforced at the **component boundary** (a shared renderer +
a pure validator), not by scraping bespoke per-tab markup — because the glance content
is JS-rendered from live data, a static grep of `index.html` cannot see it, so the
component is the correct place to make the floor structural. The component REUSES the
existing lower-level primitives instead of re-implementing them: `sanitizeForDisplay`,
`hasOpenInteraction`, and `updateCountdowns` are imported from `dashboard/subscriptions.js`
(the shipped F9 safety + interaction-hold bar), so both surfaces share one contract.

---

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [x] No — this change has no block/allow surface.

`validateGlanceSpec` is a build-time/presentation quality check with no blocking
authority over any runtime pipeline. It informs how a tab renders (and, in the tests,
fails CI on a NEW below-floor tab) — it never gates a message, action, session, or
information flow. There is no brittle detector holding runtime authority here.

---

## 5. Interactions

- **Shadowing:** none. The glance component is additive; it renders into a new
  `#commitmentsGlance` container. It does not run before/after any check.
- **Double-fire:** none. `loadCommitments` replaces (never appends) the glance root
  and the drill container, so repeated renders/polls cannot accumulate DOM or listeners.
- **Races:** F9-composed. While a drill interaction is open (the drill container carries
  `data-interaction-open`, or a field is focused/dirty), a re-render MERGES live counts
  via `patchGlanceCounts` instead of rebuilding over the interaction — reusing the shipped
  `hasOpenInteraction`. The Commitments tab has no background poll today, so this is
  latent-but-correct (and unit-tested), and will already be right if a poll is added.
- **Feedback loops:** none — a pure renderer over data the tab already fetched.

---

## 6. External surfaces

- **Other agents / users / external systems:** none. `dashboard/glance.js` is a
  client-side ESM module served statically; it holds no secrets, opens no endpoint, and
  makes no network call of its own (the Commitments reference reuses the EXISTING authed
  `/commitments` GET and the EXISTING `/commitments/:id/deliver` POST).
- **Persistent state:** none touched.
- **Operator surface (Mobile-Complete):** the operator actions on this surface (view
  promises, drill in, mark delivered) are all completable from the dashboard, which is
  phone-reachable via the tunnel + PIN — no new laptop-bound step. The "Mark delivered"
  action lives on the Layer-3 record and calls the existing authed route.

---

## 6b. Operator-surface quality (Operator-Surface Quality standard)

This change touches an operator surface (`dashboard/glance.js`, `dashboard/index.html`).
The glance floors ARE the whole-view structural application of this standard.

1. **Leads with the primary action?** Yes. On arrival the Commitments tab shows the
   headline answer ("I'm carrying N open promises; K need attention soon, none overdue.")
   and the big labeled tiles — the state and the way in, visible immediately, no toggle,
   no below-the-fold, no explanatory prose in front.
2. **Zero raw internals as primary content?** Yes — enforced by F10 itself. No internal
   IDs, state-machine names, config keys, or seconds-cadences may appear at the glance
   layer (a machine-checked rule). The raw detail (`CMT-953`, `cadence 1800s`, timestamps)
   lives at Layer 3, one click down, where it belongs — verified in a real browser (tile →
   list → record).
3. **Destructive actions de-emphasized?** N/a-leaning: the only action is the constructive
   "Mark delivered", placed on the Layer-3 record (not above the glance). There is no
   destructive control on this surface; nothing louder than the primary path.
4. **Plain language + phone width?** Yes. Copy reads the way a person would say it
   ("Waiting on you", "Due soon", "Quiet"). Tiles use an auto-fit grid that reflows at
   phone width; the drill list/records stack; nothing scrolls the page sideways (records
   use `word-break`/`overflow-wrap`). Verified visually at 900px and via the responsive
   grid.

---

## 7. Multi-machine posture (Cross-Machine Coherence)

**machine-local BY DESIGN → effectively `unified` by construction.** `dashboard/glance.js`
is a **stateless client-side renderer**: it persists nothing, reads no config, holds no
server state, and introduces no machine-divergent state. It renders whatever data the
adopting tab already fetched and inherits that endpoint's existing posture — the
Commitments reference drills into `GET /commitments`, whose pool-scope posture
(`?scope=mesh`) is unchanged by this PR. So there is no new machine-local surface to
justify and no `machine-local-justification` marker is required.

- **User-facing notices:** none emitted (a passive render surface — one-voice gating n/a).
- **Durable state:** none held (nothing strands on topic transfer).
- **Generated URLs:** none (no links minted that must survive a machine boundary).

**Migration Parity:** met by construction. The dashboard ships wholesale via
`express.static(dashboardDir)` from the installed package directory (`package.json`
`files` includes `dashboard/`; `AgentServer.resolveDashboardDir` resolves to the package
root, not the agent home). A package update replaces `dashboard/glance.js` + updated
`index.html` on the normal update path — exactly as `dashboard/subscriptions.js` shipped —
so already-deployed agents receive the glance with **no `PostUpdateMigrator` entry** and
no `init`-only templating. `loadCommitments` loads `glance.js` through the same `try/catch`
dynamic-import guard the other tabs use, so a missing/failed module degrades the tab
gracefully. **Agent Awareness:** n/a — this is an internal dashboard UX/dev standard (how
a view renders), not a new operator-invocable capability/route/config/hook; the awareness
surface is `STANDARDS-REGISTRY.md` (nine → eleven floors), already updated.

---

## 8. Rollback cost

**Pure front-end change — revert and ship a patch.** No persistent state, no data
migration, no agent-state repair. `dashboard/glance.js` and the `index.html` edits are
replaced wholesale on the next package update; reverting the commit restores the prior
Commitments renderer. No user-visible regression during the rollback window (the tab
simply reverts to its previous look). The new tests would revert with the code.

---

## Conclusion

This review produced no blocking concerns. The change is display-only with no
decision-point, block/allow, session-lifecycle, or gate/sentinel surface, so no
second-pass review is required. The design was materially hardened by /spec-converge
(a six-angle internal panel + the code-backed Standards-Conformance Gate + an external
Gemini pass across three rounds): the Layer-1-is-100%-component-authored invariant that
makes the jargon check both safe and complete; the XSS/display-safety contract reusing
the shipped `sanitizeForDisplay`; bypass-resistant vocab detection; the honest-degraded
(never raw-dump) failure mode; a strengthened F11 (non-vacuous, distinct, tile→list→record,
XSS + dead-end negatives); the structural grandfather ratchet (completeness + monotonic
ceiling); the one-population honest tile→server-field derivation with a count-truthfulness
test; and all three test tiers. Verified live in a real browser (Playwright): the
Commitments glance renders headline + tiles, and drilling opens the filtered list then the
full record with the raw IDs/cadence correctly one click down. Clear to ship.

---

## Second-pass review (if required)

**Reviewer:** not required — no block/allow, messaging-dispatch, session-lifecycle,
compaction, coherence/idempotency/trust, or sentinel/guard/gate/watchdog surface (Phase-5
triggers). Display-only front-end component.

---

## Evidence pointers

- Unit: `tests/unit/dashboard-glance-word-budget.test.ts` (31 tests — F10 budget/jargon +
  bypass variants + adversarial-fixture conformance + count-truthfulness + the ratchet),
  `tests/unit/dashboard-glance-drilldown.test.ts` (8 tests — F11 walk, Layer-2→3, negatives,
  F9 hold, XSS).
- Integration: `tests/integration/glance-commitments-tab.test.ts` (glance built + walked
  against a real `GET /commitments` HTTP response with a live `CommitmentTracker`).
- E2E: `tests/e2e/glance-commitments-tab-lifecycle.test.ts` (feature-alive: 200 not 503,
  feature ON/OFF, full render, no `<script>` survives).
- Live: Playwright render of the reference glance — headline "I'm carrying 5 open
  promises; 2 need attention soon, none overdue.", 4 tiles, tile→list (2 rows)→record
  (`id: CMT-953`, `cadence: 1800s` at Layer 3 only).
- Spec convergence report: `docs/specs/reports/dashboard-ux-standard-convergence.md`.

---

## Class-Closure Declaration (display-only mirror)

No agent-authored-artifact defect and no self-triggered controller (no loop / monitor /
sentinel / reaper / scheduler / recovery path that fires a restart / swap / respawn /
spawn / notify / retry / re-drive / kill) — **not applicable**.
