# Side-Effects Review — Subscriptions "Set up" flow: never-clobber refresh, in-cell complete flow, wrong-account guard surfacing, unmistakable terminal states, record⟂pane liveness (topic 29836 D1–D5)

**Version / slug:** `subs-setup-flow-ux`
**Date:** `2026-07-10`
**Author:** Echo (instar-dev agent)
**Second-pass reviewer:** not required (no new blocking authority — see §4; the one identity gate touched is pre-existing, converged, and only has its verdict SURFACED)

## Summary of the change

Fixes the five operator-observed (screenshot-proven, topic 29836, 2026-07-10) defects in the dashboard Subscriptions tab's account×machine "Set up" enrollment flow. **D1** — the 30s poll re-rendered the matrix/panel out from under an open interaction (PIN input reverted to a button mid-typing; the code-paste step swapped for "◷ Signing in…"); fixed as a RULE: new F9 primitives `hasOpenInteraction` + `updateCountdowns` in `dashboard/subscriptions.js`, and the controller rebuilds a surface only while no interaction is open (episode marker `data-interaction-open`, focused text-entry, or dirty field), merging countdowns in place otherwise. **D2** — the flow's continuation lived only in the bottom "Pending logins" panel; now the matrix cell carries the COMPLETE flow (sign-in link, expected-account notice, code input, TTL countdown, two-codes notice, Cancel), rendered from SERVER pending-login state via `appendCellSignInFlow` so it also survives reloads and rebuilds. **D3** — the wrong-account hazard: the UI now states which account the OAuth page MUST show (from the enrollment record's `expectedEmail`, passed through start-cell responses), and the pre-existing S7 email-gate's held verdict now carries `expected`/`got` through `EnrollmentWizard.completeFollowMe` → the submit-code response → plain-language copy naming BOTH accounts; oracle-unavailable keeps failing CLOSED with honest "couldn't confirm" copy. **D4** — invisible success: explicit terminal presentations (in-cell "✓ All set" + transient `just-verified` highlight bridging until the pool read catches up; explicit held/expired/broken states; durable done/failed cards in the pending panel). **D5** — the re-sign-in flow: pending logins are annotated with `paneAlive` (record⟂pane reconciliation; tri-state, fail-toward-unknown); a dead-pane record renders an explicit needs-restart state and code-submit against it answers a machine-readable 409 `pane-dead`; enroll/start enforces single-attempt discipline (reuse a live attempt / supersede a dead one atomically — codes can never cross between parallel PKCE attempts); a new `sweepFollowMeCompletions` handles the already-authorized short-circuit (credential lands with no code ever shown) through the SAME identity gate; validated completions UPSERT an existing pool account (re-auth previously crashed on `add()`'s duplicate-id refusal and stranded the flow); wording floors (account by email, machine by nickname — never a raw `m_<hex>` id; errors only reference affordances that exist on their surface). Files: `dashboard/subscriptions.js`, `dashboard/index.html`, `src/server/routes.ts`, `src/core/EnrollmentWizard.ts`, `src/commands/server.ts`, `docs/specs/dashboard-ux-standard.md` (F9), `docs/STANDARDS-REGISTRY.md`, tests in all three tiers.

## Decision-point inventory

- `S7 email gate (validateEnrolledAccountEmail / completeFollowMe)` — pass-through — the pre-existing fail-closed identity gate is UNCHANGED in logic; its verdict now carries `expected`/`got` up to the surface. No new accept/reject behavior.
- `submit-code pane-readiness guard (routes.ts)` — modify (split, not weakened) — the existing fail-closed 409 is split into two machine-readable refusals: `pane-dead` (capture null/empty) vs `pane-not-ready` (live but not at the code prompt). Every input refused before is still refused; nothing new is accepted.
- `enroll/start single-attempt pre-check (routes.ts)` — add — a re-request while a HEALTHY attempt is live returns THAT attempt (idempotent read, not a block); only a provably-dead-pane attempt is superseded (abandon + fresh drive). Fails toward REUSE when liveness is unverifiable — it can never kill a healthy attempt on a capture hiccup.
- `start-cell reuse gate (routes.ts)` — modify — reuse additionally requires `paneAlive !== false` (same fail-toward-reuse posture).
- `sweepFollowMeCompletions (EnrollmentWizard + server.ts timer)` — add — detects a landed credential and drives the EXISTING completeFollowMe gate; it holds no accept authority of its own (a mismatch is held exactly as before).
- `F9 interaction hold (dashboard/subscriptions.js)` — add — client-side rendering-timing rule only; it gates WHEN the DOM rebuilds, never what the server accepts or what messages flow.

---

## 1. Over-block

- `pane-dead`/`pane-not-ready` split: no legitimate input newly rejected — the predicate set is identical to the old combined check; only the refusal is classified. A pane that IS at the code prompt still accepts the code.
- enroll/start reuse: a re-request that previously minted a duplicate (or 500'd on the store's duplicate-pending refusal after killing the old pane) now gets the live attempt back — strictly fewer refusals.
- Supersede: only fires when `paneAlive === false` (capture EXPLICITLY says the tmux session is gone). An unverifiable capture (`null`) reuses — no healthy attempt is ever abandoned on uncertainty.
- F9 hold: a surface with a permanently-dirty field would stop rebuilding — mitigated: terminal paths clear inputs, the PIN stage has an explicit Back, episodes always resolve (validated/held/broken/expired via the reconciler), and countdown merges keep held surfaces honest meanwhile. Worst case is a stale (not wrong) panel until the operator finishes or backs out.
- No issue identified beyond the above.

## 2. Under-block

- `paneAlive` is advisory/observational (tri-state, null on any doubt): a pane that dies BETWEEN the poll and the code submit still reaches the submit-time fail-closed capture check — the authoritative guard is unchanged and still refuses.
- The completion sweep runs on the 5-min reissue cadence: a short-circuited login can sit "signing in" up to ~5 min before flipping — bounded delay, not a miss (the submit-code 30s poll covers the code path).
- A zombie whose pane LOOKS alive (a different process reusing the same tmux session name) would be reused; the submit-time positive prompt check (`paste`+`code`, non-shell last line) still refuses typing into it. No issue identified beyond these.

## 3. Level-of-abstraction fit

- The identity decision stays where it already lives (the S7 gate in `EnrollmentWizard`/`AccountFollowMeEmailGate`) — the dashboard and routes only surface its verdict. No parallel identity check was added.
- Pane liveness lives server-side at the routes layer (the only place with tmux access), exposed as data; the client renders it. The client never infers liveness.
- The F9 rule lives in the shared dashboard module as exported primitives (not inlined per-handler) so other polling tabs can adopt it — the standard names this as the migration path.
- The completion sweep reuses the existing reissue timer and the existing completion chokepoint rather than adding a second lifecycle owner.

## 4. Signal vs authority compliance

Compliant. No new brittle check holds blocking authority: the F9 hold gates rendering timing only; `paneAlive` is a SIGNAL consumed for presentation and for the supersede decision whose failure direction is reuse (non-destructive); the pane-readiness refusal predicate is pre-existing (and was already reviewed as the FD13 fail-closed guard); the S7 email gate — the one true authority here — is untouched in logic. The supersede path's only destructive act (abandoning a pending record) requires an EXPLICIT `false` liveness verdict, and the record it abandons is by construction unusable (no pane to receive its code). Ref: `docs/signal-vs-authority.md`.

## 5. Interactions

- The reissue sweep can re-issue an expired login while a cell shows "expired": the next poll renders the fresh in-progress flow from server state — the transient expired presentation yields to live server truth (transient states sit BELOW in-progress in the model's precedence, except held/cant-resolve which are operator-terminal until retap).
- submit-code's in-flight mutex vs the completion sweep: `complete()` is single-winner (the store's terminal transition); the loser sees not-found and stands down. The upsert makes double-completion idempotent at the pool.
- The cancel relay (shipped feature) is preserved: the in-cell Cancel uses the same `data-matrix-cancel` handler/route; cancel-while-submitting still gets the existing 409 stand-aside.
- The matrix "Cancel" e2e (`matrix-cell-cancel-alive`) and the start-cell idempotency tests were re-run green; the reuse gate's new pane condition degrades to the old behavior when no sessionManager exists (tri-state null).
- Double-fire: `recordSubmitOutcome` is the single chokepoint for both submit surfaces (cell + panel), so an outcome lands once in transients/cards regardless of which surface drove it.

## 6. External surfaces

- API responses gain ADDITIVE fields only (`expectedEmail`/`ttlExpiresAt`/`notice`/`kind` on start-cell; `expected`/`got` on held; `email` on validated; `paneAlive` + self `machineNickname` on pending-logins; `code` on the two 409s; `reused` on enroll/start). All are operator-visible account emails / public flow metadata — never credentials. Old dashboards ignore unknown fields; old peers simply lack `paneAlive` (→ tri-state unknown downstream).
- Timing dependence: pane capture at read time (races documented in §2, all fail safe). No conversation-state dependence.

## 6b. Operator-surface quality

This change IS an operator-surface-quality fix (the whole point of the case study). Against the four questions: (1) **leads with the primary action** — every actionable cell leads with its one button (Set up / Sign in / Retry), and the in-flight cell leads with the step instruction + the Sign in link; the PIN stage adds an explicit Back so the operator is never trapped. (2) **Zero raw internals as primary content** — accounts render by EMAIL, machines by NICKNAME (a raw `m_<hex>` id is now suppressed rather than shown — the D5 wording floor, with `friendlyMachine` unit-tested); the only values the operator ever types are their PIN and the provider's own sign-in code (both existing patterns, memory-only, cleared after use); no JSON, fingerprints, or ids are shown or asked for. (3) **Destructive actions de-emphasized** — Cancel is a small secondary control under the flow, guarded by a native confirm; Back is client-side-only and destroys nothing. (4) **Plain language at phone width** — all new copy is jargon-free sentences ("The sign-in page must show X — if it shows a different account, tap 'Switch account' first"; "That code signed in X — this slot needs Y"), the failure/expiry/success states are color+glyph+sentence (not codes), and the flow stays inside one grid cell so the phone never needs the bottom of the page. Error copy only references affordances that exist on the surface it appears on (the "re-tap Approve" ghost-button wording is gone).

## 7. Multi-machine posture (Cross-Machine Coherence)

Proxied-on-read, matching the existing WS5.2 design: the pool-scope pending-logins fan-out inherits each peer's OWN `paneAlive`/nickname annotation (each machine answers for its own tmux — liveness is machine-local BY NATURE and never guessed cross-machine); the submit-code/cancel relays are unchanged; a LEGACY peer (pre-this-version) returns rows without `paneAlive` → rendered as the unknown state (submittable, exactly today's behavior) — mixed-version pools degrade to current behavior, never to a fabricated verdict. The enroll/start single-attempt check runs on the TARGET machine (the only place its pane exists). Client transients/episodes are per-dashboard-session by design (another dashboard sees server-truth states). URLs surfaced are the provider's own OAuth URLs — machine-boundary safe.

## 8. Rollback cost

Low. No config/schema/migration surface; no state format change (pending-login records unchanged — `paneAlive` is computed at read time, never stored). Revert = revert the PR. The one behavioral write-path change (upsert-on-validated, supersede-dead-pane abandon) only produces states the system already supports (active account; abandoned login). A hot-fix can also disable nothing selectively because nothing ships dark — this is a defect fix to an already-dev-gated feature (`multiMachine.accountFollowMe` gates every touched route; fleet installs keep 503ing exactly as before).

---

**Second-pass response:** not required (no new blocking authority; the touched gates keep their exact refusal sets — see Decision-point inventory).

## Follow-up (same PR): no-silent-fallbacks ratchet exemption

The D5 pane-liveness guard's `captureOutput` catch (`src/server/routes.ts`, follow-me submit-code route) sets `rawFrame = null` on capture failure, which the ratchet's `hasStateReset` heuristic counted as a new silent fallback (493 > 492 baseline, Unit shard 3/4 red). It is a refusal path, not a degradation — null flows to the explicit `pane-dead` 409 refusal (fails closed; the code is never blind-typed). Marked `@silent-fallback-ok` in place on the same line (no detection-window reshaping of neighboring catch blocks). Side effects: none — comment-only; behavior byte-identical.
