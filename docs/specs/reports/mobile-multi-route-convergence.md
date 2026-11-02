# Convergence Report — The iPhone app reaches an agent by every route, and Remote Desktop goes straight to the target

## Cross-model review: codex-cli:gpt-6-astra (RAN — six rounds, every round's findings folded in)

Every round ran the external Codex reviewer (gpt-6-astra) with mobile-device-keys.md and native-remote-desktop-echo-mesh.md as context, plus the Standards-Conformance Gate. The Remote Desktop session (topic 131439), which owns that code, reviewed section 4.4 in round 1. An internal review in round 4 checked every claim against the source (Claude Opus 5.5) and changed four mechanisms to match how the code really works.

## ELI10 Overview

The Instar iPhone app used to know one road to an agent, its Cloudflare address. This lets it also use Tailscale, the operator's private network, and switch roads by itself when one fails. Remote Desktop gets a shorter road too: after the Studio approves a session, the phone connects straight to the machine it controls over Tailscale, skipping Cloudflare and the Studio's relay, which should cut the lag the operator reported.

Review changed the design a lot. A phone is accepted on any of its machine's own names, and a request counts only when it arrives through that machine's own Tailscale or tunnel entrance, so a moved name cannot be accepted in two places. Switching between direct and relayed reuses the existing ticket and resume steps, so the encryption sequence is never broken, and the target decides which case applies so a slow network cannot confuse it. The front's existing keepalive already ends a direct stream if the front dies, so no new heartbeat was needed. Mama PC (Tailscale on Windows, agent in WSL) needed a fix to how the desktop check recognises a local connection.

The tradeoff: route discovery trusts the front the phone used, as every call already does, and lock-screen support is not part of this.

## Original vs Converged

- **Originally**, names were listed by the server probing itself and accepted from a cached proof. **After review**, a name is listed after an outbound ping proves it, but each request is accepted only when it arrives through this machine's own front for a name still in its own configuration; outbound probe failures affect health only.
- **Originally**, the direct ticket came from the assertion redemption and switching was a new key-preserving operation. **After review**, the direct ticket comes from the existing `ticket` step with a `transport` field, and switching uses `ticket` (nothing admitted yet, ordered by a switch counter) or `resume` (fresh key), decided by the target under its lock, with stored results for lost responses.
- **Originally**, the front would rebuild its grant count and send new heartbeats. **After review**, both were removed: the existing keepalive, 20 s delegated-session expiry and 25 s quarantine already cover it.
- **Originally**, the browser could not use direct mode, then would have needed a policy change after page load. **After review**, the front serves the viewer with the direct-capable targets' origins already allowed, and the target accepts exactly the front origin bound into the signed assertion.
- **Originally**, rollback could strand a phone on Tailscale. **After review**, the app always keeps its paired host as a last-resort route.

## Iteration Summary

| Iteration | Reviewers who flagged | Material findings | Spec changes |
|-----------|-----------------------|-------------------|--------------|
| 1 | Codex (4 design), gate (1), topic 131439 (5 points) | 4 design + 3 review points | Ticket exchange via mesh, Origin binding, one transport per grant, pairing belongs to the machine, live XCUITest proof, Windows `tailscale serve`, route audit |
| 2 | Codex (3 design) | 3 design | Identity separate from health, transport operation both ways, front liveness |
| 3 | Codex (2 design, 1 precision), gate (1) | 2 design | Ordering and idempotency for switches, authoritative route snapshot, probe backoff |
| 4 | Codex (3 design), internal code review (6 design, 10 polish), gate (1) | 9 design | Rewrite against the code: ticket step, resume for switching, `arrivedOverLocalTls` at admission, viewer policy at page load, removed redundant liveness, ping-based proof, rollout by advertised support |
| 5 | Codex (4 design), gate (1) | 4 design | Target decides ticket vs resume, stored attempt results, no snapshot signing claim, paired-host fallback on rollback |
| 6 | Codex (2 design, 2 precision) | 2 design | Switch counter before admission; per-request acceptance from local-front arrival instead of outbound reachability |
| Standards-Conformance Gate | ran every round | — | all flags addressed |

Round cap: 6 (Tier 2). Stopped at the cap with every round-6 finding applied in the spec text.

## Left behind

- No seventh round on the round-6 edits (the cap). Both round-6 changes are narrow and each has a named test.
- Lock-screen support for Macs is separate work (a login-window helper), recorded on CMT-1190.

## Convergence verdict

Converged at the round cap (iteration 6) with all design findings applied. No open questions remain. Ready for approval under the standing rule that only constitution changes need the operator.
