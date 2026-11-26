# Side-Effects Review — phone pairing over the agent's own Tailscale name; 30-minute links

**Version / slug:** `mobile-pairing-tailscale-origin`
**Date:** `2026-11-02`
**Author:** `echo`
**Second-pass reviewer:** `independent subagent (see below)`

## Summary of the change

Implements docs/specs/mobile-pairing-tailscale-origin.md (converged in 3 rounds, approved). Files:
- `src/server/mobilePairingRoutes.ts`: `pairingOrigin()`, `relayMayBeActive()` and `redeemHostEligible()` on `MobilePairingService`. Mint chooses the running named tunnel, else a Tailscale own name this machine still configures. Mint refuses `approval-unavailable` on a machine that cannot deliver the code, refuses a Tailscale link while a backup relay may carry traffic, binds the code to `{host, kind}`, and returns `originKind`. Redeem checks host eligibility before taking the code, and after taking it requires the bound host and kind.
- `src/core/MobilePairing.ts`: codes carry `bound`; default link lifetime 10 → 30 min.
- `src/core/MobileDeviceKeys.ts`: `PENDING_TTL_MS` 15 → 30 min.
- `src/core/PostUpdateMigrator.ts`: the pairing awareness section updated, plus an idempotent in-place rewrite of the two stale lines for existing agents.
- `docs/specs/mobile-pairing-link.md`: superseding note.

Tier 2: pairing is an auth admission path. About 120 LOC across 4 source files, plus 2 new test files. Effort: spec 3 review rounds (the cap); 1 commit attempt.

## Decision-point inventory

- Mint admission (`POST /mobile/pairing-codes`) — modify — one more origin source (a Tailscale own name), plus two new refusals (approval-unavailable, relay wait).
- Redeem admission (`POST /mobile/pairing-codes/redeem`) — modify — host eligibility evaluated before the take, then the bound host/kind must match.
- Code lifetime / pending-device lifetime — modify — constants.

---

## 1. Over-block

- A phone on the tailnet redeeming a Cloudflare link while Cloudflare is down is refused (its bound host is no longer eligible). Correct: that link's address is not being served. The operator asks for a new link, which will be a Tailscale one.
- Tailscale pairing waits while the tunnel lifecycle is `relay-active` or `self-healing`, even if the relay carries no pairing traffic. This is accepted (spec §4): the relay could deliver a forged `ts.net` Host over loopback.
- Mint on a standby that has a Tailscale name is refused `approval-unavailable`. Correct: the standby cannot deliver the code.

## 2. Under-block

- Detecting a second server behind one Tailscale name stays best-effort (8 nonce pings, as for Cloudflare, mobile-pairing-link §2.2). A redeem that lands elsewhere fails as expired; no credential is mis-issued.
- Codes minted before this change carry no binding and accept any eligible host (broader than the old Cloudflare-only rule). This case cannot arise in practice: every mint now binds, and the update restarts the server, which drops older codes.

## 3. Level-of-abstraction fit

Right layer. Admission stays in the pairing service. Tailscale name identity is delegated to `MobileOwnNames` (its proof + `accepts()`), not re-implemented. Relay detection reads the existing tunnel lifecycle.

## 4. Signal vs authority compliance

- [x] Yes — but the logic is a deterministic invariant check on an auth boundary (host binding, transport, proven own name), not a judgment heuristic.

This is an authentication gate whose inputs are enumerable facts (configured names, proof results, lifecycle state). Each refusal fails closed and costs at most a new link.

## 4b. Judgment-point check

No new static heuristic at a competing-signals decision point. The origin preference (running Cloudflare, else a configured Tailscale name) is an enumerable order between two proven origins.

## 5. Interactions

- `MobileOwnNames.accepts()` lists Cloudflare names by configuration alone. `redeemHostEligible` therefore checks the kind (Tailscale only) on the own-names branch (spec §3.2).
- Device signatures after pairing are unchanged: the device's stored host is the bound host, and mobile-multi-route already accepts it.
- The approval check at mint mirrors the existing redeem check (same `approvalPath()` + `holdsLease()`).

## 6. External surfaces

