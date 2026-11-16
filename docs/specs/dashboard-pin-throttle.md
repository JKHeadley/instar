---
title: Dashboard PIN unlock — per-client throttle, known-browser bypass, hard cap, owner alert
slug: dashboard-pin-throttle
date: 2026-11-15
author: echo
parent-spec: a2a-relay-unknown-sender-trust.md
parent-principle: "The User Experience Is the Product — Reachability, Responsiveness, and Coherence Are Sacred"
parent-principle-fit: "The dashboard PIN is the owner's way in. Today one attacker's guesses share the owner's rate-limit bucket, so an attacker can lock the owner out, and the guess budget is pooled across everyone on the tunnel. This keys the limit to the real client, lets any browser the owner has used before in instantly (its signed cookie), and puts a HARD cap on unknown guessers that actually stops a distributed attack. A never-used browser caught behind that cap during a live attack recovers out of band — the agent runs on the owner's own machine — and the owner is told in plain words how. The user's reach wins; the guesser is genuinely bounded."
binding-standards: ["Security Fixes Keep the Experience Whole", "The User Experience Is the Product — Reachability, Responsiveness, and Coherence Are Sacred", "Self-Heal Before Notify — The Operator Hears Only When Self-Healing Fails", "No Unbounded Loops — Every Repeating Behavior Carries Its Own Brakes"]
eli16-overview: dashboard-pin-throttle.eli16.md
security: true
approved: true
approved-note: "Operator-delegated security program (Justin, topic 141385, 2026-11-15). Chief of Staff ratified design (b) and the four requirements (echo-chief-of-staff handoffs d3808795 'Build (b)' and 180aa548, 2026-11-15); the hard rule 'patches never degrade UX unless absolutely necessary' is met — the known-browser bypass leaves the normal experience untouched. Same approval path as the UX-standard PR #3200."
review-convergence: "2026-11-16T01:23:12.539Z"
review-iterations: 6
review-completed-at: "2026-11-16T01:23:12.539Z"
review-report: "docs/specs/reports/dashboard-pin-throttle-convergence.md"
cross-model-review: "codex-cli:gpt-6-astra"
---

# Spec — Dashboard PIN unlock throttle

Source: Instar security program (operator, topic 141385, 2026-11-15), finding SEC-002 (verified from code; detail in the private ledger). Class-level here: the public text names the class (a shared rate-limit bucket and a pooled guess budget on the PIN unlock) and the mitigation, never a repro.

## Problem (class)

`POST /dashboard/unlock` is the 6-digit-PIN door to the dashboard, reachable over the agent's public tunnel. Its rate limiting has two weaknesses:

1. **Shared bucket → owner lockout.** The per-client limiter keys on `req.ip`, which for every request arriving through the Cloudflare tunnel is loopback (cloudflared connects locally and the server does not trust a proxy). So all tunnel clients — and the owner — share ONE bucket. A stranger sending a few wrong PINs exhausts it and the owner cannot unlock (a denial of service against the owner).
2. **Pooled guess budget.** A single global cap (a fixed number of attempts per window) is the only brake on guessing, shared across all sources, with no per-source backoff and no signal to the owner that guessing is happening.

Neither is a remote code-execution or data-disclosure hole on its own; the rating is HIGH (an owner-facing denial of service, plus a slow brute-force path on a long-lived public tunnel), not critical.

## Design

A small, testable throttle plus two wiring changes, all behind `security.pinThrottle.*`. No change to what a correct PIN does, and no new step for the owner.

### 1. Key the limit to the real client (closes the owner lockout)

The unlock handler derives the client key with the existing `callerAddress(req, viaOwnName)` helper (`src/server/documentLinkRoutes.ts`). **What that helper actually does, precisely:** it returns `cf-connecting-ip` only when `viaOwnName` is true AND the socket peer is loopback (`isLoopbackPeer(req.socket.remoteAddress)`), and the socket address otherwise. It does NOT itself reject forwarding headers — that is a separate concern (below) — so the stated trust condition is "loopback socket + own Host", not "no X-Forwarded-For". This matters because **cloudflared normally adds its own `X-Forwarded-For`**; a condition of "no forwarding header" would make every real tunnel request fall back to the loopback key and silently reinstate the shared bucket. The real corroboration is the loopback socket, which a remote caller cannot present.

