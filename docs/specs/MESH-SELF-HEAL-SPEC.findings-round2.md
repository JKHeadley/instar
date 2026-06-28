# Round-2 convergence findings (NEW material only — ~13, NOT converged)

## Adversarial (5):
- Adv2-F1 HIGH: single-claimant fitness uses LAGGING advertised booleans → elect-the-wrong-one (CAS proves epoch, not channel-fitness). FIX: after winning CAS, claimant RE-VERIFIES its OWN live pollSucceeded freshness before serving; on self-unfit, relinquish + re-run election excluding self (bounded by confirmObservations).
- Adv2-F2 HIGH: "global vs local" derived from peer booleans → a heartbeat-transport partition is misread as GLOBAL outage → HOLD protects a real zombie (incident reappears). FIX: GLOBAL requires POSITIVE evidence (a fresh signed heartbeat RECEIVED from >=1 live peer in-window). "I can't hear anyone" must NEVER satisfy "Telegram down for everyone" → absent peer evidence, treat pollAttempted-fresh+pollSucceeded-stale as LOCAL → proceed toward relinquish (safe), fenced CAS+G2 pick server.
- Adv2-F3 MEDIUM: drain-then-clear has a drain-NEVER-completes strand (wedged session, context-wedge/AUP death). FIX: bound drain w/ timeout; on expiry force-clear + hand queued inbound to new owner via durable queue; tie to wedge-sentinel to short-circuit a known-dead session.
- Adv2-F4 MEDIUM: all-unfit escalation speaker=lowest-machineId may be the DOWN machine → zero escalations (one-voice→no-voice). FIX: single-speaker = lowest-id among HEARTBEAT-LIVE machines only + a bounded "no escalation observed for episode within T" backstop on next-lowest live.
- Adv2-F5 LOW: "pending" selector judged from serve-side queue (the broken component) masks a serve zombie. FIX: derive "pending" from poll/fetch side (getUpdates returned >=1 update, offset not advanced), not serve-queue depth.

## Integration (4):
- Int2-A HIGH (reuse): G2 reinvents EXISTING src/core/pollerCount.ts (B5) — already computes nobody-polling (ok/dual/silence/indeterminate) from pollingActive truth, wired in routes.ts. FIX: G2 reduces over PollerCountResult; B5 `indeterminate`→fail-CLOSED-no-claim; B5 `dual`→VETO a G2 claim (claiming into dual = the 409-war).
- Int2-B HIGH (actuation seam): G2 wins fenced-CAS but spec never says how that STARTS winner's getUpdates / STOPS loser's. Existing lever = poll-follows-lease / effectivePollIntent / intentShouldPoll in TelegramLifeline.ts (dry-run). FIX: name it as G2/G3's actuation seam; post-claim live-verify that winner's lifeline-poll-active.json ADVANCES (FD10 recurring on actuation side).
- Int2-C MEDIUM: FD2 arithmetic wrong — leaseTtlMs=90000 × nonRenewalMissedObs=6 = 540s NOT 360s. Conclusion holds (200<540<=900) but fix the literal or derive symbolically.
- Int2-D LOW: serveProgressedMonoMs has no named truth source (unlike pollAttempted/Succeeded→lifeline-poll-active.json) AND serving is a different PROCESS than the lifeline poll process → 3 signals not co-located. FIX: name serve-progress source (WS1.1 dispatch / durable-queue enqueue); confirm readable in the process that makes the relinquish decision.

## Security (4):
- Sec2-F1 MEDIUM: handoff-hint (§3.1) not stated to ride the signed tombstone envelope → forged hint nudges an unfit peer / steers away from G2 claimant. FIX: hint is a field INSIDE the signed tombstone, advisory-only; recipient still runs G2 fitness + fenced CAS (hint never substitutes for §3.2 single-claimant).
- Sec2-F2 MEDIUM: lazy-load location-cache write integrity unstated; negative-cache = denial vector. FIX: only machine-auth-verified resolutions populate cache; short negative-cache TTL; on cache-target auth-fail at fetch, invalidate+re-resolve once (don't fail whole request).
- Sec2-F3 LOW/MED: operator phone = higher-sensitivity directly-actionable PII landing plaintext on every pool machine incl cloud VM. FIX: opt-in / exclude operator-identifier replication onto non-physically-controlled ropes, OR explicit WS2.3-style disclosure that enabling P2 pushes the phone everywhere.
- Sec2-F4 LOW: §3.5(4) runtime probe logging could capture sensitive paths. FIX: log registration-status + path CLASS, never raw resource contents (mirror "matched-pattern names only" posture).

## Scalability: 0 new (clean). Minor non-material: episode-key dedup TTL; runtime-probe log dedup.

## VERDICT round 2: NOT converged (~13 new material). Round-3 targeted edit needed. NOTE: decision-completeness + lessons-aware reviewers NOT yet run for round 2 — run on the round-3 spec. Cross-model still unavailable.