The mint response gains `originKind`. Error details change wording. The app (topic 134088) can use `originKind`; redeem response shape is unchanged. Link format is unchanged.

## 6b. Operator-surface quality

No operator surface touched (no dashboard file).

## 7. Multi-machine posture

Machine-local by design. Codes are in process memory, device records and own names are per machine, and `verifySoleServer` refuses a name another machine claims. The new mint-time approval check stops a standby minting an unusable link.

## 8. Rollback cost

A revert restores named-tunnel-only pairing and 10/15-minute lifetimes. Phones already paired over a Tailscale origin keep working (their host is an own name accepted by mobile-multi-route). Existing agents' CLAUDE.md keeps the updated two lines, which then over-describe; this is harmless and corrected by the next release.

## Conclusion

Ship. The safety steps (single-use secret + confirmation code + local-TLS transport + proven own name) are unchanged or tighter.

## Evidence pointers

- Live trigger: 2026-11-02, Cirrus. Mint answered `409 stable-address-required` with a verified Tailscale own name listed, and two links expired before the operator used them.
- `tests/integration/mobile-pairing-tailscale-origin.test.ts` (9 cases), `tests/unit/mobile-pairing-tailscale-origin-awareness.test.ts` (3), and the updated `tests/unit/mobile-pairing.test.ts`.

## Second-pass review
**Reviewer:** independent subagent
**Independent read of the artifact: concur**

I read the diff against spec §3.1–3.4 directly.
- Origin choice (`pairingOrigin()`, mobilePairingRoutes.ts ~369): uses the running named tunnel first, then a Tailscale own name that passes `accepts()`, with the spec's tie-break order. It reads only config and the own-names list, and a named tunnel with no hostname falls through to Tailscale. Matches §3.1.
- Mint order: no origin → 409 `stable-address-required`; then the approval/lease check → 409 `approval-unavailable`; then the relay check for Tailscale only → 409 `address-unverified`; then the unchanged `verifySoleServer` and `proveNow` self-check; then the code is minted bound to `{host, kind}` and `originKind` is returned. A Cloudflare origin that fails its self-check is refused with no fallback to Tailscale. Matches §3.1. `lifecycleState.lastState` is the real TunnelManager field.
- Redeem (~508–537): before the take it checks local TLS, eligibility of the normalized Host, the approval/lease check and the pause check. The take is unchanged. After the take, the bound host and kind must equal the request's. `redeemHostEligible` accepts a Cloudflare host only when the configured named host matches and the tunnel is running. On the own-names branch it requires kind `tailscale` and no relay, so a configured Cloudflare own name whose tunnel is down is not eligible. Matches §3.2. The spec lists the approval check before the TLS and host checks, while the code runs it after them. Both still run before the take, so this ordering is harmless.
- Burning a link or redeeming on the wrong host: a request on an ineligible host is refused before the take, so it cannot burn a code. Burning one on an eligible but different host requires already knowing the code, and the request is then refused after the take, which is the safe direction the spec accepts. I found no path that redeems a bound code on a host other than the one it was minted for. Probe health never gates redeem.
- Migrator (PostUpdateMigrator.ts ~8762): it runs only while the stale text `Single use, 10 minutes.` is present. It replaces only the line that starts with `- Mint: ` and also contains `/mobile/pairing-codes` and the stale text, plus the line that starts with the old `409 stable-address-required` wording. The replacement lines come from the same function that `generateClaudeMd()` uses (templates.ts:1043). After one run the guard text is gone, so the rewrite is idempotent, and it reports a patch only when the content actually changed. Minor: if an operator had edited the Mint line by hand, the stale 409 line would not be rewritten. That is acceptable.
- Artifact accuracy: the claims match the code. One small inaccuracy is in §2: a code with `bound: null` keeps "any eligible host", which is broader than the old rule (Cloudflare host only). That case cannot occur in practice, because every mint now binds and the update restarts the server, which drops older codes. It is not a concern.
- Tests: `tests/unit/mobile-pairing*.test.ts` gave 14 passed out of 14 (2 files). The unit vitest config did not pick up the integration file; it has 9 cases that I did not run here.
