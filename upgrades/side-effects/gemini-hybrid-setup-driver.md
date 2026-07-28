# Side-Effects Review — Gemini hybrid setup driver

**Version / slug:** `gemini-hybrid-setup-driver`
**Date:** `2026-06-02`
**Author:** `instar-codey`
**Second-pass reviewer:** `not required`

## Summary of the change

This change adds `src/commands/setup-wizard/gemini-driver.ts` and routes `framework === 'gemini-cli'` in `src/commands/setup.ts` to that driver instead of the Claude setup skill prompt. The Gemini driver mirrors the Codex hybrid wizard shape: Instar owns the state machine, prompts, answer validation, setup actions, config writes, and Telegram fallback; Gemini is called only for bounded one-shot narrative text. Tests cover driver invariants, setup dispatch, and the live Gemini one-shot narrative path when quota is available.

## Decision-point inventory

- `src/commands/setup.ts` wizard dispatch — modify — selects the Gemini hybrid driver for `gemini-cli` instead of the Claude skill spawn path.
- `src/commands/setup.ts` setup-wizard skill existence check — modify — checks for the Claude setup skill only on the Claude path, because hybrid drivers do not depend on that skill.
- `src/commands/setup-wizard/gemini-driver.ts` action dispatch — add — maps shared wizard action states to Instar-owned side effects for a Gemini setup.

---

## 1. Over-block

No block/allow surface in the security-gate sense. The main legitimate input this could reject is an environment where Gemini CLI is installed through an asdf shim but the active Node version cannot run the shim. The driver preserves `ASDF_NODEJS_VERSION` when already present and sets Gemini's documented headless trust env, but it does not guess or mutate the user's asdf configuration. In that case the wizard falls back to deterministic narrative text rather than blocking setup.

---

## 2. Under-block

This does not add Gemini browser automation or Gemini tool-use setup. That means it still misses a future richer flow where Gemini could safely use real read/search tools for context gathering. That is intentional for this slice: the observed failure was Gemini being asked to use nonexistent shell behavior, so the safe first fix is narrative-only Gemini plus Instar-owned side effects.

---

## 3. Level-of-abstraction fit

The change sits at the setup-driver layer, which is the right place because the failure is a framework-specific runtime contract mismatch. The shared state machine remains the higher-level source of wizard structure. The Gemini driver only adapts the narrative call and side-effect ownership for Gemini's actual CLI behavior; it does not fork the user-facing setup graph.

---

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [x] No — this change has no block/allow surface.

The setup dispatch is deterministic routing based on the user-selected framework. It does not create a brittle detector with blocking authority. The only failure classification added in tests is quota-aware E2E handling, and that is a test availability distinction rather than runtime authority over user messages or agent behavior.

---

## 5. Interactions

- **Shadowing:** The Gemini branch now returns before the Claude skill spawn path. This deliberately shadows the old Gemini one-shot skill prompt, which was the broken behavior.
- **Double-fire:** No double-fire expected. Only one wizard driver runs for a selected framework.
- **Races:** No shared mutable runtime state is introduced. Existing setup actions still perform their normal file writes and server start steps.
- **Feedback loops:** The Gemini narrative call can fail because of auth, trust, or quota. The driver treats that as narrative unavailable and prints fallback text, so setup progress does not depend on model availability.

---

## 6. External surfaces

This is visible to anyone running `instar setup --framework gemini-cli`: they now get the code-owned hybrid wizard instead of a Gemini prompt to read Claude setup instructions. It changes no persistent schema. It can write the same project config that the existing setup wizard writes. It depends on Gemini CLI availability only for optional narrative; setup side effects remain available when Gemini narrative is unavailable.

---

## 7. Rollback cost

Rollback is a hot-fix code revert: remove the Gemini dispatch branch and driver, revert the model constant and tests, and regenerate the manifest. No data migration is required. Agents created through the new path remain ordinary `gemini-cli` agents; rollback would only affect future setup runs.

---

## Conclusion

The review supports shipping this as the Gemini setup keystone slice. It removes the Claude-skill fallthrough, keeps all side effects in Instar code, and adds tests that pin the exact boundary. The main operational concern is Gemini CLI quota/trust/asdf availability for live one-shots; the driver degrades to fallback narrative and the E2E reports quota as external unavailability.

---

## Second-pass review (if required)

**Reviewer:** `not required`
**Independent read of the artifact:** `not required`

This change does not add a guard, sentinel, coherence gate, outbound-message blocker, restart path, or lifecycle killer. It modifies setup framework dispatch and adds a bounded driver.

---

## Evidence pointers

- `npm run build`
- `npx vitest run tests/unit/setup-gemini-driver.test.ts tests/integration/setup-gemini-dispatch.test.ts tests/e2e/gemini-setup-narrative-lifecycle.test.ts`
- Live Gemini E2E reached the real CLI but reported quota exhausted for `gemini-2.5-flash` during this run.
