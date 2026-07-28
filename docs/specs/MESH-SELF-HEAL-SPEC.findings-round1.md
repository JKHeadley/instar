# Round-1 convergence findings (security, scalability, adversarial, integration)

## CRITICAL / recurring themes (drive the round-2 rewrite)
- **T1 — Single fenced authority.** The lease epoch must ATOMICALLY gate poll-ownership AND spawn-ownership. Today G1/G2/G3 reach independent (and divergent-under-split-brain) conclusions → two pollers / duplicate. (Adversarial F2, F6; Security F2/F3.)
- **T2 — Three liveness signals, not one.** Split job-liveness into poll-ATTEMPTED (alive+trying → HOLD+escalate), poll-SUCCEEDED, and serve-PROGRESSED (fetched updates actually dispatched). Relinquish ONLY on LOCAL wedging, NEVER when the failure is global (Telegram down for everyone) or when poll succeeds but serve is wedged (fetched-and-dropped). (Adversarial F1 CRIT, F4 HIGH.)
- **T3 — Authenticate/allowlist every new path.** pollOwned/lastPollMonoMs signed-in-body; ownership view machine-auth-verified; forward-to-owner + lazy-load channel allowlist (SSRF), credential-enumeration exclusion. (Security F2,F3,F5.)
- **T4 — Reuse, don't reinvent.** forward-to-owner = WS1.1 dispatch seam; operator-identifier = WS2.6 user-registry; login-location = existing Playwright Profile Registry; nobody-polling dedup = WS3.3 episode key; P2 enforcement = register in STANDARDS-REGISTRY + existing /conformance/coverage audit (NOT a parallel ratchet). (Integration HIGH x4.)
- **T5 — Monotonic clocks are per-machine.** Never compare foreign monotonic stamps (max(lastPollMonoMs across pool) is WRONG). Each machine computes its OWN poll-age locally, advertises pollOwned bool + bounded age. (Scalability F2; Security F2.)

## Security (6 material): F1 self-only job-liveness; F2 sign pollOwned/lastPollMonoMs; F3 auth ownership view + allowlist forward; F4 typed login-location schema (no cookie fields) + at-rest honesty; F5 lazy-load SSRF/allowlist; F6 tombstone-nonce race for still-renewing holder.
## Scalability (11): F2 local-age not foreign-monotonic; F4 ownership check = LOCAL read not sync RPC; F5 spawn gate fail-CLOSED + bounded G2 recovery; F6 Telegram-reachability gate before relinquish; F7 startup-validated ordering pollIntervalMs<jobStaleThresholdMs<leaseTtlMs<=presumedDeadMs; F8 fail-direction table; F9 lazy-load cache/single-flight/negative-cache; F1 jobLiveness in-memory only.
## Adversarial (10): F1 CRIT symmetric-blindness global-outage double-relinquish; F2 CRIT split-brain double-poll (G3 fails open); F3 oscillation (threshold>long-poll); F4 poll!=serve liveness; F5 binding-clear strands in-flight (drain first); F6 fit-peer uses stale replicated view; F7 relinquish->reacquire gap w/F2 dark (targeted handoff nudge); F8 evaluator-stall wrongful relinquish (confirm-observations on G1 trigger); F9 nobody-polling alarm on every handoff (threshold ordering); F10 ratchet blind to ad-hoc local reads.
## Integration (13): posture table missing; one-voice nobody-polling (WS3.3); G3=WS1.1 dispatch; F3 dark->default-on migration + mixed-version tombstone(released-bit) safety; operator-id->WS2.6; login-location=Playwright registry; P2 enforcement->STANDARDS-REGISTRY+conformance audit; config-defaults/range-validation/rollback; observability(/health+audit jsonl+self-disarm); binding-clear after closeout drain; jobLiveness only for active leaseRole; laptop login prereq for §5; non-Telegram channel generalization.

