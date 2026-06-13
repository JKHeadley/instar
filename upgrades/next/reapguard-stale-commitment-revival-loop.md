# Fix: stale-commitment kill→revive loop

## What Changed

The session reaper's shared guard (`ReapGuard`) had two halves that disagreed about a *stale* open commitment. The KILL decision (`evaluate()`) already treats a commitment as abandoned after 8h of topic silence and lets the idle session be reaped. But the RESUME-eligibility decision (`workEvidence()`) counted **any** open commitment as proof of interrupted work — with no staleness gate. So an idle session was killed (commitment stale ⇒ reap) and immediately revived (commitment exists ⇒ resume-eligible), in an endless loop.

This patch applies the **same 8h staleness gate** to the resume-eligibility probe that the kill decision already uses, so the two halves agree: a stale commitment neither keeps a session alive nor revives it, and a fresh one keeps the session alive so it never needs reviving. Strictly safer — it can only ever revive *less*, never more. Genuine interrupted work (a live build, an active sub-agent, a pending injection, a running process) is untouched.

## Evidence

- Live `logs/reap-log.jsonl` (2026-06-13): **13** age-limit reaps with `midWork=true`, every one carrying solely `workEvidence=[open-commitment]`, across 6 topics — and corresponding repeated `reason=age-limit` respawn entries in the resume queue (several doubled per topic). The loop, captured.
- Root cause confirmed in source: `ReapGuard.evaluate()` gates the open-commitment KEEP on `recentUserMessage(topicId, staleCommitmentWindowMs)`; `ReapGuard.workEvidence()` did not.
- New regression tests in `tests/unit/work-evidence.test.ts`: a stale commitment emits no `open-commitment` evidence (and `isMidWork`→false); a fresh one still does; an explicit `evaluate()`/`workEvidence()` consistency assertion; and the `protectOpenCommitments:false` boundary. All 22 work-evidence + 19 reap-guard unit tests green; 164 related reap/resume tests green; `tsc --noEmit` clean.
- Independent second-pass review (lifecycle change): **Concur** — confirmed the age-limit path uses the patched fallback, no legitimate revival is lost, downstream ResumeQueue / live-enqueue / boot-reconciliation re-enqueue (all `midWork`/`evidenceEligible`-gated) all behave correctly.

## What to Tell Your User

Sessions that finished their work but still had an old, untouched promise on the books were being killed and revived over and over. That loop is fixed. You'll see fewer "🪦 your session was shut down — a restart is queued" notices on topics where nothing was actually unfinished. Promises still get followed up on by the commitment system — that part is unchanged.

## Summary of New Capabilities

No new capability — this is a bugfix. It removes a spurious session kill→revive loop driven by stale (long-untouched) open commitments by aligning the reaper guard's resume-eligibility decision with its existing kill-decision staleness rule.
