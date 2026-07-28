# Side-Effects Review — network-class uncaught exceptions degrade, not crash (CMT-1548)

**Version / slug:** `cmt1548-uncaught-fetch-degrade`
**Date:** `2026-06-15`
**Author:** `Echo (instar-dev agent)`
**Second-pass reviewer:** `adversarial reviewer subagent (see §Second-pass)`

## Summary of the change

The server's top-level `process.on('uncaughtException')` handler (`src/commands/server.ts`) crashes by default and only log-and-continues for errors whose message matches `NON_FATAL_UNCAUGHT_PATTERNS` in `src/core/uncaughtExceptionPolicy.ts`. That allowlist already covers HTTP double-response races, the Slack `Sent before connected` reconnect race, and standby read-only writes — but NOT network-class failures. On 2026-06-15 a transient `fetch failed` (the multi-machine lease-wire broadcasting to an offline peer, during an upstream/API outage) hit the handler as an uncaught exception and crashed the whole server (it auto-restarted ~50s later). This change adds network-class tokens (`fetch failed`, `ECONNREFUSED`, `ECONNRESET`, `ETIMEDOUT`, `ENOTFOUND`, `EAI_AGAIN`, `socket hang up`) to the allowlist, with a justification comment, plus unit tests on both sides of the boundary. Files: `src/core/uncaughtExceptionPolicy.ts` (+8 patterns +comment), `tests/unit/uncaughtExceptionPolicy.test.ts` (+1 positive block, +2 negative boundary cases). Handler logic untouched.

## Decision-point inventory

- `isNonFatalUncaught() recoverable-vs-fatal boundary` (`src/core/uncaughtExceptionPolicy.ts`) — **modify** — extends the existing recoverable allowlist with network-class tokens. Default for any unmatched error stays crash (the safe default).

---

## 1. Over-block

In this context "over-block" = **suppressing an uncaught error that SHOULD have crashed** (false-recoverable). The risk: an error whose message merely *contains* a network token (e.g. a programming bug whose message happens to include "socket hang up") is now suppressed and the process keeps running in a possibly-degraded state instead of crashing clean.

Concrete shapes considered: `'fetch failed'` and the `E*` codes are emitted by Node/undici for genuine network failures only — they are not substrings of common logic-bug messages. `'socket hang up'` and `'ECONNRESET'` are the broadest; both are still network-transport phrases, not general-purpose words. The boundary test asserts `'assertion failed'` / `'migration failed'` stay fatal (a bare "failed" is NOT matched — we match specific tokens). Residual risk is low and is the deliberate trade: a transient network blip must not crash the agent, and the first-seen-stack log surfaces any wrongly-suppressed origin for follow-up.

---

## 2. Under-block

"Under-block" = **still crashing on something that was recoverable**. A network failure surfaced with a message outside this token set (e.g. a custom wrapper that rethrows "upstream unavailable" without the underlying code) would still crash. That is acceptable — the allowlist is intentionally tight; we add tokens as real crashes prove them recoverable rather than matching a broad "any network-ish word." The belt-and-suspenders follow-up (a `.catch` at the lease-wire broadcast + slack reconnect fetch paths) is the primary fix; this policy entry is the backstop.

---

## 3. Level-of-abstraction fit

Correct layer. This is the process-level last-resort crash backstop — the established home for "this isolated error must not take the whole agent down." It is intentionally a low-level substring detector defaulting to the SAFE direction (crash on anything unrecognized). It does not replace the proper fix (guard the originating fetch with `.catch`); it prevents a missing-catch from escalating a transient outage into a crash-loop. A higher-level gate is not appropriate for a synchronous uncaught-exception handler.

---

## 4. Signal vs authority compliance

**Required reference:** docs/signal-vs-authority.md

- [x] Yes — but the logic is the EXISTING, blessed crash-backstop pattern, and it fails toward the safe default (crash) for anything unmatched.

This entry extends an established allowlist whose whole design is: recognized-isolated → continue; everything else → crash. It holds "crash vs continue" authority, but with the conservative default (unknown ⇒ crash). It is not a new brittle detector owning block-authority over user input; it is the same precedent already shipping for HTTP races, Slack reconnects, and standby writes. The first-seen-stack diagnostic preserves the path to fixing the real missing-catch. No reshaping needed; the design matches the existing pattern exactly.

