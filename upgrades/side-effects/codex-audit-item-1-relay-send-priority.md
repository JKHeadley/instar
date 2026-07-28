# Side-effects review — Codex-instar audit Item 1: relay-send caller priority

**Scope:** `/threadline/relay-send` endpoint now accepts a caller-supplied `priority` field on the request body, validates against `MessagePriority` (`'critical' | 'high' | 'medium' | 'low'`), rejects unknowns with 400, and defaults to `'medium'` only when omitted. The local-delivery envelope at routes.ts:12513 was hardcoded `'medium' as const` — that's gone; the resolved priority is used.

Discovered by codey during the 2026-05-22 Codex-instar shortcomings audit (audit file: `instar-codey/.instar/reports/codex-shortcomings-audit-2026-05-23.md`, blocker #1).

**Files touched:**
- `src/server/routes.ts` — destructure `priority` from req.body, add `ALLOWED_PRIORITIES` validation block with 400 on invalid input, use `resolvedPriority` in the local envelope construction.
- `tests/integration/threadline-relay-send-priority.test.ts` — new test file: 6 cases covering critical/high/low propagation, medium default, 400 on unknown string, 400 on non-string.

**Under-block:** None. The new validation block does not change the behavior of callers who already omit `priority` (they still get `medium`). Callers who supply a valid priority now get the priority they asked for instead of being silently downgraded.

**Over-block:** A caller who previously passed garbage in `priority` (or a non-string value) would have had their value silently ignored. Now they get a 400. This is a deliberate, narrow tightening — the validation message names the allowed enum so the caller can correct. No production caller in the instar tree currently sends `priority` to this endpoint, so the change is observable only to externally-authored clients that mis-typed it.

**Level-of-abstraction fit:** The validation lives in the route handler, alongside the existing `targetAgent` / `message` required-field check. Consistent with how the route already gates input. No new type or helper introduced — the existing `MessagePriority` import is reused.

**Signal vs authority compliance:** The caller's `priority` field is a SIGNAL — clamped to the `MessagePriority` enum (the AUTHORITY on what priorities exist). No new authority introduced; no signal promoted to authority without validation.

**Interactions:**
- Recipient's spawn-override policy can now see real caller-supplied priority on local-delivery traffic. The spawn-cap split-brain (Item 2) is a separate bug — Item 1 makes the priority observable; Item 2 makes the cap reload-aware.
- Remote-relay path (`sendAuto` via WebSocket) is unchanged. The relay envelope schema does not carry priority on the wire; extending it is a separate, deeper change. If a caller passes `priority` and the message ends up on the remote relay, the field is honored for the local-delivery probe but is not transmitted across the wire.
- `MessageRouter.ts:451` and other internal getAgentToken callers are unrelated; no functional change there.

**External surfaces:**
- `/threadline/relay-send` request schema: `priority` is now an accepted optional field. Documented in NEXT.md.
- No CLI change, no new config knob, no migration to agent-installed files.

**Migration parity:** No agent-installed file change (no scaffold template, no `.instar/config.json` default, no hook script, no CLAUDE.md section). Deployed agents pick up the fix on next `instar update` + server restart — same path as any code-only change. Note for upstream review: agents in the wild may have client-side helpers that wrap relay-send; they're unaffected unless they were already passing an invalid `priority` value, in which case they now get a 400 with a clear error message instead of a silent downgrade.

**Rollback cost:** Trivial. Revert one block of validation in `src/server/routes.ts`, restore the hardcoded `priority: 'medium' as const` on the envelope, delete the new test file. Single commit.

**Tests:**
- `tests/integration/threadline-relay-send-priority.test.ts`: 6 cases, all pass (verbose run captured at fix-build time).
- `tsc --noEmit`: clean.
- Empirical confirmation on codey codex-cli agent: 400 on invalid priority, validation passes on valid priority. Documented in `instar-codey/echo_chat.md` at 2026-05-23 07:08 UTC.

**Decision-point inventory:**
1. **Validate vs. silently coerce.** Validating with 400 surfaces caller mistakes immediately; silently coercing would let typos through (`"urgent" → "medium"`) — which is exactly the bug we're fixing on the server side. Validation chosen.
2. **Default at the route vs. at the envelope.** Defaulting at the route (one `resolvedPriority` variable, used at the envelope) keeps the envelope construction site purely structural. Future envelope refactors won't accidentally lose the priority handling.
3. **Local-only vs. extend to remote envelope.** The remote-relay envelope schema is a separate change — extending it touches the wire protocol and the recipient's relay daemon. Out of scope for Item 1; flagged in NEXT.md and the chat handoff so the operator can decide whether to scope a follow-up.
