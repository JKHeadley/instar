# Convergence Report — Mesh Endpoint HTTP Propagation

**Spec:** `docs/specs/mesh-endpoint-http-propagation.md`
**Slug:** `mesh-endpoint-http-propagation`
**Rounds to convergence:** 3
**Outcome:** CONVERGED — zero remaining material/design findings.
**Author:** Echo (autonomous mesh-robustness mission, topic 27515)

## ELI10 — what converged and why it matters

On a personal 2-machine setup (Laptop + Mac Mini) with no shared git channel, the two machines
never tell each other their *fast* network addresses (Tailscale / LAN). The only sync medium for
peer addresses is a git commit-and-push channel that a personal `LocalLeaseStore` setup doesn't
use — so each machine only ever learns the peer's **flaky Cloudflare** address (recorded once at
pairing). The lease layer is then forced onto that one flaky rope; a Cloudflare hiccup makes the
real lease-holder briefly believe it *lost* the lease (`holdsLease=false`), the liveness reconciler
sees `blocked-not-owner` and refuses to revive a reaped autonomous session, and the user's session
dies silently. This is the verified through-line of the multi-day topic-27515 incident (a 6-hour
overnight silence, "session stopped" dead-ends, the Mini "owning" a topic with no live session).

The fix carries each machine's **validated self-endpoints inside the already-signed lease RPC body**
(`/api/lease` broadcast + `/api/lease/pull`), and the receiver type-clamps/validates them and records
them via `updateMachineEndpoints` — idempotently (no-op when unchanged). It is purely additive and
gated behind `multiMachine.meshTransport.enabled`; worst case is exactly today's Cloudflare-only
behavior. Once peers learn each other's fast ropes, the lease stops depending on Cloudflare and the
self-fence → death-loop stops at the source.

## Review history (convergence trend: design-defect → precision → clean)

- **Round 1** — 8 reviewers (6 internal angles via workflow `wf_6efac414-bbb` + codex-cli `gpt-5.5`
  and gemini-cli `gemini-2.5-pro`). 5/6 internal had material findings; lessons-aware CLEAN.
  **Biggest correction (real design defect):** the carrier was wrong — the original design used
  `/api/heartbeat`, whose cross-machine sender does not run on this git-less setup. Corrected to the
  signed `/api/lease` + `/api/lease/pull` RPC (verified via `HttpLeaseTransport.ts`), which makes the
  propagation bidirectional AND cryptographically signed for free.
- **Round 2** — internal workflow `w86se9lcc` + externals (round 2). 3 internal CLEAN
  (scalability/integration/lessons-aware), 3 material-but-**precision-only**
  (security/adversarial/decision-completeness); both externals MINOR. Reviewers independently caught
  the pull-RESPONSE correctness gap also spotted in the live server logs. All folded into round-3
  spec edits (shared `MeshEndpointValidator` extraction, batch-size reject before the loop, URL
  normalization before `endpointsEqual`, empty-array=no-op, MAX_ENDPOINTS const, pull-response
  identity binding, framing fix). New body hash `1a7823abb01a`.
- **Round 3 (convergence confirmation)** — a focused adversarial + decision-completeness reviewer
  pass that **verified every named code anchor against the actual source**. Verdict: **CONVERGED,
  zero material findings.** Two build-easing precision notes only:
  1. The per-kind host rules (`hostOf`, `ipv4ToInt`, `isTailscaleCgnat`, `isRfc1918`,
     `isForbiddenHost`, `isPublicHttps`, `PeerEndpointResolver.ts:319-389`) are already module-level
     **exported pure functions** — the shared `MeshEndpointValidator` *composes* them rather than
     *extracts* them (strictly easier; spec updated to say so).
  2. `updateMachineEndpoints` (`MachineIdentity.ts:510-516`) DOES unconditionally bump `lastSeen` +
     `saveRegistry`, so the load-bearing no-op guarantee is to **skip the call entirely when
     unchanged** (the primary path), NOT to gate `lastSeen` inside the writer (spec updated to make
     the skip-the-call path primary).

  Both notes were folded into the spec as reviewer-confirmed build clarifications (build-easing, not
  design changes).

## Adversarial probe results (round 3)

- **Security — sound.** `/api/lease` is holder-match-gated; `/api/lease/pull` request binds to the
  authenticated puller; the pull-RESPONSE binds via the existing signed accept-ack `machineId`
  (Frontloaded Decision 9), not a self-asserted body field. A compromised responder can only inject
  endpoints into *its own* registry entry, and those must still pass per-kind host validation — no
  third-machine injection. `isForbiddenHost` covers 127/8, 169.254/16 (incl. the 169.254.169.254
  metadata host), 0/8, localhost, ::1, 0.0.0.0. The code comment confirms the model:
  "accept-ack's responder-identity verification is the load-bearing defense; a spoofed endpoint
  becomes a FAILED rope, never trusted."
- **Correctness — sound.** Idempotency (skip-the-call when unchanged), authority (peer endpoints
  never override self-endpoints), empty/absent/non-array = no-op (never a wipe), MAX_ENDPOINTS bound
  applied before the per-element loop, url length bound, URL normalization before `endpointsEqual`.
- **Design — sound.** Carrier = lease RPC (correct for git-less `LocalLeaseStore`), bootstrap honesty
  (needs ≥1 Cloudflare lease RPC to start), no strand on topic transfer (machine-identity facts, not
  topic state), purely additive.
- **Build-readiness — sufficient.** All named anchors (lease handlers in `machineRoutes.ts`, the
  exported host-rule functions, `HttpLeaseTransport` sender body, `updateMachineEndpoints`,
  `endpointsEqual`, `getMachineEndpoints`, `MeshEndpoint` type) verify against the actual source.

## Cross-model review posture

External (non-Claude) reviewers ran in rounds 1 and 2: codex-cli `gpt-5.5` and gemini-cli
`gemini-2.5-pro`, both returning MINOR findings that were folded. Round 3 was a single-reviewer
convergence-confirmation pass (post-respawn; the prior session's round-3 background reviewers were
orphaned by a context-window respawn). The cross-model opinion is recorded on the spec frontmatter.

## Next step

`/instar-dev` build (receiver + sender, 3-tier tests + regression, side-effects artifact) → PR to
canonical `JKHeadley/main`. The change ships dark/flagged behind `multiMachine.meshTransport.enabled`.