---

## 5. Interactions

- **Shadowing:** runs only inside the top-level `uncaughtException` handler; no ordering against other checks. A matched error returns before `closeAllSqlite()` + `process.exit(1)`. No other check is shadowed.
- **Double-fire:** none — a single uncaught exception is handled once.
- **Races:** none — the policy is a pure substring function over the error message; no shared state. (`shouldLogStackForUncaught`'s dedup set is unchanged.)
- **Feedback loops:** the change REDUCES a feedback loop — it stops the boot→transient-fetch-fail→FATAL→respawn→… crash-loop on a sustained outage.

---

## 6. External surfaces

Fleet-wide runtime behavior change: every instar server will now log-and-continue (instead of crash+respawn) on an uncaught network-class error. User-visible effect is strictly positive (fewer unexpected restarts during upstream/network outages). No change to response formats, ledgers, databases, or any persistent state. No external system (Telegram/Slack/GitHub/Cloudflare) is called differently. No timing dependence. **Operator surface:** none — this change adds no operator-facing action.

---

## 6b. Operator-surface quality (Operator-Surface Quality standard)

No operator surface — not applicable. This change touches no dashboard renderer, approval page, or grant/revoke/secret-drop form.

---

## 7. Multi-machine posture (Cross-Machine Coherence)

**machine-local BY DESIGN** — the crash handler is per-process; each machine's server runs its own `uncaughtException` handler, and that is correct (a crash decision is inherently about the local process). There is no cross-machine state to replicate. Note the *motivating* failure was a multi-machine path (the lease-wire peer broadcast to an offline peer threw the uncaught `fetch failed`), so the benefit accrues most on multi-machine installs — but the fix itself is correctly per-process. Emits no user-facing notices (no one-voice gating needed). Holds no durable state (nothing strands on topic transfer). Generates no URLs.

---

## 8. Rollback cost

Pure code change — revert the two files and ship as the next patch. No data migration, no persistent state, no agent-state repair, no user-visible regression during the rollback window. Reversible by removing the added patterns; the allowlist returns to its prior behavior immediately on the reverted build.

---

## Conclusion

A tight, additive, well-precedented fix to the existing crash-backstop allowlist that resolves a real fleet-wide failure mode (a transient network error crashing the whole server during an outage). The review surfaced one genuine residual risk — over-suppression of a non-network error whose message coincidentally contains a network token — mitigated by keeping the token set specific (boundary test proves a bare "failed" is not matched) and by the first-seen-stack diagnostic that surfaces any wrongly-suppressed origin. Clear to ship as a Tier-1 change.

---

## Second-pass review (if required)

**Reviewer:** adversarial reviewer subagent
**Independent read of the artifact: concur**

Independently verified the test green (11/11 via `vitest run`). Decisive adversarial check: every genuinely-fatal Node/TS error family — OOM (`JavaScript heap out of memory`), `SQLITE_CORRUPT` / `database is locked` / `database is closed`, `EMFILE` / `ENOSPC`, `EPIPE`, `Maximum call stack size exceeded`, and the classic `Cannot read properties of undefined` — all still CRASH, because the network-transport tokens are disjoint from those messages (confirmed by direct substring testing). The `E*` codes are SCREAMING_SNAKE and never appear inside ordinary logic-bug prose, so the `includes` matcher is safe. The only over-suppression constructible (`fetch failed` hiding a non-transient TLS/DNS `.cause`, or a contrived property literally named `'ECONNRESET'`) is either implausible or genuinely isolated-and-recoverable per the handler's contract, with the first-seen-stack diagnostic still surfacing the origin. The boundary tests (`assertion failed`/`migration failed` stay fatal) are load-bearing and correctly prove no bare-`failed` overreach. Clear to ship.

---

## Evidence pointers

- Unit test: `tests/unit/uncaughtExceptionPolicy.test.ts` — 11/11 pass (verified locally via `vitest run`), incl. the new network-class positive block and the `assertion failed`/`migration failed` negative boundary cases.
- Root-cause log evidence: `logs/server.log` 2026-06-15T01:50:28Z `[FATAL] Uncaught exception — closing databases before crash: fetch failed`, preceded by `[lease-wire] broadcast to m_4cbc... became unreachable: fetch failed`.