**`viaOwnName = isOwnHost(host)`**, the same source the document routes use (`AgentServer`'s `ownNames.accepts(host)`). **The active tunnel hostname must be an own-name for this to work.** Over an ephemeral `*.trycloudflare.com` quick tunnel the Host is not in `ownNames` by default, so `viaOwnName` would be false and every tunnel client would be keyed on loopback again — the bug would persist in exactly the common case while a named-tunnel test stayed green. So this change ALSO registers the active tunnel hostname (named and quick) as an own-name for the unlock key derivation, and an integration test drives the real tunnel Host (not only a named one) to prove the client key is the real client.

**What the symbol proves (Verify the State, Not Its Symbol).** Symbol: a loopback-peer request with this agent's own Host. State: "arrived through our own cloudflared connector (runs on this machine, connects from loopback) OR is a local process on this machine." A REMOTE or direct-LAN caller has a non-loopback socket and is NEVER keyed on the header — keyed on its socket address, so it cannot forge another client's or the owner's bucket. A LOCAL process could reproduce the shape and forge the header, but that is out of scope: a local process already holds the agent token and has full control, so it has nothing to gain. Unmeasurable case (non-loopback socket): fall back to the socket address. Asserted by test (a spoofed `cf-connecting-ip` from a non-loopback path is keyed on its socket).

**IPv6 keyed by /64.** The client key is run through `normalizePinSource`, which collapses an IPv6 address to its /64 prefix, so a single network cannot present 2^64 distinct keys and defeat the per-source brake or churn the source table. IPv4 passes through.

**Genuinely-local requests are EXEMPT from the throttle (the recovery path is real).** The hard cap would otherwise refuse a local unlock too — local and tunnel requests both arrive at `POST /dashboard/unlock` from a loopback socket — which would break the documented out-of-band recovery. So the handler distinguishes a genuinely-local request (loopback socket AND no `cf-connecting-ip` header AND a local Host such as `localhost`/`127.0.0.1`/`[::1]`, i.e. NOT arriving through cloudflared, which always sets `cf-connecting-ip` and a tunnel Host) and SKIPS `PinThrottle` for it entirely — the PIN is still checked, but the cap never refuses the owner sitting at the machine. A tunnel request can never present this shape (cloudflared sets `cf-connecting-ip`), so the exemption cannot be reached from the public endpoint. This, plus the paired phone-app route (a different credential, never consulted against the throttle), is what makes "use the machine" a guaranteed way in during an attack. Asserted by an integration test: a local unlock succeeds while the tunnel cap is fully drained.

### 2. `PinThrottle` — let the known browser in, hard-cap the unknown guessers

A new pure module `src/core/PinThrottle.ts` (unit-tested, clock-injected), consulted BEFORE the PIN is compared. A blocked attempt is refused WITHOUT comparing the PIN (no success oracle, a real limit, not a delay before an always-performed check).

This is the operator-ratified design (b) (echo-chief-of-staff, 2026-11-15): a KNOWN browser is always let in; UNKNOWN sources share a HARD cap that actually bounds distributed guessing; and a never-seen browser caught behind that cap during a live attack recovers OUT OF BAND. The reasoning (recorded, from two cross-model review rounds): you cannot BOTH always-admit a never-failed source AND hard-bound distributed guessing, because an address-rotating botnet looks exactly like endless never-failed cold owners. Design (b) chooses the hard bound and gives the cold owner an out-of-band path, because the agent runs on the owner's own machine — so the owner is never truly locked out, while a 6-digit PIN is actually protected from a botnet (the always-admit alternative left ~190k guesses per 5-min window from one /48, which does not close the finding).

**Marked (prior-unlock cookie) → judged by the cookie's own id, not the IP.** A known browser is admitted (bypassing the stranger caps below) when its marker is honored and not in its own backoff — so a browser the owner has unlocked before reaches the PIN check instantly even while sharing a public IP (NAT/CGNAT, same /64) with an active attacker, and even while the hard cap is fully drained. Crucially the marked state is keyed on the cookie's signed id, NOT the shared IP: the attacker's IP-keyed failures never touch the owner's cookie, and the owner's cookie is never charged for an attacker on the same NAT. Each cookie is judged in ISOLATION by its id: a stolen cookie stays under ITS OWN gentle backoff (keyed on the id, so it follows the cookie across any addresses) after `markedSoftFailures` misses, and once it has failed `markedAbuseCap` times (default 50, all heavily backed off) its marker is no longer honored and it falls to the unmarked hard cap. Per-id isolation is deliberate and is the full bound: one stolen cookie NEVER affects another browser's marker (no shared marked budget to drain), so a compromised cookie cannot lock out or degrade any other owner device. This is sound because a valid marker can ONLY be minted by a correct PIN — every cookie an attacker holds came from a device that already unlocked legitimately; there is no way to manufacture markers without the PIN, which is why a per-cookie cap, not a global one, is the right bound. A replayed or stolen cookie therefore buys at most a bounded, backed-off run of guesses from one compromised device, then nothing — and never without the PIN.

**Unknown → a HARD global failure budget (the real brute-force bound).** Unmarked FAILURES across all sources consume one shared budget per window (`globalFailureBudget`, default 20 / 5 min). Once drained, further unmarked attempts are REFUSED (429 `global-cap`) for the rest of the window — regardless of the source's own history. This is the bound an address-rotating botnet cannot evade: rotating to fresh addresses does not refill a global budget. The accepted, ratified cost: a brand-new UNMARKED browser during a saturating attack is refused and recovers out of band (the owner's own machine, local dashboard, or the paired phone app — none of which go through this cap), and the owner is alerted in plain words. A marked (known) browser never consumes nor is bounded by this cap.

