# Convergence Report — Proactive Growth Digest Publisher (Slice 2)

Spec: `docs/specs/PROACTIVE-GROWTH-DIGEST-PUBLISHER-SLICE2-SPEC.md`
Converged at iteration **3**. Panel: security, scalability, adversarial,
integration, lessons-aware (internal Claude subagents) + gemini (external
cross-model). Origin commitment: CMT-1151.

## ELI10 Overview

Echo already has a "growth analyst" that quietly watches your projects — what's
stalling, what dark feature has earned its way to "turn it on," how often you
change a spec the same way, how often you correct Echo. It computes all that, but
it never *tells* you anything. This change builds the part that speaks: a small
component that, on a schedule (default Monday 11am), takes the analyst's
already-computed picture, writes ONE short "growth check-in," and posts it to your
Agent Updates topic on Telegram. No new watching — just a voice for the analysis
that's already running.

It's careful about noise. On a quiet week with nothing to act on, it stays silent
by default (you killed the burn alerts for being noisy; a weekly "all healthy"
would be the same mistake). The big lists (you have 205 stalling initiatives today)
get summarized to the top few with a "+200 more," while the important items
(promote-this, a misconfigured dark feature) are always shown in full. And it can
never block or rewrite anything — it only sends a message or stays quiet.

It ships **off**, then goes to **dry-run on Echo only** (it logs the exact message
it *would* send so you can read a real sample without being buzzed), then **live**
after you approve the sample. The fleet stays off. The feature follows the same
maturity path it reports on.

## Original vs Converged

The first draft had the right shape but three real gaps that the review caught:

1. **It would have double-sent on your two-machine setup.** The job it replaces ran
   only on the "awake" machine; an in-process timer runs on *both*. Converged: the
   publisher only sends from the machine holding the lease (`isAwake` gate),
   mirroring the precedent already used by the scheduler and ActivitySentinel.

2. **It could have quietly grown a second, unguarded send path.** The "is this
   message OK to send" guard (dedup + spam-budget + tone) was tangled into the web
   handler. The draft hand-waved "just reuse it." Converged: we carve out a pure
   `evaluateOutbound` function that both the web route and the publisher call, with
   a test that asserts they call the *identical* function — one chokepoint, not two.

3. **A weekly "all healthy" message would re-create the noise you rejected.**
   Converged: quiet weeks are silent by default; you opt into a heartbeat if you
   ever want one. The analyst still computes everything; only the *no-action send*
   is suppressed.

Plus hardening: cron re-entrancy/overlap protection, a sanity-floor that refuses a
misconfigured sub-hourly cadence (the digest is a heavy synchronous pass),
catch-up after the laptop was asleep at fire time (so the check-in isn't silently
skipped for a week), timezone correctness, a render-boundary secret-scrub for the
push channel, never-truncate-critical findings, and a durable supersede of the old
initiative-digest job (flip it off in the *source template*, not the deployed copy
that an update would overwrite). A final mechanical fix corrected a wrong
coordinator API name in the wiring snippet (a getter, not a method), caught by the
integration reviewer reading the real code.

## Iteration Summary

| Iteration | Reviewers who flagged material issues | Material findings | Spec changes |
|-----------|----------------------------------------|-------------------|--------------|
| 1 | integration (SERIOUS), security, scalability, adversarial, lessons-aware, gemini | 1 serious + ~11 minor/medium (high consensus on 3) | Added §3.7 multi-machine lease gate; §3.3 pure res-free `evaluateOutbound` funnel; §3.4 `digestSendOnCalmWeeks:false`; cron `protect`/`unref` + in-flight guard; cadence sanity-floor; missed-run catch-up; timezone; render-scrub + ≤200-char cap + priority-never-truncate; durable+atomic supersede; types.ts/teardown |
| 2 | integration (1 material: wrong coordinator API) | 1 material + 3 non-blocking notes | Corrected `isAwake` getter + `options.coordinator` + `.enabled` gate; concrete construction predicate; observer-placement note; 60s settle-delay + post-lease window-key; §3.7 bounded-handoff-resend note |
| 3 | (converged) | 0 | none |

