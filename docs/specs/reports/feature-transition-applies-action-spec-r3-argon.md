# spec review round 3 — Gemini 4 Argon (gemini CLI), 2026-10-25

### 1. Verdict
**Ready.** All architectural, security, and code-level defects from rounds 1 and 2 have been cleanly resolved. Only two tiny doc/comment leftovers remain.

---

### 2. Factual errors against the code
1. **Leftover prerequisite claim in ELI16 (`docs/specs/feature-transition-applies-action.eli16.md` "What is new" item 3):** The ELI16 still states *"and a feature whose prerequisite is off is never called on"*, even though Spec §2.3 ("No prerequisite rule") and `src/core/FeatureRegistry.ts` (`getEffectiveState`) explicitly dropped the prerequisite check in round 2.
2. **Stale comment on `readMergedConfig()` (`src/core/FeatureRegistry.ts` above `readMergedConfig`):** The JSDoc comment says *"Merge config.json on disk over the given runtime config, the way bootstrap() does"*, while the implementation comment two lines below accurately notes *"Disk wins here (unlike boot)"*.

---

### 3. Security problems
* **Loopback request (`§2.1`):** None. The loopback client is locked to the accepted socket, the four allowlisted method/path pairs (`ALLOWED_FEATURE_ACTIONS`), static `FeatureDefinition` payloads, and no redirect following. All route-level gates (`PATCHABLE_CONFIG_KEYS`, `OPERATOR_ONLY_SESSION_KEYS`, CSRF header) remain in force.
* **Operator-session consent path (`§2.4`):** None. Distinguishing an omitted header (agent path) from a present-but-invalid header (`401 OPERATOR_PROOF_INVALID` prompting a single PIN re-unlock) and showing high-tier disclosures prior to toggling ensures genuine human consent without redundant PIN prompts.
* **Bearer-only caller reach (`§2.4`, `§2.7`):** Accurately documented in both the spec and ELI16. Exposing `GET`/`PATCH /api/files/config` when the file viewer starts disabled matches live-disable behavior and remains protected by Bearer auth, `X-Instar-Request: 1`, and path validation.

---

### 4. Honesty gaps in the shown state
None.
* `evolution-system` is now `switchable: false` (`409 FEATURE_NOT_SWITCHABLE`), preventing a cosmetic toggle over an ignored key, and reports `recorded: configured` with its `honestyNote`.
* `autonomous-evolution` resolves through `setConfiguredResolver` using the autonomy profile fallback, matching the runtime consumer.
* `readMergedConfig()` merges one level deep with disk precedence, and `resolveConfigValue()` properly falls back to `def.defaultOn` when a section object lacks a boolean `enabled`.
* `dashboard/index.html` always renders `effective.summary` on both the card and detail view, preserving post-reboot refusal explanations and honesty notes across all statuses.

---

### 5. Over-engineering to cut (Ranked Findings & Smallest Fixes)

1. **[Doc fix] Remove the dropped prerequisite clause from ELI16 (`docs/specs/feature-transition-applies-action.eli16.md`)**
   * *Why:* Round 2 dropped the prerequisite rule because `EvolutionManager` runs regardless of `evolution.enabled`, but ELI16 item 3 still claims *"and a feature whose prerequisite is off is never called on."*
   * *Smallest fix:* Delete `, and a feature whose prerequisite is off is never called on` from item 3 in `docs/specs/feature-transition-applies-action.eli16.md`.

2. **[Comment fix] Fix JSDoc on `readMergedConfig()` (`src/core/FeatureRegistry.ts`)**
   * *Why:* The JSDoc above `readMergedConfig()` still says *"the way bootstrap() does"*, contradicting the spec (§2.3) and the inline comment inside the function body.
   * *Smallest fix:* Change the JSDoc to *"Merge config.json on disk one level deep over the given runtime config (disk wins, unlike bootstrap)."*
