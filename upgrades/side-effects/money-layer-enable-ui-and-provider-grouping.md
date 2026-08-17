# Side-Effects Review — the money-layer ON switch gets a screen, and the subscriptions grid groups by provider

**Version / slug:** `money-layer-enable-ui-and-provider-grouping`
**Date:** `2026-08-17`
**Author:** `echo`
**Second-pass reviewer:** `not required` (see §Second-pass — no block/allow surface is added; every authority stays server-side and unchanged)

## Summary of the change

Two dashboard-only changes, on disjoint surfaces, both from one operator report: *"I need TWO THINGS: 1) the ability to enable doors and set a spend cap on the dashboard, 2) the Subscriptions page to clearly group/distinguish different providers."*

**(1) The money-layer ON switch (Phase 2 of `docs/specs/money-layer-operator-enable-surface.md`).** Phase 1 (#1916) shipped six pre-gate routes and **no screen**. The arming controls next to them are gated on the very switch those routes turn on, so with the layer off the whole Spend tab could only 503 and the operator's original complaint — *"still has no path/mechanism to enable any options"* — survived its own fix. This adds `dashboard/money-layer-enable.js` (pure state→copy functions + renderers) and its controller in `dashboard/index.html`: read status → plan (Bearer, no PIN) → the server's rendered words shown verbatim → PIN commit → restart step (nonce → verbatim confirmation → sha256 of the DISPLAYED text → restart) → poll until the status itself reports enforcing.

**(2) Provider grouping in the account×machine grid.** `renderAccounts` (the cards) already grouped by provider; `renderAccountMatrix` (the grid the operator actually reads) did not — seven rows of account names with nothing telling Claude from Codex. `buildMatrixModel` now carries each account's `provider` and the grid renders a provider band, reusing `groupAccountsByProvider` so both surfaces obey the same two rules (first-appearance order, and **no** band at all on a single-provider install).

**(3) Two defects in the arming panel the switch unlocks, found by driving it.** With the switch working, the panel behind it was driven end to end on a throwaway agent — and *arming a door*, which is half of what the operator asked for, did not work. The panel posted **every** rendered plan to `/routing-spend/caps/adjust`; the server has one commit route per action and each refuses a plan signed for a different one, so "Preview go live" rendered correctly, took the operator's PIN, and answered 400. Setting a cap was the one action that happened to match. Fixed at the cause: `/routing-spend/plan` now returns the plan's `action`, and `commitRoute(plan)` derives the route from what was **rendered** rather than from the button pressed. Separately, **Freeze** (always offered, no PIN) had no reverse on the screen — an operator could halt a door from the dashboard and have nowhere to resume it. Unfreeze is now a button, PIN-gated, and says so client-side when a door is not frozen instead of posting a plan the server would refuse.

Files: `dashboard/money-layer-enable.js` (new), `dashboard/index.html`, `dashboard/spend-arming.js`, `dashboard/subscriptions.js`, `src/server/routes.ts` (the additive `action` field on the three arming plan responses), `src/core/PostUpdateMigrator.ts` (CLAUDE.md awareness + migration), plus four test files.

## Decision-point inventory

- `MoneyLayerEnableSurface.commit` / `.acceptRestart` (server) — **pass-through** — the PIN gate, the plan binding, the nonce and the confirmation-hash check are untouched; the client only supplies what they already required.
- `RenderedPlanStore` plan binding — **pass-through** — the commit sends `{planId, nonce, pin}` only. No form field can reach the applied action.
- `groupAccountsByProvider` (client, presentation) — **pass-through** — reused unchanged; the new `groupMatrixRowsByProvider` wraps it rather than re-deriving grouping rules.
- `commitMoneyPlan`'s per-route action check (server) — **pass-through** — unchanged; it was doing its job correctly and is what caught the client's wrong route. The client now names the right route instead of relying on the refusal.
- `POST /routing-spend/plan` response (server) — **modify, additive only** — gains an `action` field. No gate, validation or applied behavior changes; it stops the client from having to guess.
- No new server-side decision point is added. No gate, sentinel or authority changes behavior.

---

## 1. Over-block

**What legitimate inputs does this change reject that it shouldn't?**

No block/allow surface is added — every refusal comes from server routes that already existed. Two client-side refusals are worth naming because they *withhold an action* even though they are not authority:

- `sha256Hex` throws when `crypto.subtle` is absent, so the restart step refuses on a page served over plain `http://<LAN-IP>`. That legitimately blocks a legitimate operator on a legitimate page. It is the correct direction: the alternative is sending a restart request whose confirmation hash cannot be computed, which the server would reject anyway — but with a confusing error instead of an actionable one. The message names the remedy (open the https/tunnel link, or use localhost). Dashboard traffic normally arrives over the Cloudflare tunnel (https) or localhost, so the common paths are unaffected.
- `availableActions` renders no turn-off button when the store flag is false. An operator whose layer is enabled *only* by the config file therefore sees "Also record it here", not "Turn off" — matching the server, which would render the store-only variant whose own first line says it will not stop spending. Freeze remains reachable in the arming panel below, and the config notice points at it.

---

## 2. Under-block

**What failure modes does this still miss?**

- **The page cannot verify the machine it is talking to is the one the operator means.** On a multi-machine pool the dashboard is fronted by one machine and the money layer is single-writer; the panel prints the machine nickname from the status payload so the operator can see it, but a mis-fronted dashboard is not detected here. Server-side, plan rendering already requires the single-instance lock and the commit re-checks the render-time machine, so the failure is refused rather than mis-applied — the gap is only that the client cannot pre-empt it.
- **A restart that never comes back is reported honestly but not diagnosed.** After 20 polls (~60s) the panel says the server has not come back and to refresh — it does not distinguish "still restarting" from "failed to boot". The reap/lifeline surfaces own that; duplicating it here would be a second, dumber diagnosis.
- **Disarming a door is still API-only.** The panel offers arm, freeze and unfreeze; `enabled: false` (disarm) is reachable via `POST /routing-spend/plan` but has no button. The operator's stop control is freeze, which is instant, needs no PIN, and now has its reverse on the same screen — so no state is reachable from the dashboard that cannot be left from the dashboard.
- **Provider grouping cannot classify what the wire never carried.** A row that reaches the grid only via a pending login or an email-gap has no provider and lands under "Other". That is the honest outcome; inferring a provider from an account id would guess, and the guess would be wrong precisely on the unfamiliar accounts the operator is trying to tell apart.

---

## 3. Level-of-abstraction fit

This is the **presentation** layer and nothing else. Every authority stays where the spec put it: the PIN gate, the plan binding, the single-instance lock, the nonce TTL and the confirmation-hash binding are all server-side and unmodified. The client's only jobs are to display the server's words verbatim, collect the PIN for a single call, and read status.

Two deliberate re-uses instead of re-implementations: the grid grouping calls `groupAccountsByProvider` (so the "no band on a single-provider install" rule cannot drift between the two surfaces), and the enable panel reuses the `spend-arm-*` styling and note conventions already established by the arming controls, so the two halves of the Spend tab read as one screen.

The one piece of logic that is genuinely new and load-bearing is `nextStepAfterCommit`, which decides what the operator must do next. It is a pure function with its own tests — and writing those tests found a real bug: checking `enforcementReady` first reported a store-only disable under a config enable as "done", which is exactly the *"I disabled it and it is still on"* reading the whole surface exists to make legible. What the operator DID is now decided before what the layer currently IS.

---

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [x] No — this change has no block/allow surface.

The client renders state and forwards an operator-supplied PIN to routes that already hold the authority. It cannot enable, disable, restart or arm anything on its own: every mutating call is refused without a valid PIN (verified live — see Evidence), and the commit derives its action solely from the server-rendered plan. A client that could decide any of this would be the defect; this one can only ask.

---

## 4b. Judgment-point check (Judgment Within Floors standard)

No new static heuristic at a competing-signals decision point. The three new pure functions (`enableHeadline`, `availableActions`, `nextStepAfterCommit`) map an **enumerable** server-declared state — the five `lifecycleState` values × the four `enableSources.state` values × `enforcementReady` — onto operator copy. The domain is closed and declared by the spec's own state table, so it is an invariant to render, not a judgment to make. Where the signals could genuinely conflict (a disable that did not stop spending), the resolution is not a heuristic: it defers to the server's own `message` and keeps freeze in view.

---

## 5. Interactions

- **Shadowing:** `loadMoneyLayerEnable()` is called at the TOP of `loadRoutingSpend()`, before the gated `/routing-spend/summary` + `/caps` fetches, which early-return on their own 503. Rendering the switch after them would have deleted the one control that fixes a 503 exactly when the 503 happens. A test pins the order (`dashboard-moneyLayerEnableWiring.test.ts`), because a later edit could re-order it invisibly.
- **Double-fire:** the enable panel and the arming panel both read caps-adjacent state but write through different routes; neither triggers the other. `mlePollAfterRestart` calls `loadRoutingSpend()` exactly once, on the transition to enforcing — not per poll.
- **Races:** `__mlePendingPlan` / `__mlePendingRestart` are cleared on every re-render, so a PIN can never be applied to an approval the operator has since navigated away from. A stale plan is additionally refused server-side (TTL + single-use nonce).
- **Feedback loops:** the post-restart poll is bounded at 20 attempts × 3s and stops on either success or exhaustion; it cannot become a background poller. It is client-side and dies with the tab.
- **The grid grouping** touches only row ORDER and adds header rows. Cell state, the `data-cell-key` identity used by the targeted merge update, the interaction-hold rule and the delegated tap handler (which keys off `data-matrix-setup`, not row position) are unchanged — the existing 73-test suite for that file passes untouched.

---

## 6. External surfaces

- **Other agents / users:** none. No route, payload or protocol changes.
- **External systems:** none. No new network call leaves the machine; every fetch is to the local server.
- **Persistent state:** none written by the client. A plan render appends one audit row server-side, which is the existing, intended behavior of that route.
- **Timing:** the post-restart poll depends on the server coming back; it reports honestly when it does not.
- **Operator surface (Mobile-Complete):** this change IS the Mobile-Complete fix. Before it, `money-layer-enable` was a PIN-gated action with no human surface — the exact shape the standard names as an incomplete feature. Every action it adds is completable from a phone: the state, the button, the server's approval wording, the PIN field and the restart step are all in the Spend tab, reachable at the dashboard URL with the operator's PIN.

---

## 6b. Operator-surface quality (Operator-Surface Quality standard)

1. **Leads with the primary action?** Yes. The switch is the FIRST block in the Spend tab, above the read-only spend view and the arming controls, and it renders open — the state sentence and its button are visible on arrival, never behind a toggle. Before this change the operator arrived at a tab whose every control answered 503.
2. **Zero raw internals as primary content?** Yes. No lifecycle enum value, planId, nonce or hash is ever rendered — a test asserts `probed` / `enable-pending-restart` / `construction-failed` never reach the operator's copy. The headline is a sentence ("Spending controls are off"), and the only identifier shown is the machine's nickname, in muted support type. The one raw-looking string that does appear — `failingComponent` — is deliberate: when the layer refuses, naming the part that refused is the difference between an actionable report and "something went wrong".
3. **Destructive actions de-emphasized?** Yes. "Turn off" is rendered only when it is genuinely available, in the same muted button style as the others, after the constructive action; nothing in this panel is styled as a primary destructive control. The genuinely destructive control on this tab (freeze) lives below and is unchanged — and the config notice deliberately POINTS to it, because in that one state freeze is the only thing that actually stops money.
4. **Plain language + phone width?** Yes. The copy is sentences a non-engineer would say ("Switched on — waiting for a restart to take effect"), the PIN row and buttons stack full-width with 44px touch targets at ≤520px (reusing the arming panel's mobile-first rules), the plan text wraps (`white-space: pre-wrap; word-break: break-word`) rather than scrolling horizontally, and the PIN input is 16px so iOS does not zoom the page on focus. A wiring test asserts every class the module writes has CSS on the page, so the panel cannot ship unstyled.

For the subscriptions grid: the band is a single uppercase word in muted support type spanning the row — it adds a label, changes no control, and disappears entirely on a single-provider install.

---

## 7. Multi-machine posture (Cross-Machine Coherence)

**machine-local BY DESIGN, and correctly so.** The money layer is deliberately single-writer and single-machine until Increment D — the cap ledger is a single-writer store and the spec states paid routing stays single-machine. The switch therefore governs the machine whose server answers the dashboard, and the panel says so by printing that machine's nickname from the status payload. Plan rendering requires the single-instance lock and the commit re-checks the render-time machineId, so an approval rendered on one machine cannot be applied on another — the client inherits that property rather than re-deriving it.

The subscriptions grid is the opposite posture and already correct: **proxied-on-read** via `/subscription-pool?scope=pool`, which is what makes it an account×machine grid at all. The grouping change carries `provider` through that same merged read, and the "same account seen on a second machine keeps its provider" case is pinned by a test — without it, the second machine's row would have blanked the provider and dropped the account into "Other" on exactly the multi-machine installs this grid exists for.

- **User-facing notices?** None. No message, attention item or notification is emitted; nothing needs one-voice gating.
- **Durable state stranding on topic transfer?** None. The client holds no durable state; the pending plan lives in a page variable and dies with the tab.
- **URLs that must survive machine boundaries?** None generated. The panel is reached at the existing dashboard URL, which already survives via the pool-stable link path.

---

## 8. Rollback cost

- **Hot-fix release:** revert and ship a patch. The change is additive presentation — reverting restores the previous Spend tab (switch invisible again, curl-only) and the previous flat grid.
- **Data migration:** none. The client writes no persistent state. If an operator enabled the layer through the new panel before a revert, that enable lives in the server's own store exactly as it would from a curl and is unaffected by removing the screen.
- **Agent state repair:** none. The CLAUDE.md awareness bullet is additive and idempotent (content-sniffed, anchored insert); a revert leaves a stale-but-harmless bullet describing a screen that is temporarily gone.
- **User visibility:** during the rollback window the operator loses the button and is back to where they were this morning — no broken state, no half-applied action.

---

## Conclusion

The review found no design change to make, and driving the result found three real defects — two of them in code this change did not write.

The order matters: the unit tests were green on the arming panel, and stayed green, because none of them knew a second commit route existed. Only driving the panel as an operator — turn on, restart, set a cap, arm the door — surfaced the 400. Had this PR shipped the switch alone, it would have handed the operator a working cap control and a broken door control, on the exact request that asked for both.

It also found one real bug in the new code, caught by writing the tests rather than by reading the code: `nextStepAfterCommit` reported a store-only disable under a config enable as "done" because it checked `enforcementReady` before checking what the operator's action actually did. That is the precise misreading the whole enable surface exists to prevent, reproduced in the one function whose job was to prevent it — fixed, with the ordering and its reason recorded in a comment, and pinned by a test.

The load-bearing structural decision is the load order: the switch renders before the gated fetches, so the control that fixes a 503 does not vanish inside one. That is pinned by a test rather than by a comment, because the previous version of this exact lesson — a PIN-gated route with no human surface — shipped fully specced, fully tested and unreachable for a week.

Clear to ship.

---

## Second-pass review (if required)

**Reviewer:** not required.

Phase 5 requires an independent reviewer for changes touching block/allow decisions, session lifecycle, coherence/trust gates, or anything named sentinel/guard/gate/watchdog. This change adds none of those: it is a client-side renderer over unmodified server authority, and §4 records the "no block/allow surface" checkbox. The one lifecycle-adjacent action it can trigger — the server restart — is not a decision this code makes; it forwards an operator PIN to a route that mints its own nonce, binds its own confirmation text and records the request before acting.

---

## Evidence pointers

Live verification against the running agent server on this machine (v1.3.1176, money layer `disabled`), driving the real routes with the real module:

- `GET /routing-spend/enable-status` → `lifecycleState: "disabled"`, `enforcementReady: false` → panel renders **"Spending controls are off"** with one button, `money-layer-enable` / "Turn on spending controls".
- `POST /routing-spend/plan-money-layer` → **200**, server text: *"Turn ON the spending-control layer on machine 'single-machine'. This records your decision and the layer comes up on the next server restart — it is NOT enforcing yet, and this restarts nothing now. It arms NO paid service: every door stays refused with $0 committed until you separately arm it with your PIN."*
- The approval box's rendered text is **byte-identical** to the server's `renderedText` (asserted, not eyeballed).
- `POST /routing-spend/money-layer/commit` with a wrong PIN → **401 `bad-pin`**, and a re-read of `enable-status` shows the state **unchanged**.

**The whole operator loop, driven on a throwaway agent against a real server** (fresh `instar init`, its own PIN, the built dist), using the shipped dashboard modules — the same code the browser runs:

| step | result |
|---|---|
| arming panel while the layer is OFF | `503` → the panel's honest "this is your switch" copy, not a generic error |
| plan → wrong PIN → right PIN | `200` → `401 bad-pin` → `200` *"enabled — the money layer comes up on the next server restart; it is not enforcing yet"* |
| the panel's next step | `restart` (not "done"), headline *"Switched on — waiting for a restart to take effect"* |
| restart nonce → wrong hash → right hash | `200` → `409 confirmation-hash-mismatch` → `200 accepted` |
| after the restart | `lifecycleState: "probed"`, `enforcementReady: true` → headline *"Spending controls are up and enforcing"* |
| set a cap ($100 lifetime / $3 daily) | wrong PIN `403` → right PIN `200` → caps read back `$100` / `$3` |
| arm the door | **before the fix `400`; after the fix `200`**, `goLiveState: live` |
| freeze (no PIN) | `200` → *"Frozen — spending is halted"* |
| unfreeze (PIN) | wrong PIN `403` → right PIN `200` → *"Live — this door can spend"* |

One finding worth recording from that run: on an agent where the Increment-A spend view is dark, the enable resolves to `construction-failed` with `failingComponent: money-layer-init:routing-price-authority-absent`. The panel reports that honestly and names the component rather than showing a green light.

Tests: `tests/unit/money-layer-enable-ui.test.ts` (30), `tests/unit/dashboard-moneyLayerEnableWiring.test.ts` (18), `tests/unit/spend-arming.test.ts` (37, incl. 8 new), `tests/unit/subscriptions-render.test.ts` (73, incl. 7 new). Mutation-checked: reverting the grid grouping fails exactly 3 of the new tests and nothing else; reverting the `nextStepAfterCommit` ordering fails exactly the test that found it. The pre-existing wiring test that pinned the literal caps route was **pinning the defect** — it now asserts the route is derived from the plan.

---

## Class-Closure Declaration (display-only mirror)

No agent-authored-artifact defect — not applicable.

The `unbounded-self-action` class also does not apply: the one self-triggered loop added (`mlePollAfterRestart`) is client-side, operator-initiated, bounded at 20 attempts × 3s with a terminal message on exhaustion, and terminates on success. It fires no restart, swap, respawn, spawn, notify, retry or kill of its own — it re-reads a status route and stops.
