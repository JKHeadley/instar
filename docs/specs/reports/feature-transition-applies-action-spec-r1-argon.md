# spec review round 1 — Gemini 4 Argon (gemini CLI), 2026-10-25

### 1. Verdict
**Ready with changes.** The core diagnosis and fix are sound, but the loopback HTTP design, SQLite schema migration, and retry route add unnecessary moving parts, and two code-level traps (`createFileRoutes` live activation and `bootstrap()` merge order) will skew the "honest state" calculation if not addressed carefully.

---

### 2. Factual errors against the code
1. **`bootstrap()` config precedence (`src/core/FeatureRegistry.ts:624` vs Spec §2.3):** Spec §2.3 states `configured` is computed from `"config.json on disk merged over runtime config, as bootstrap does"`. In `FeatureRegistry.ts:624`, `const mergedConfig = { ...rawConfig, ...config };` actually merges `config` (the runtime config passed in) *over* `rawConfig` (`config.json` on disk), Despite the misleading comment on line 623. If `effective.configured` copies `bootstrap()`'s merge order or if `PATCH /api/files/config` updates disk without updating `ctx.config`, runtime keys can mask disk keys.
2. **File viewer behavior when off at boot (`src/server/fileRoutes.ts:514-521` vs Spec §2.7):** Spec §2.7 proposes mounting *only* `GET`/`PATCH /api/files/config` when off at boot so other file routes stay unmounted until restart. However, `fileRoutes.ts:517-520` already has a live gate (`router.use('/api/files', ...)` returning 404 when `!config.enabled && req.path !== '/config'`). Simply removing `if (!config.enabled) return router;` at line 514 already exposes only `/api/files/config` while disabled AND makes enabling the file viewer take effect immediately without a restart.

---

### 3. Security problems
* **Loopback SSRF / header spoofing surface (§2.1):** Using `req.socket.localAddress` / `localPort` with the server's `Authorization: Bearer <config.authToken>` over a network socket is safe *only* because `action.path` comes from static `FeatureDefinition`s and is validated to start with `/`. Still, constructing a raw loopback HTTP client that mints Bearer + CSRF headers (`X-Instar-Request: 1`) is avoidable privilege-bearing plumbing.
* **Operator-session consent bypass (§2.4):** Allowing a valid `X-Instar-Operator-Session` (recent PIN unlock) to satisfy `consentRecord` and `activationChallenge` is sound. The operator flipping the switch *is* the human principal; requiring an agent-mediated challenge when the human is directly at the dashboard is pure friction.
* **Bearer-only caller reach (§2.4):** No new privilege is gained. A Bearer caller still cannot bypass `CONSENT_REQUIRED` or `ACTIVATION_CHALLENGE_REQUIRED`, and any action triggered by `transition()` (`PATCH /config`, `PATCH /api/files/config`, `POST /telemetry/*`) was already directly callable by a Bearer holder.

---

### 4. Honesty gaps in the shown state
* **Prerequisite blindness for `autonomous-evolution` (`src/core/FeatureDefinitions.ts:212`):** `autonomous-evolution` sets `evolution.autoImplement: true` and has `prerequisiteFeatures: ['evolution-system']`. If `evolution-system` (`evolution.enabled`) is `false`, flipping `autonomous-evolution` on sets `evolution.autoImplement: true` in config, so `effective.configured` becomes `true` and after restart `effective.status` reports `"on"` ("On and running"), even though the evolution subsystem is completely disabled.
* **File viewer reported as `"on-after-restart"` when it is actually live (`src/server/fileRoutes.ts:517`):** If you remove the early return at `fileRoutes.ts:514` instead of building a separate half-mounted router, `PATCH /api/files/config { enabled: true }` turns the file viewer on immediately, making `"Saved as on; it may not start until the next restart"` inaccurate (though acceptable under the spec's conservative "may" wording).

---

### 5. Over-engineering to cut (Ranked Findings & Smallest Fixes)

1. **[Cut] Drop the `POST /features/:id/apply` retry route (§2.1)**
   * *Why:* If an operator's switch apply is refused or fails, clicking the toggle again in the UI (or sending `POST /features/:id/transition` with `{ to: 'enabled' }` via `operatorSet`, which allows transitioning from *any* state including `enabled -> enabled`) already re-runs the apply action. A dedicated `/apply` endpoint and UI retry plumbing is dead weight for a rare edge case.
   * *Smallest fix:* Allow `operatorSet` (and `transition` when `current.discoveryState === to`) to be idempotent for `enabled`/`disabled` so re-toggling retries the action. Delete `POST /features/:id/apply`.

2. **[Cut] Drop SQLite schema v5 migration (`last_apply_json`, `last_apply_at`) (§2.2)**
   * *Why:* `POST /features/:id/transition` already returns `apply: FeatureApplyResult` synchronously to the caller, and `effective` computes live truth (`recorded` vs `configured` vs `atBoot`) on every `GET /features`. Persisting `lastApply` in SQLite just to decorate the `recorded-only` summary string across restarts is 20% value for 80% schema/migration/serialization ceremony, especially when `bootstrap()` resets `recorded` (`enabled: false`) on the next boot anyway (§2.6).
   * *Smallest fix:* Return `apply` in the `POST /features/:id/transition` response and log it to `discovery-events.jsonl`, or keep `lastApply` in an in-memory `Map<featureId, FeatureApplyResult>` alongside `bootValues`. Keep `SCHEMA_VERSION = '4'`.

3. **[Simplify] Remove line 514 in `src/server/fileRoutes.ts` instead of branching router mounting (§2.7)**
   * *Why:* `fileRoutes.ts:517-520` already blocks all routes except `/config` with 404 whenever `!config.enabled`. Mounting a special config-only router when off at boot duplicates the middleware that is literally 3 lines below it.
   * *Smallest fix:* Delete `if (!config.enabled) return router;` at `src/server/fileRoutes.ts:514`. The existing middleware on lines 517-520 handles the rest.

4. **[Fix] Fix config merge order in `configured` / `bootstrap()` (`src/core/FeatureRegistry.ts:624`, §2.3)**
   * *Why:* `const mergedConfig = { ...rawConfig, ...config };` lets stale top-level objects in runtime `config` overwrite `rawConfig` (`config.json` on disk) if a route updated disk via `LiveConfig` (`PATCH /api/files/config`) without mutating `ctx.config`.
   * *Smallest fix:* When computing `configured` (and in `bootstrap()`), read `config.json` on disk over runtime defaults: `{ ...config, ...rawConfig }`.

5. **[Fix] Check `prerequisiteFeatures` in `effective` calculation (§2.3)**
   * *Why:* `autonomous-evolution` cannot run if `evolution-system` is off, even if `evolution.autoImplement` is `true` in `config.json`.
   * *Smallest fix:* In `effective.configured`, require all `def.prerequisiteFeatures` to also be `configured === true`.

6. **[Simplify] Trim `effective.status` from 6 states to 4 (§2.3)**
   * *Why:* Distinguishing `recorded-only` / `not-recorded` from `on-after-restart` / `off-after-restart` in consumers is noisy when `summary` already carries the human sentence.
   * *Smallest fix:* Keep `recorded`, `configured`, `atBoot`, and `summary`, and collapse `status` to `'on' | 'off' | 'pending-restart' | 'mismatch'` (where `mismatch` covers `recorded !== configured`).