## Full Findings Catalog

### Iteration 1

**SERIOUS — Integration: multi-machine double-send.** In-process croner runs on
awake AND standby machines; the superseded job was scheduler-lease-gated
(`server.ts:3801`). → §3.7 lease gate (`isAwake` dep, `skipped-standby` audit),
precedent ActivitySentinel `server.ts:5730`; wiring test asserts standby → zero
sends.

**Medium/consensus — Security #2 / Integration / Lessons F2: `checkOutboundMessage`
is `res`-coupled.** The funnel extraction must split a pure `evaluateOutbound →
{ok,reason}` from the response-writing or the publisher grows a second un-guarded
send path. → §3.3 rewritten with the pure-funnel contract + wiring-integrity test
(identical `evaluateOutbound`, not two copies).

**Medium/consensus — Adversarial #2 / Lessons F1: calm-week weekly nag.** Default
`digestEvenWhenCalm:true` → a no-action "all healthy" every week = the noise
burnDetection was killed for. → §3.4 `digestSendOnCalmWeeks:false` (delivery-level,
decoupled from the analyst's API-level calm render); §3.1 `skipped-calm`; §4.6.

**Scalability S1 — cron re-entrancy.** → `new Cron(cron, {protect:true,unref:true},
…)` + in-flight guard (`skipped-overlap`).
**Scalability S2 — buildDigest is sync/heavy (~8 tracker scans + journal rewrite);
misconfigured per-minute cadence churns disk/CPU.** → §3.4 cadence sanity-floor
(refuse <1h between fires).
**Scalability S3 / Gemini — missed-run after sleep silently dropped.** → §3.1
catch-up on `.start()` via `previousRun()`, idempotent window-key.
**Scalability S4 / Gemini #1 — timezone unspecified.** → `digestTimezone` dep,
same zone for cron fire + render.
**Security #1 — push channel needs its own scrub.** → §3.2 `scrubSecrets()` at
render boundary + hard ≤200-char detail cap (covers dry-run text).
**Security #3 — cap-before-concat.** → §3.2 stops appending near 4096, never
materializes the full string.
**Gemini #2 / parent §10 Q3 — critical findings hidden by cap.** → §3.2 priority-
never-truncate (R1/R6/high always full; cap only low/normal bulk).
**Integration NOTE / Lessons F3 — supersede durability + atomicity.** Deployed-
manifest disable reverts on update; the job collides Mon 11:00. → §3.5 disable in
SOURCE template + atomic with live-flip + one-time signal if still enabled.
**Integration — add `digestDelivery` to types.ts; teardown `.stop()`.** → §3.4/§3.6.

### Iteration 2

**Material — Integration: wrong coordinator API in wiring snippet.**
`coordinator.isAwake()` called as a method (it's a getter `get isAwake()`) and via
`this.coordinator` (it's `options.coordinator`). Would not compile. → §3.6/§3.7
corrected to `isAwake: () => options.coordinator?.enabled ? options.coordinator.isAwake
: true`, matching `server.ts` precedents; construction gate made concrete
(`analyst && digestDelivery !== 'off'`, telegram availability at send-time).

Non-blocking notes folded in: observer placement (`observeSelfViolation`/
`observePrincipalCoherence` stay route-side — §3.3); concrete 60s settle-delay +
window-key only post-lease (§3.1); §3.7 bounded-handoff-resend disclosure.

### Iteration 3

All five internal reviewers + gemini: **CONVERGED.** Integration verified the
coordinator API fix against real code (`MultiMachineCoordinator.ts:160` getter,
`server.ts` getter-style callsites). Lessons-aware confirmed the bounded-handoff-
resend tradeoff is defensible against the anti-flood lessons (single bounded
re-send through the aggregating/budgeted/deduped funnel, biased toward the slice's
reason to exist — delivery over silence). No material findings.

## Convergence verdict

**Converged at iteration 3. No material findings in the final round.** The spec is
ready for operator review and approval. Approval (`approved: true`) is the
operator's structural step; this report and the `review-convergence` tag are
written by /spec-converge.
