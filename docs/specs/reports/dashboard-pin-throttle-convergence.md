# Convergence report — dashboard-pin-throttle (SEC-002)

**Spec:** docs/specs/dashboard-pin-throttle.md · **ELI16:** docs/specs/dashboard-pin-throttle.eli16.md
**Rounds:** 6 · **Reviewers each round:** internal lenses (security, adversarial, scalability, integration, decision-completeness, lessons-aware), the Standards-Conformance Gate (`POST /spec/conformance-check`), GPT-6 (codex-cli, gpt-6-astra), and the Claude clean-door second read (claude-code, claude-opus-5-5). Gemini/Grok were unreachable this session (no subscription sign-in / weekly credit exhausted) — recorded, not blocking.

## What it is, in one paragraph

`POST /dashboard/unlock` (the 6-digit PIN door reachable over the agent's public tunnel) had two weaknesses found by the security program: its rate limiter keyed on `req.ip`, which is loopback for ALL tunnel traffic, so one stranger's wrong guesses shared — and could exhaust — the owner's bucket (an owner-lockout DoS); and the only brute-force brake was a single pooled attempt cap. This change keys the limit to the real client (cf-connecting-ip, trusted only over our own cloudflared), lets any browser the owner has unlocked before straight in (a signed cookie), puts a hard cap on unknown guessers that an address-rotating botnet cannot evade, exempts genuinely-local requests so the owner at the machine always gets in, and raises one plain-words owner alert when an attack drains the cap. HIGH, not critical. Ships enabled, one-switch rollback.

## The design evolved materially under review (the point of the exercise)

The admission model was rewritten three times as reviewers found that each earlier shape failed a real case:

1. **v1/v2 (per-source backoff + token buckets):** both GPT-6 and the clean-door reader proved these could STARVE a cold, unmarked owner during a sustained distributed attack — the very DoS being fixed. Rejected.
2. **v3 (never block a zero-failure source):** closed the owner-starvation definitively, but reviewers showed the brute-force bound was then too weak (an address-rotating botnet looks like endless never-failed cold owners; ~190k guesses per 5-min window from one /48). This surfaced a genuine theorem — you cannot BOTH always-admit a never-failed source AND hard-bound distributed guessing — which was escalated to the operator as a fork.
3. **(b), operator-ratified (echo-chief-of-staff, 2026-11-15):** a KNOWN browser (signed cookie) is always let in; UNKNOWN sources share a HARD cap (the real bound); a never-seen browser caught behind the cap during a live attack recovers OUT OF BAND (the agent runs on the owner's own machine). The operator chose this explicitly over v3 because v3 "cannot stop distributed guessing of a 6-digit PIN."

## Findings resolved in the (b) rounds

- **Marker abuse keyed per-IP, bypassing backoff (GPT-6 + clean-door):** a stolen cookie got N guesses per address. Fixed by keying marked state on the cookie's SIGNED id (not the IP): one stolen cookie is bounded by its own gentle backoff + abuse cap, and NEVER affects another browser's marker. Sound because a valid marker can only be minted by a correct PIN.
- **"Stolen cookie stays under its own backoff" (CoS req 2) not actually met:** a marked source bypassed backoff entirely. Fixed: backoff now applies to the marker id too (gentler threshold).
- **Shared-NAT owner re-blocked:** keying marked state on the cookie id (not the shared IP) means an owner behind the same NAT as an attacker is judged by their own cookie, never the attacker's IP failures.
- **`maxSources` not a hard bound when all entries blocked (GPT-6):** eviction now guarantees a free slot (evicts the least-recently-active entry even if blocked, a bounded cost), so table size is truly capped.
- **Backoff reset at the window boundary (clean-door):** entries now expire on a quiet period since the LAST attempt, and refused attempts refresh it, so a persistent guesser keeps its growing delay.
- **Quick-tunnel hostname change invalidates cookies (clean-door):** documented as an honest limitation (named tunnels, which production agents use, keep the bypass; a quick tunnel resets it on hostname change and falls back to out-of-band more often).
- **Local recovery path not actually exempt (clean-door):** the hard cap would have refused a local unlock too. Added a genuinely-local exemption (loopback socket + no cf-connecting-ip + local Host) so the owner at the machine always gets in — the recovery path is real and tested.
- **Alert fired below the cap (GPT-6):** the alert now fires ONLY when the hard cap is reached (the "use a known browser or the machine" signal), deduped, downstream of the self-healing cap.
- **Global marked budget disabled all markers (a single-stolen-cookie DoS):** removed in favour of per-cookie-id isolation, which is sufficient because markers can only be minted by a correct PIN.

## Residuals, stated honestly (not hidden)

- A brand-new, never-unlocked browser during a live saturating attack is refused for a few minutes and recovers out of band (the ratified cost of a real brute-force bound).
- The hard cap narrows but does not reduce to zero a slow distributed brute-force (~20 failures / 5 min default); the real blast-radius control for a guessed PIN is the tracked follow-up SEC-002b (scoped token instead of the master token).
- A quick-tunnel hostname change resets the known-browser bypass; named tunnels do not have this.

## Verification

21 unit tests (PinThrottle logic + the signed cookie marker) green; 0 type errors; an in-process behavioral probe against the real AgentServer passed all five checks (correct-PIN 200 + cookie, stranger refused after the cap, cookie-owner unlocks while drained, local exemption, plain-words alert fired). Integration + e2e "feature is alive" tests are written for Local Verify. Converged — the final rounds produced only accepted/ratified tradeoffs and the recurring "exact numbers are judgment" conformance note (defaults are operator-tunable; the security rests on the shape, not a single number).
