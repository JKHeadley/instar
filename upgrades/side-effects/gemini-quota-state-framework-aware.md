# Side-Effects Review — Gemini quota state framework awareness

**Version / slug:** `gemini-quota-state-framework-aware`
**Date:** `2026-06-04`
**Author:** `instar-codey`
**Second-pass reviewer:** `not required`

## Summary of the change

This change fixes the Gemini quota-state mismatch found during the Codey to Gemini mentorship loop. The server no longer starts the Claude-specific quota collector for non-Claude frameworks, so Gemini agents cannot write Anthropic usage into their own quota state. The Gemini CLI capacity policy now persists long CLI-reported capacity blocks into the existing quota-state file, with source/model/reset metadata, so the existing spawn gate sees the same block the Gemini CLI reported. The change touches server wiring, the intelligence provider factory, Gemini live/registry capacity handling, the shared quota state type, the Claude quota collector's source attribution, and focused unit/integration/E2E tests.

## Decision-point inventory

- Server quota collector startup — modify — framework-aware: Claude collector starts only for `claude-code`; Gemini/Codex skip until a native usage meter exists.
- Gemini capacity policy — modify — persists provider capacity deferrals into quota state as a stop recommendation.
- Quota spawn gate — pass-through — continues to consume `QuotaState`; this change feeds it a Gemini-authored stop-state instead of changing its authority logic.
- Intelligence source labeling — modify — reports Gemini CLI as Gemini CLI, not Claude CLI subscription.

---

## 1. Over-block

Gemini can now write `fiveHourPercent: 100` when the CLI reports a long reset window, which causes the existing quota gate to block low-priority spawns until the reset window passes. A false-positive Gemini CLI error parse could therefore pause Gemini work that might otherwise have succeeded. The parser already distinguishes short retryable capacity failures from long deferrals, and the persisted state is written only after the Gemini capacity classifier chooses `defer`.

---

## 2. Under-block

This does not implement a full native Gemini usage meter. If Gemini is near quota but has not yet produced a CLI capacity error, the quota file may still not forecast that future limit. It also does not parse every possible future Gemini/Antigravity wording; it persists the capacity signal only when the existing Gemini classifier recognizes the error as a long quota/capacity reset.

---

## 3. Level-of-abstraction fit

The change stays at the framework boundary. Claude usage collection remains in the Claude collector. Gemini capacity persistence happens in the Gemini adapter's capacity policy, where the live CLI error and selected model are available. The existing quota tracker remains the authority for spawn decisions; the Gemini policy produces a framework-specific signal in the format that authority already consumes.

---

## 4. Signal vs authority compliance

- [x] No — this change produces a signal consumed by an existing smart gate.

The only blocking authority remains the existing quota tracker/spawn gate. The Gemini adapter writes a provider-authored state snapshot when the CLI reports a long capacity block. The deterministic part is limited to translating that provider signal into existing quota-state fields; it does not introduce a parallel block/allow gate.

---

## 5. Interactions

- **Shadowing:** Skipping `QuotaCollector` for Gemini removes the previous Claude-specific writer. For Gemini, the new writer only fires after a live CLI capacity failure, so it does not shadow a native Gemini usage meter because none exists in this codebase.
- **Double-fire:** Claude agents still use the Anthropic collector. Gemini agents write quota state from the capacity policy. A future native Gemini usage meter will need to coordinate with this writer, but today's framework guard prevents Claude and Gemini writers from competing on the same agent.
- **Races:** The quota-state write is atomic via temp file plus rename. Write failures are logged and fail open so the original CLI quota error is preserved.
- **Feedback loops:** A persisted Gemini stop-state makes future scheduler/spawn checks stop earlier instead of repeatedly invoking the already-blocked CLI. The state is reset by the existing quota-state lifecycle after the configured window/next successful collection path.

---

## 6. External surfaces

Other agents see a quieter and more accurate quota state. Gemini-only agents no longer display Claude/Anthropic usage as their own quota. Persistent state gains optional metadata fields: source, model, blockedUntil, and blockReason. Existing readers tolerate optional fields because the required quota fields remain unchanged. The user-visible effect is that Gemini throttling should be reported as Gemini CLI capacity rather than as a misleading low usage percentage from another provider.

---

## 7. Rollback cost

Rollback is a normal code revert. Persisted Gemini quota-state files may retain the optional metadata fields after rollback, but existing code ignores unknown optional fields and still reads the required percentage/timestamp/recommendation values. If a bad persisted stop-state blocks Gemini after rollback, deleting or refreshing that agent's quota-state file clears it; no database migration is involved.

---

## Conclusion

The review kept authority in the existing quota gate and moved provider-specific observation to the provider boundary. The main residual gap is deliberate: this is not a complete Gemini usage meter, only correct attribution plus persistence of live CLI capacity blocks. Focused unit, integration, E2E, and typecheck coverage exercise the factory wiring, both Gemini capacity paths, persisted stop-state shape, and quota gate consumption.

---

## Second-pass review (if required)

**Reviewer:** not required
**Independent read of the artifact:** not required

Tier-2 implementation against the approved Gemini runtime-adapter spec; no separate second-pass reviewer was required for this scoped fix.

---

## Evidence pointers

- Focused Gemini capacity unit/integration/E2E tests passed.
- TypeScript typecheck passed.
- Additional quota-manager and quota-collection tests are run before push.
