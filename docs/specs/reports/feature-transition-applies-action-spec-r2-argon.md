# spec review round 2 — Gemini 4 Argon (gemini CLI), 2026-10-25

### 1. Verdict
**Ready with changes.** Round 1's architectural and security concerns are cleanly resolved—the allowlist, per-feature serial queue, `createFileRoutes` guard, and consumer config alignment are all solid. However, three code-level bugs introduced in the round-2 edits (shallow config merge, dashboard summary suppression, and missing `defaultOn` when parent config objects exist) will break the "honest state" calculation in practice.

---

### 2. Factual errors against the code
1. **Shallow merge in `readMergedConfig()` clobbers nested runtime keys (`src/core/FeatureRegistry.ts:690`):** `return { ...runtimeConfig, ...rawConfig };` is a top-level shallow spread. If `runtimeConfig` has `{ dashboard: { port: 3000, fileViewer: { enabled: true } } }` and `rawConfig` (`config.json` on disk) has `{ dashboard: { port: 3000 } }`, `rawConfig.dashboard` completely overwrites `runtimeConfig.dashboard`. More importantly, if `runtimeConfig` has a default or nested sub-object and `rawConfig` has a sibling key under the same top-level key (`monitoring`, `dashboard`, `evolution`, `threadline`), the shallow spread wipes out the runtime sub-keys.
2. **Nested `defaultOn` fails when parent object exists with sibling keys (`src/core/FeatureRegistry.ts:716-733`):** `resolveConfigValue()` walks `def.configPath.split('.')`. For `publishing-telegraph` (`configPath: 'publishing'`, `defaultOn: true`), if `config.json` has `{ "publishing": { "telegraphToken": "abc" } }` (no `enabled` field), `current` resolves to `{ telegraphToken: "abc" }`. It is not `undefined` (line 721 skipped), has no `'enabled' in current` (line 727 skipped), is not boolean (line 732 skipped), and falls through to line 735 (`return current != null && typeof current === 'object'`), which happens to return `true`. **However**, if a feature with `defaultOn: false` (e.g., `response-review`, `feedback-system`, `dispatches`) has a config object with sibling settings like `{ "feedback": { "webhookUrl": "..." } }` and no `enabled` key, line 735 returns `true` even though `defaultOn` is falsy! Conversely, when `'enabled' in current` is checked on line 727, `{ publishing: { enabled: undefined } }` returns `false` instead of `def.defaultOn`.
3. **Dashboard `featEffectiveLine()` hides `lastAttempt` failures and `honestyNote` when status is `on` or `off` (`dashboard/index.html:9189`):** Spec §2.3 & §2.6 state that `effective.summary` appends the last failed attempt and `honestyNote` in *every* status, including `off` after a boot reset (`"Off. The last attempt to turn it on was refused: …"`), and §2.4 rule 3 says the card's sub-line shows `effective.summary` whenever it is not a plain on/off. In `dashboard/index.html:9189`, `if (!e || e.status === 'on' || e.status === 'off') return '';` suppresses the summary whenever `status` is `'on'` or `'off'`—even when `e.lastAttempt` failed or `evolution-system` has its `honestyNote`.

---

### 3. Security problems
* **Loopback client (`§2.1`):** Pinning `ALLOWED_FEATURE_ACTIONS` to the four exact method/path pairs, disallowing redirects, and sourcing actions strictly from static `FeatureDefinition`s completely closes the SSRF/target-spoofing surface.
* **Operator-session consent path (`§2.4`):** Requiring a valid `X-Instar-Operator-Session` (and prompting for PIN once if expired/absent after reload) while showing high-tier disclosures beforehand satisfies both consent integrity and the no-redundant-PIN rule.
* **Bearer-only reach (`§2.4`, `§2.7`):** Unchanged. Exposing `GET`/`PATCH /api/files/config` when the file viewer is disabled at boot matches the existing live-disabled behavior and still enforces Bearer + `X-Instar-Request: 1` + path validation.

---

### 4. Honesty gaps in the shown state
* **Hidden failure explanations and honesty notes on `on`/`off` cards (`dashboard/index.html:9189`):** Because `featEffectiveLine` checks `e.status === 'on' || e.status === 'off'`, two promised honesty disclosures vanish in the UI:
  1. After a refused enable and a server restart (`recorded: false, configured: false, atBoot: false` -> `status: 'off'`), the retained `lastApply` refusal explanation is never rendered.
  2. `evolution-system` when `on` (`status: 'on'`) never renders its `honestyNote` ("This agent currently runs the evolution system regardless of this setting.").
* **Prerequisite check uses single-hop `isConfigured` (`src/core/FeatureRegistry.ts:699`):** `getEffectiveState` checks `!this.isConfigured(id, mergedConfig)` for `prerequisiteFeatures`. That works for `autonomous-evolution -> evolution-system` because `evolution-system` is `defaultOn: true`, so disabling `evolution-system` (`evolution.enabled: false`) properly marks `autonomous-evolution` as `configured: false` with `"It needs Evolution System, which is off."`

---

### 5. Over-engineering to cut (Ranked Findings & Smallest Fixes)

1. **[Bug / Honesty] Render `featEffectiveLine` when `lastAttempt` failed or `honestyNote` is present (`dashboard/index.html:9189`)**
   * *Why:* Suppressing `featEffectiveLine` on `e.status === 'on' || e.status === 'off'` hides post-reboot refusal reasons (§2.6) and `honestyNote`s (§2.7).
   * *Smallest fix:* In `dashboard/index.html:9189`, only return `''` when `(e.status === 'on' || e.status === 'off') && (!e.lastAttempt || e.lastAttempt.outcome === 'applied') && e.summary === 'Off.'`. (Or simpler: show `e.summary` whenever `e.summary !== 'Off.' && !e.summary.startsWith('On (the setting was on when the agent started; running is not separately verified).')`, or check `hasFailedAttempt`).

2. **[Bug] Deep-merge one level in `readMergedConfig()` (`src/core/FeatureRegistry.ts:690`)**
   * *Why:* `PATCH /config` (`src/server/routes.ts:32225`) merges top-level objects one level deep (`fileConfig[key] = { ...fileConfig[key], ...value }`), and `LiveConfig.set('dashboard.fileViewer.enabled', ...)` writes nested keys into `config.json`. A shallow `{ ...runtimeConfig, ...rawConfig }` in `readMergedConfig()` clobbers sibling keys inside top-level config sections (`dashboard`, `monitoring`, `evolution`, `threadline`).
   * *Smallest fix:* Merge top-level plain objects one level deep in `readMergedConfig()` (matching `PATCH /config`), so disk keys override runtime keys without wiping sibling sub-objects.

3. **[Bug] Fix `resolveConfigValue()` for object paths with missing `.enabled` (`src/core/FeatureRegistry.ts:727-735`)**
   * *Why:* When `def.configPath` points to a section object (like `publishing`, `feedback`, `evolution`), if that object exists in config with other properties (e.g. `{ publishing: { telegraphToken: 'x' } }` or `{ feedback: { enabled: undefined } }`) but no boolean `enabled`, line 735 treats *any* non-null object as `true`—ignoring `def.defaultOn` (which is `false` for `feedback`, `responseReview`, `dispatches`).
   * *Smallest fix:* Replace lines 727-735 of `src/core/FeatureRegistry.ts` with:
     ```ts
     if (current != null && typeof current === 'object') {
       const enabled = (current as Record<string, unknown>).enabled;
       if (typeof enabled === 'boolean') return enabled;
       return def.defaultOn === true;
     }
     return typeof current === 'boolean' ? current : false;
     ```
