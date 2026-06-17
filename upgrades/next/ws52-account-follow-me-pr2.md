## What Changed

WS5.2 Account Follow-Me, PR2 — the cross-machine enrollment **detection→consent surface** (Mechanism B re-mint). When the agent runs on more than one machine and a machine has no usable account for an operator subscription (a "depth-zero" machine), it now proactively detects that and surfaces ONE aggregated, phone-first consent ("authorize on the dashboard?") — and **enrolls nothing on its own**. Authorization remains the operator's PIN-gated mandate (issued on the target's own dashboard, per-server per OQ6); a peer can never enroll an account onto itself.

Built on PR1's primitives: the request-never-self-authorize orchestrator, the depth-zero detector (R7-bounded), the per-machine depth adapter, the tolerant peer-views fetcher (reuses the `?scope=pool` fan-out, metadata-only — no token or config-home ever crosses), the cross-machine mandate bridge (R4a), and the composing service. Wired through `server.ts`/`AgentServer`/`RouteContext` and exposed at `POST /subscription-pool/follow-me/scan`. Ships DARK behind `multiMachine.accountFollowMe` (503 on the fleet, live on a development agent).

## Evidence

- 37 tests: 35 unit across 7 modules + 2 Tier-2 integration over the real HTTP pipeline (dark→503; enabled→detects a depth-zero peer→ONE consent, enrolls nothing); `tsc --noEmit` clean.
- Side-effects review + mandatory independent second-pass security review (concurred) — verified no self-authorization path, no credential leak (peer fetch is metadata-only, configHome discarded), genuinely-inert fleet default, and no fail-open paths. Artifact: `upgrades/side-effects/ws52-account-follow-me-pr2.md`.
- Spec: `docs/specs/ws52-account-follow-me-security.md` (converged, approved).

## What to Tell Your User

Still nothing to do yet — this is the next layer toward "log in once, it works on every machine," shipped off by default. With it, when one of your machines has no account, I'll notice and offer you a one-tap dashboard approval to enroll it (rather than ever doing it silently) — and no login token is copied between machines. The actual one-tap enrollment + safety checks land in the next PR.

## Summary of New Capabilities

Proactive cross-machine account-enrollment detection + consent (dark): the agent detects a machine with no usable account and surfaces ONE operator approval, enrolling nothing on its own. No user-facing surface is live in this release.
