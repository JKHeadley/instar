# Side-effects review — dashboard-pin-throttle (SEC-002)

Spec: docs/specs/dashboard-pin-throttle.md · design (b), operator-ratified. In-scope files:
`src/core/PinThrottle.ts` (new), `src/server/pinUnlockMarker.ts` (new), `src/core/types.ts` (config
type), `src/server/AgentServer.ts` (unlock-handler wiring), `src/data/awareness/dashboard-pin-throttle.md` (new),
tests (unit ×2, integration, e2e).

**User-visible-effect (requirement 4):** In normal use, none — a correct PIN unlocks instantly from
any browser the owner has unlocked before, even during an attack. The one new owner-facing behaviour
is during a live attack: if a brand-new browser (never unlocked before) is used while a saturating
guessing attack has the unknown-source cap drained, that unlock is refused for a few minutes; to get
in, the owner uses a browser they have unlocked before, or the machine itself (the local dashboard or
the paired phone app, which do not go through the tunnel cap), and receives one plain-words alert
saying an attack is under way and how to unlock. The owner is never locked out.

1. **Over-block** — Could it reject a legitimate owner? In normal use no (a known browser is always
   admitted by its cookie; a genuinely-local request is exempt). The one case: a never-before-used
   browser during a live saturating attack is refused at the hard cap — deliberate and ratified, with
   out-of-band recovery + a plain-words alert. A quick-tunnel hostname change resets the known-browser
   bypass (named tunnels do not have this); documented.
2. **Under-block** — What does it still miss? A slow distributed brute-force is narrowed (hard cap,
   default ~20 failures / 5 min) but not reduced to zero; the real blast-radius control for a guessed
   PIN is the tracked follow-up SEC-002b (scoped token). A local process on the machine already holds
   the agent token, so the local exemption grants it nothing new.
3. **Level-of-abstraction fit** — Right layer: an in-memory brake + known-browser bypass in front of
   the existing durable `PinAttemptStore`, consulted in the one unlock handler before the PIN compare.
   It reuses `callerAddress`/`ownLoopbackHost` (the established real-client + local-request helpers)
   rather than a parallel mechanism.
4. **Signal vs authority** — `PinThrottle` is deterministic (no LLM) and holds a real, bounded
   refusal, not a brittle heuristic with hidden authority: every refusal is an explicit cap/backoff on
   observed FAILURES, the owner is never blocked on zero evidence, and a correct PIN always clears the
   source. It does not gate any message or action beyond the PIN door it exists to protect.
5. **Interactions** — It replaces the handler's old `req.ip`-keyed in-memory limiter (the bug source)
   when enabled, and keeps the durable `PinAttemptStore` as the cross-restart backstop keyed now by the
   REAL client, never applied to a known browser or a local request (so the store cannot reintroduce
   the lockout). When disabled, the legacy path is byte-for-byte unchanged (rollback). No double-fire:
   only one path runs per request. The owner alert routes through `DegradationReporter` (the existing
   security-notice surface), deduped by cooldown.
6. **External surfaces** — Sets one new cookie (`instar_pin_ok`, httpOnly/Secure/SameSite=Strict,
   agent-bound via HKDF, expiring) on a successful unlock; adds `retryAfterSeconds` to the 429 body.
   No change to the success response token (SEC-002b changes that). The alert is a near-silent notice,
   not a push. Depends on cloudflared setting `cf-connecting-ip` over the tunnel (established).
7. **Multi-machine posture** — Machine-local by design (operator-ratified-exception): the throttle is
   per-endpoint operational state (wrong PINs tried against THIS machine's tunnel), like the existing
   per-machine `PinAttemptStore` it fronts; it is a counter, not agent memory, and losing it on a
   restart costs nothing the agent knows. The cookie is scoped to the issuing hostname; the alert
   routes through this machine's own notice surface.
8. **Rollback cost** — Single live switch: `security.pinThrottle.enabled: false` restores the prior
   limiter exactly (and re-exposes the lockout — the deliberate all-or-nothing tradeoff). Revert the
   PR to remove the modules. No data migration; throttle state is in memory and the cookie is inert
   once the code is gone (and invalidated by agent-token rotation).

## Second-pass review (independent, Phase 5)

An independent reviewer audited the unlock-handler wiring against eight invariants. Invariants 1–7 HOLD (real-client keying closes the lockout bug; local exemption cannot be forged from the tunnel; cf-connecting-ip trusted only over the own-name path; cookie verified + passed as markerId; cookie set httpOnly/Secure/SameSite=Strict on success; alert only on the hard cap; durable store records only unmarked by real client; clean enabled=false legacy path, exactly one path per request; no wrong-PIN bypass).

**Concern raised and FIXED:** `readPinMarker` called `decodeURIComponent` on the raw cookie value with no try/catch — a crafted `Cookie: instar_pin_ok=%` threw `URIError` → a remotely-triggerable 500 on POST /dashboard/unlock (a route-level DoS, not an auth bypass). Fixed: the decode is wrapped and a malformed cookie is treated as no marker (unmarked). Verified by an in-process probe (malformed cookie + correct PIN → 200; malformed cookie + wrong PIN → 403; never 500) and a regression case added to the integration test. Reviewer verdict after fix: the remaining wiring concurs.

**Reviewer:** independent second-pass subagent (Explore, fresh context), 2026-11-15, given the unlock-handler wiring diff and the reused helpers — audited 8 security invariants (real-client keying, local-request exemption un-forgeable from the tunnel, cf-connecting-ip trust scope, cookie verify→markerId, cookie set on success, alert only on hard cap, clean enabled=false legacy path, no wrong-PIN bypass). Invariants 1–7 held; one concern raised — a malformed cookie could 500 the unlock route via decodeURIComponent — which was fixed (wrapped, returns null) and regression-tested before this trace. Reviewer concurs with the wiring after the fix.

## Verify-fix (2026-11-15)

Local Verify flagged two non-behavioral checks, both fixed with no code behavior change: the maturation-plan **ladder:** line was prose and is now `not applicable: <reason>` (feature-ladders-coverage), and the three new catch sites (`pinUnlockMarker` hex parse, `tunnelHostForPin` URL parse, `readPinMarker` cookie decode) now carry `// @silent-fallback-ok — <reason>` markers so the no-silent-fallbacks baseline stays at 494. The independent-review concurrence above still stands (the wiring is unchanged).