Guessing is further bounded by two secondary brakes, both on FAILURES:

- **Per-source exponential backoff.** After `softFailures` misses (default 3; `markedSoftFailures` default 8 for a known browser, so an owner fat-fingering a trusted browser is not slowed early) the source is delayed with exponential backoff (`baseMs` 2s, doubling, capped at `maxBackoffMs` 15 min), and the backoff does NOT reset at the window boundary (a source that keeps attempting keeps its growing delay). One hammering source slows fast. A correct PIN clears the source at once.
- **Coarse-network failure budget.** A per-/48 (IPv6) / per-/24 (IPv4) unmarked failure budget (`coarseFailureBudget`, default 10) so one routed allocation cannot multiply its share of the hard cap by churning sub-addresses within it.

**IPv6 keyed by /64** (`normalizePinSource`, canonicalized: leading zeros, IPv4-mapped and dotted forms all collapse) so one network is not 2^64 keys. The source table holds only FAILED sources (a zero-failure source creates no entry, so a fresh-source flood cannot fill it), is bounded by `maxSources` (default 4096), and never evicts an actively-blocked entry (which would reset an attacker's backoff).

**A correct PIN does NOT reset the global or coarse budgets** — only the successful source's own backoff and marker-abuse count are cleared — so an owner login never hands an attacker a fresh guess budget.

- **Owner alert, downstream of the brake, in plain words.** The alert fires ONLY when the hard unmarked cap is reached — the self-healing cap is already containing the attack, and the alert exists to tell the owner how to get in meanwhile. A single hammering source is handled silently by backoff and raises NO alert (below the cap = silence). Deduped to ONE near-silent notice per `alertCooldownMs` (default 30 min). Its WORDS are plain and actionable (requirement 1): *an attack on the dashboard PIN is under way; to unlock, use a browser you have unlocked before, or the machine itself*.
- **Brakes (No Unbounded Loops).** The source and coarse tables are bounded and window-expired; the alert is cooldown-deduped. Nothing grows unbounded; nothing notifies in a loop.

**Composition with the durable `PinAttemptStore`.** The existing durable store is kept as the cross-restart backstop; `PinThrottle` is the in-memory layer in front, and a request passes both. A marked (known) browser is never hard-blocked by the durable store either, so the store cannot reintroduce the owner lockout for a returning owner.

### 3. The prior-unlock marker, and what a correct PIN does

A correct PIN still returns immediately, clears the source's backoff, and returns the same response shape and token as today (returning a scoped token instead of the master API token is the deeper change tracked as SEC-002b <!-- tracked: SEC-002b security program ledger -->, the NEXT PR with its own full dashboard UX proof — not here).

On a successful unlock the server also sets the **prior-unlock marker**: an httpOnly, Secure, SameSite=Strict cookie `instar_pin_ok` whose value is `<expiryMs>.<hmac>`, where the HMAC covers the expiry and a random id and is keyed by a **derived** key `HKDF(agentToken, "instar-pin-ok-cookie-v1")`, NOT the raw master token (so the token is not reused for a second purpose). The expiry is INSIDE the signed value and verified server-side on each unlock, so a stolen cookie value cannot outlive it; there is no per-cookie revocation other than agent-token rotation, which invalidates every marker at once (stated, accepted). The cookie only grants the marked-bucket bypass — the PIN is still required — so a replayed or forged marker buys nothing without the PIN, and the HMAC cannot be forged without the derived key.

**Marker scope is the issuing machine.** The cookie is sent only to the hostname that set it, so a browser that unlocked machine A presents the marker to machine A; it does not and need not cross to machine B's distinct tunnel hostname. (The derived key is per-agent, so B COULD verify A's marker if the browser ever sent it, which is harmless — same owner — but browsers will not send it cross-hostname.)