## Decision-Completeness (9 material, 14 frontloaded decisions — committed defaults to BAKE IN):
- DELETE §7 Open questions; add `## Frontloaded Decisions` table.
- OQ1 jobStaleThresholdMs = pollIntervalMs(long-poll ceiling 50s) × jobStaleMissedPolls(4) ≈ 200s; startup-validated ordering vs renew-window(leaseTtl×nonRenewalMissedObs ≈360s) & presumedDead(15m); validator auto-corrects+logs (never throws).
- OQ2 nobody-polling claim = F4-preferred-if-fit, else lowest-machineId (NOT least-loaded; determinism prevents oscillation).
- OQ3 operator-identifier = field-class on EXISTING WS2.6 user-registry store (no new store/flag); inherits type-clamp/envelope/tombstone/at-rest-honesty; identity RESOLUTION stays local-authoritative (Know Your Principal).
- OQ4 browser-session ladder: holder online→route action to holder; holder offline→guided single re-auth; registry=existing Playwright Profile Registry (names only); NEVER replicate cookies.
- D5 flag names committed (jobLivenessBinding, nobodyPollingDetector, ownershipCheckedSpawn; P2=no new flag, register in STANDARDS-REGISTRY).
- D9 nobodyPollingThresholdMs=jobStaleThresholdMs; confirmObs=2 (> long-poll so single long-poll never trips).
- D13 global-blindness ⇒ HOLD not relinquish (relinquish only when staleness is LOCAL + peer observable).
- D15 spawn gate fails CLOSED on ambiguous ownership; G2 is the bounded backstop (resolves §3.3↔§4.4 contradiction).
- D16 drain-then-clear binding (after post-transfer closeout drain, turn-boundary).
- D17 tombstone adds trigger-reason as additive ignored-by-old-peers field; higher-epoch still dominates (mixed-version safe).
- D18 pollOwned/lastPollMonoMs ride the signed heartbeat envelope (reject forged-origin).
- D19 **pollOwned/lastPollMonoMs sourced from lifeline ACTUAL-poll truth (state/lifeline-poll-active.json), NOT server intent** — this is the original bug's root; load-bearing.
- Operator-only (keep deferred, NOT frontload): preferredAwakeMachineId value (=Mini); §5 live-verify go/no-go.

## Lessons-aware + Foundation Audit (11 material; 2 BLOCKING):
- C2 BLOCKING: G3 must name its foundation. Per-topic ownership-CAS = session-pool L3 which ships DARK; in the single-lease model there is no per-topic ownership. FIX: G3 gates on the FENCED AWAKE-LEASE — "spawn iff I hold the awake-lease (fenced), else forward to holder." Do NOT gate on the placement view (untrustworthy from a non-router machine — [[multimachine-placement-inference-trap]]).
- C1 BLOCKING: lease↔poll decoupling is itself the foundation flaw (overloaded lease = "I'm router" + "I'm serving"). G1 is an INTERIM binding; the structural fix is the session-pool L1(router-lease)/L3(per-conversation ownership) split. Add a Foundation note; ensure G1 converges with L1/L3, doesn't become a 3rd overloaded signal.
- B1: per-feature DEV_GATED_FEATURES/DARK_GATE_EXCLUSIONS entries; preserve/extend soloCaptainHold exclusion; F3 default-on = post-live-verify config flip on Echo pair, NOT a same-PR fleet default.
- B2: §5 needs DETERMINISTIC injected-fault seams (force jobLiveness freeze while renewal advances; force pollOwned=false both machines), BOTH-machine /health evidence, ZERO-drop assertion (not "messages flow").
- B4 MANDATORY STANDARDS (omitted): add Migration-Parity (ConfigDefaults add-missing, clobber-safe, parity test) + Agent-Awareness (generateClaudeMd/migrateClaudeMd for the new flags, status fields, kill-switches).
- C3: single-writer chokepoint for topic→session bindings (binding exists IFF live session) + wiring-integrity test.
- C4: operator-identifier rides WS2.3 hardening + at-rest honesty; P2 enforcement = CI lint (precedent lint-dev-agent-dark-gate.js) + /conformance/coverage, NOT documented-only.
- C5: G1/G2 run inside the lease tick → declare dependency on F1 bounded-await+watchdog + the out-of-process launchd watchdog as final backstop (else they share the wedge they catch).
- A1: G2's claim is real authority → route through the SAME fenced epoch-CAS + churn/dwell as F2/F4; single-claimant.

## ROUND-1 VERDICT: NOT converged. ~30 material findings. Round-2 rewrite required (foundation C1/C2 first, then liveness 3-signal model, security signing/allowlist, reuse targets, frontloaded decisions table, migration/agent-awareness/observability sections, §5 injected-fault). Cross-model: unavailable (codex not installed) — internal-only round, recorded honestly.
