# Side-Effects Review — POST /sessions/refresh answers target refusals before the 202 (EVO-025)

**Version / slug:** `sessions-refresh-prebind`
**Date:** `2026-09-24`
**Author:** `Echo`
**Second-pass reviewer:** `independent reviewer subagent (required: session lifecycle)`

## Summary of the change

`POST /sessions/refresh` returned 202 "Refresh scheduled" and only 500ms later called `SessionRefresh.refreshSession()`; target refusals (`not_telegram_bound`, `session_not_found`, `refresh_in_progress`, `rate_limited`, `slack_respawner_unwired`) reached only `console.warn`. A caller passing a display name ("Jev") instead of the tmux name ("echo-jev") was told the restart was scheduled when it was refused. The detect phase of `refreshSession()` is extracted verbatim into a private `resolveTarget()`; a new read-only `precheckRefusal(sessionName)` runs `resolveTarget()` plus the in-flight check plus a non-recording rate-limit check. The route calls it before the existing busy precheck and answers a refusal synchronously (409 with `{code, error}`; 429 for `rate_limited`). The `not_telegram_bound` and `session_not_found` messages gain a display-name hint naming the matching running session's `tmuxSession`. Files: `src/core/SessionRefresh.ts`, `src/server/routes.ts`, `tests/unit/SessionRefresh.test.ts`, `tests/unit/sessions-refresh-route.test.ts`.

## Decision-point inventory

- `POST /sessions/refresh` admission — modify — target refusals are now answered pre-202 instead of post-202 in the log.
- `SessionRefresh.refreshSession` detect phase — pass-through — same checks, same order, same refusal codes (the not_telegram_bound / session_not_found messages gain the display-name hint, which also reaches the post-202 log line); moved into `resolveTarget()` and shared.
- `SessionRefresh.precheckRefusal` — add — read-only early answer; never kills, records, or respawns.

---

## 1. Over-block

The early check refuses only when `refreshSession()` itself would refuse with the same code at that moment, using the same lookups. A binding that is registered in the ≤500ms between the precheck and the scheduled call used to succeed and is now refused (the caller can retry immediately); this window is negligible and the caller now learns the result. No legitimate request that would have been refreshed is refused for any other reason. The work gate is not duplicated here (it has its own precheck), so `force:true` behaviour is unchanged.

---

## 2. Under-block

A refusal that arises only after the 202 (binding removed or the session exiting in the 500ms window, a work-gate verdict change, a respawner failure) is still reported only in the log — `refreshSession()` re-runs every check authoritatively, so this is a reporting gap, not a safety gap. The self-refresh case (the caller is the session being killed) still needs the 202-before-kill ordering and keeps it.

---

## 3. Level-of-abstraction fit

Correct layer: the orchestrator owns the lookup logic and exposes it once; the route only translates a refusal to an HTTP status. No lookup is re-implemented in the route (unlike `restart-all`, which inlines the Telegram lookup). The display-name hint lives in the orchestrator next to the state lookup it depends on.

---

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [x] No — this change has no new block/allow surface.

The refusals are the orchestrator's existing deterministic refusals (binding existence, session existence, in-flight, rate cap) — structural invariants, not judgment. The change moves when the caller hears them; it grants no new authority and removes none. The display-name case is deliberately a hint, never a remap.

---

## 4b. Judgment-point check (Judgment Within Floors standard)

No new static heuristic at a competing-signals decision point. The checks are enumerable invariants (is there a binding, is there a running session with this tmux name, is a refresh in flight, is the fixed rate cap reached).

---

## 5. Interactions

- **Shadowing:** the new precheck runs before the busy precheck. For an unbound name the caller now gets 409 `not_telegram_bound` instead of a busy verdict — correct, since the refresh could not run anyway. Likewise a session that is both busy and out of rate budget now gets 429 `rate_limited` where it used to get 409 `session-busy`; both are correct refusals. The busy precheck and post-202 authoritative path are unchanged.
- **Double-fire:** none — the precheck performs no action.
- **Races:** `precheckRefusal` reads `inFlight` and the rate window without writing (the rate check's opportunistic prune of expired timestamps is idempotent and already happens on every refresh). Test proves repeated prechecks consume no budget.
- **Feedback loops:** the loop-guarded mcp-autorefresh hook POSTs this route fire-and-forget; a 409 is simply logged by curl, no retry loop. Internal callers (ContextWedgeSentinel, quota swap, restart-all) call `refreshSession()` directly and are unaffected.

---

## 6. External surfaces

- The HTTP response for a refused target changes from 202 to 409/429 with `{code, error}`. This is the intended fix; the documented usage already says to pass the tmux name. No in-repo caller depends on a 202 for a refused name (grep of src, scripts, templates).
- No persistent state, no external systems, no notices.
- Operator surface: no operator-facing actions added.

---

## 6b. Operator-surface quality (Operator-Surface Quality standard)

No operator surface — not applicable.

---

## 7. Multi-machine posture (Cross-Machine Coherence)

Machine-local by design: a refresh acts on a tmux session on the machine serving the request, and the orchestrator's in-flight set and rate window are already per-process. No notices, no durable state, no URLs.

---

## 8. Rollback cost

Pure code change — revert and ship a patch. No persistent state, no migration, no agent state repair. During a rollback window callers would again receive 202 for refused names (the prior behaviour).

---

## Conclusion

Small correctness fix: the route now tells callers the truth about target refusals it previously hid in the log. The detect phase was extracted without behaviour change (the existing SessionRefresh, Slack-arm, route, integration and e2e swap-continuity suites pass unchanged apart from the route mock gaining the new method). GET /sessions already exposes the binding as `platform`/`platformId`; the stored `topicId` field is left as-is rather than redefined. Second-pass reviewer concurred; clear to ship.

---

## Second-pass review (if required)

**Reviewer:** independent general-purpose reviewer subagent (read-only, same worktree)
**Independent read of the artifact: concur**

Concur: the extraction is behaviour-preserving, `precheckRefusal` is non-mutating (the rate-window prune only drops already-expired timestamps), the self-refresh 202 still precedes the kill, and the suites plus `tsc` pass. Two artifact corrections raised and applied: messages (not only codes) gain the display-name hint, and busy + rate-exhausted now answers 429 instead of 409 session-busy.

---

## Evidence pointers

- `npx vitest run tests/unit/SessionRefresh.test.ts tests/unit/sessions-refresh-route.test.ts tests/unit/sessionRefresh-slack.test.ts tests/integration/swap-continuity-antithrash-routes.test.ts tests/e2e/swap-continuity-antithrash-lifecycle.test.ts` → 5 files, 74 tests passed.
- `tsc --noEmit` clean.

---

## Class-Closure Declaration (display-only mirror)

No agent-authored-artifact defect — not applicable. (Route response-ordering bug in server source; not a prompt/hook/config/skill/standards defect, and not a self-triggered controller.)