**Honest limitation — an ephemeral quick-tunnel hostname.** A browser sends `instar_pin_ok` only to the exact hostname that set it. A *named* tunnel (a stable custom domain, which production agents exposing the dashboard use — e.g. this agent's) keeps the same hostname, so the known-browser bypass persists. An ephemeral `*.trycloudflare.com` quick tunnel, however, gets a NEW random hostname each time cloudflared restarts, and the browser will not send the old cookie to the new hostname — so after a quick-tunnel restart every browser counts as cold until it unlocks once more. During a live attack that has the hard cap drained, that re-establishing unlock would itself be refused, and the owner falls back to out-of-band (the machine, local dashboard, paired phone app) — exactly the documented recovery path, just reached more often on a quick tunnel. Stated, not hidden: the known-browser bypass is durable on a named tunnel and resets on quick-tunnel hostname change; named tunnels are recommended for any agent that exposes the dashboard publicly.

## Decision points touched

| Decision point | Classification | Basis / floor |
|---|---|---|
| Client key for the PIN limit (real client vs socket) | invariant; basis: irreversible-consequence; evidence: keying on the shared loopback address lets any one client exhaust the owner's bucket, denying the owner access | Deterministic: `callerAddress` trusts `cf-connecting-ip` only for a loopback socket with our own Host (`viaOwnName = isOwnHost(host)`), else the socket address; IPv6 collapsed to /64. |
| Admit / refuse an attempt (consulted before the PIN check) | judgment-candidate | Floor: a MARKED (known-browser) source that has not abused its marker is ALWAYS admitted; otherwise admit UNLESS the source is in active backoff, the hard global unmarked budget is drained (429 global-cap), or the source's coarse network is over budget (429 coarse-cap) — decided before the PIN is compared; arbiter = `PinThrottle` from the marker, the source's failure history, the global + coarse budgets, and the injected clock. Deterministic, no LLM. |
| Always admit a known (marked) browser | invariant; basis: irreversible-consequence; evidence: the owner's returning browser must never be locked out by a stranger's guesses — the exact DoS this fixes; the signed cookie proves a prior successful unlock, so admitting it (the PIN is still required) can never help an attacker | Deterministic: valid-marker && not-abused → admit. |
| Hard-cap unknown guessers | invariant; basis: irreversible-consequence; evidence: a 6-digit PIN on a public endpoint is only protected by a bound an address-rotating botnet cannot evade; a per-source-only limit is defeated by rotation, so the shared global budget must be a hard refusal | Deterministic: unmarked failures ≥ globalFailureBudget → refuse for the window. |
| Raise an owner alert | judgment-candidate | Floor: at most one alert per `alertCooldownMs`, only when the hard cap is reached and guessing persists; silence otherwise. Downstream of the cap (self-heal), per Self-Heal-Before-Notify. |

## Limits and defaults

The brakes are keyed on FAILURES. The security rests on the HARD global unmarked cap (a bound an address-rotating botnet cannot evade), not on any per-source number alone. Conservative, operator-tunable defaults (`security.pinThrottle.*`): softFailures 3 (markedSoftFailures 8), markedAbuseCap 50 (basis: external-constraint — generous enough that a real owner never trips it, low enough that a leaked cookie is bounded), baseMs 2s, maxBackoffMs 15 min, windowMs 5 min, globalFailureBudget 20 / window (the hard cap; basis: external-constraint — low enough to stop a botnet, high enough that ordinary stray wrong PINs across the day never reach it), coarseFailureBudget 10 / /48 or /24, alertCooldownMs 30 min, maxSources 4096 (a hard bound — unbounded state on a public endpoint is a DoS). The accepted residual is explicit: a brand-new UNMARKED browser during a saturating attack is refused and recovers out of band; a known browser is never affected.

## Frontloaded Decisions

1. **Ships enabled for every agent**, next release, with a config block to tune or disable (`security.pinThrottle.enabled`, default on). The owner sees no change on the happy path, and the gap is a live owner-facing DoS, so a dark default would guard nothing.
2. **A known browser is never locked out; a cold browser during an attack recovers out of band.** Any browser the owner has unlocked before is admitted instantly by its signed cookie, even while the hard cap is drained — so in normal use the owner sees no change at all. The ONLY case with any owner-facing cost is a never-before-used browser during a live saturating attack: it is refused at the cap, and the owner unlocks instead from a browser they have used before or from the machine itself (local dashboard, the paired phone app) — none of which go through the cap. The owner is told this in plain words. This is the ratified reading of *Security Fixes Keep the Experience Whole*: the normal experience is untouched, and even the edge case is a recovery path, not a lockout, because the agent runs on the owner's own machine. The alternative (never-block-any-source) was rejected because it cannot stop distributed guessing of a 6-digit PIN.
3. **Alert is near-silent and deduped**, routed as an ordinary attention notice, not a push, below the operator-notification floor. Guessing against a public endpoint is common; the owner is told when it persists, not on every stray attempt.
4. **Scoped-token return (SEC-002b) is tracked, not bundled.** It is defense-in-depth with a broad dashboard-auth surface; forcing it here would risk the very UX degradation the standard forbids, for a HIGH (not critical) finding.

## Open questions

*(none)*

## User-visible effect

In normal use, none. A correct PIN unlocks instantly from any browser the owner has unlocked before (its signed cookie), exactly as fast as today, even while a distributed attack is running — a known browser is never caught by the cap. There is no new step on a correct entry.

The one new owner-facing behaviour is the recovery path during a live attack, stated exactly as the owner will experience it: **if a brand-new browser (one that has never unlocked this dashboard) is used at the very moment a saturating guessing attack has the unknown-source cap drained, that unlock is refused for a few minutes. To get in, the owner uses a browser they have unlocked before, or the machine itself — the local dashboard or the paired phone app, which do not go through the tunnel cap. The owner receives one plain-words alert saying an attack is under way and how to unlock.** The owner is never locked out: the machine is always a way in.

This satisfies *Security Fixes Keep the Experience Whole*: the normal experience is untouched (REMOVING today's degradation, where a stranger's few wrong guesses lock the owner out of the shared bucket), and the single edge case is a documented recovery path with a plain-words alert, not a lockout — the ratified cost of actually stopping a botnet from guessing a 6-digit PIN.

## Multi-machine posture

The throttle state is per-machine OPERATIONAL state — a bounded rate-limit counter for this machine's own public unlock endpoint — not continuity-bearing agent memory. Under the standard's own boundary (per-machine operational records, like Decision-Provenance logs and `PinAttemptStore`, are machine-local by design and not a survivability violation), it is machine-local because it is inherently per-endpoint: "wrong PINs tried against machine A's tunnel" is not information machine B can or should act on — B serves a different endpoint. Losing it on a restart costs nothing the agent KNOWS; it is a counter, not memory.

machine-local-justification: operator-ratified-exception — the operator directed this fix with explicitly machine-local throttle state (Chief of Staff relay of topic 141385, 2026-11-15; conditions in message b459da45-5908-4ae2-90ec-38e0b50ba3be), consistent with the existing per-machine `PinAttemptStore` it fronts.

The `instar_pin_ok` cookie is scoped to the hostname that issued it (the machine whose tunnel the browser unlocked), so it does not travel across machines' distinct tunnel hostnames — correct, since the throttle is per-endpoint. The derived cookie key is per-agent, so another machine COULD verify the marker if a browser ever sent it (harmless — same owner), but browsers do not send a cookie cross-hostname. The owner alert routes through this machine's ordinary attention/notice surface, which carries its own multi-machine posture.

## Self-Heal Before Notify

The throttle self-heals first: a hammering source is slowed by backoff and unknown guessing is refused at the hard cap (the remediation), both bounded by the window and `maxBackoffMs`. Only when the hard cap is reached AND guessing persists does it raise ONE deduped owner alert per `alertCooldownMs` (the escalation is downstream of the self-healing cap). The alert is `recoverable` class (an owner-facing security notice, not data-loss), latency bounded by the cooldown (well under any constitutional ceiling). No action is taken that needs rollback; the backoff and the cap are pure refusals, idempotent, with nothing to compensate.

## Rollback

`security.pinThrottle.enabled: false` (live) restores the previous limiter behaviour in full — including the real-client keying and the known-browser bypass — so turning it off re-exposes the owner-lockout DoS; that is the deliberate single-switch tradeoff (the fix is all-or-nothing, for one clear rollback). Revert the PR to remove the module. No data migration; the throttle state is in memory and the `instar_pin_ok` cookie is inert once the code is gone (and is invalidated by agent-token rotation).

## Maturation plan

- **test-agent-live:** proven in-process against a real AgentServer (the unlock route with the throttle wired): correct PIN 200 + signed cookie, hard cap refuses a fresh unmarked tunnel browser, a cookie-marked owner unlocks while the cap is drained, a loopback-Host local request is exempt, and the plain-words owner alert fires.
- **dev-agent-live:** enabled on this development agent (Echo) at the next deploy and verified over its real named tunnel (own-name keying active, a wrong-PIN flood from a second client never blocks the owner's browser).
- **fleet:** ships ENABLED for every agent next release. This is a security fix for a live owner-facing DoS, so a dark default would guard nothing; the operator ratified shipping it live (echo-chief-of-staff, 2026-11-15).
- **graduation criterion:** no owner-lockout reports after rollout AND the hard cap demonstrably refuses sustained unknown guessing on Echo's live tunnel while a known browser and the machine still unlock.
- **dark-window:** none by design (ratified live). The single-switch `security.pinThrottle.enabled: false` is the live rollback if a problem appears, restoring the prior limiter exactly.
- **ladder:** not applicable: a direct security fix (owner-lockout DoS), not tracked on a formal feature-maturation ladder

## Tests

- `tests/unit/pin-throttle.test.ts`: `normalizePinSource` collapses IPv6 to /64 and canonicalizes leading-zero / IPv4-mapped / dotted forms; `coarsePinNetwork` is /48 (IPv6) and /24 (IPv4); a MARKED (known-browser) source is admitted even while a saturating flood has drained the hard cap AND even sharing its key with attacker failures; a brand-new UNMARKED source is refused once the global budget is drained (reason `global-cap`); per-source exponential backoff capped and non-resetting; coarse /24 budget bounds sub-address rotation (reason `coarse-cap`); a marked source does NOT consume the unmarked budget; an ABUSED marker (past `markedAbuseCap`) stops being honored and faces its backoff (a stolen cookie is bounded); a success does NOT reset the global/coarse budgets; the alert fires once per cooldown when the cap is reached (kind `global-cap`) and not on a few failures; source table bounded; config sanitized; injected clock.
- `tests/unit/pin-unlock-marker.test.ts`: the `instar_pin_ok` marker verifies for its agent token and not after its signed expiry; cannot be forged with a different token; expiry is inside the signature (tampering fails); malformed values and a missing token are rejected; cookie options are httpOnly + Secure + SameSite=Strict.
- `tests/integration/dashboard-pin-throttle.test.ts`: through the real server — (requirement 3) a cookie-marked owner unlocks instantly with a correct PIN while a flood of wrong PINs from many sources has the hard cap fully drained; a brand-new unmarked browser is refused at the cap during that flood; a successful unlock sets the signed `instar_pin_ok` cookie; `cf-connecting-ip` is honoured ONLY for a genuine loopback+own-Host request and ignored for a direct/LAN/forged request (keyed on its socket); the active tunnel Host is an own-name so the real-client key is derived over the real tunnel path; **the paired phone-app route is UNAFFECTED by the throttle** (it authenticates by its own paired credential, not the dashboard PIN, so it is not consulted against `PinThrottle` and stays available while the cap is drained); the plain-words alert surfaces on the attention/notice route; the throttle sits in front of the durable `PinAttemptStore`.
- `tests/e2e/dashboard-pin-throttle-alive.test.ts`: the production boot path serves unlock with the throttle wired (correct PIN 200 + cookie set; a source that has failed enough backs off; the hard cap refuses a fresh unmarked source once drained; a marked source is still admitted).
- Throwaway-agent proof (private): a many-SOURCE guess running to drain the cap; a cookie-marked owner unlocks instantly throughout; a brand-new unmarked browser is refused at the cap and the paired-route still works; a single hammering source is backed off; a spoofed `cf-connecting-ip` from a non-cloudflared path is ignored; measured hard-cap, per-source and coarse brakes before/after.