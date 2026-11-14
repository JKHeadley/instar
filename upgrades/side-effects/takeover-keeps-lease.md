# Side effects: takeover-keeps-lease

**Change.** The takeover switch (`multiMachine.leaseSelfHeal.soloCaptainHold.enabled`) now enrolls the existing holder-only lease renewal timer, as a Telegram adapter or native app conversations already do. The solo-captain hold log line prints once per hold instead of on every renewal.

**Why.** Takeover drill on the test pair, 2026-11-05. The standby took the lease 48 s after the holder was killed, but it was built by join and has no conversation surface, so nothing enrolled the timer. It renewed only on the 2-minute heartbeat against a 60-second lease: holder for 60 s of every 120 s, epoch climbing every tick (72 to 91 in 38 minutes). With the timer switched on by hand the epoch stayed flat, read live.

**Reach.** Only machines with the takeover switch on. It is off by default on every non-development agent and is set only by hand today. A development agent already resolves this timer on. Single-machine agents never enable the switch; if one did, the timer renews a lease nobody contests, which is what a Telegram agent does already.

**Over-block and under-block.** No gate changes. The timer never acquires, stops the moment a higher epoch is seen, respects an explicit `resilientRenew.enabled:false`, and an observe-only machine still never renews (existing tests cover each with the same carrier). The renewal path itself is untouched.

**Failure.** If the enrollment is missing the behaviour returns to today's: a climbing epoch and a half-time holder. The e2e test holds a real lease past its window with this dependency and asserts an unchanged epoch.

**Log change.** A hold logged every 30 s would add about 2,880 lines a day to a machine holding alone. The line now prints when a hold begins, and again if a hold ends and another begins. The evidence row for a hold already worked this way.

**Rollback.** Revert the commit, or set the switch off. Neither leaves state behind.

**Known limit.** This does not make takeover default-on. That is step 3 in `docs/specs/session-pool-default-on.md`.
