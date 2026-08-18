# Side-Effects Review — Duplicate-session stand-down (cooperative quiescence)

**Version / slug:** `duplicate-session-standdown`
**Date:** `2026-08-18`
**Author:** `Echo`
**Second-pass reviewer:** `required and performed — five adversarial rounds plus a closing verification pass (block/allow on tool calls AND outbound sends, plus session lifecycle: three separate Phase-5 triggers). Findings per round: 8 / 9 / 9 / 9 / 13 — 48 in all, every one fixed; rounds 2-4 each contained a critical, round 5 contained none (the convergence signal under the operator's 80/20 standard). The closing pass verified the round-5 fixes item by item.`

## Summary of the change

When one conversation has live sessions on two of my machines, the losing copy is now asked to STAND DOWN rather than killed. It stops starting new tool calls (a PreToolUse `*` hook blocks everything outside a four-tool observation-local allowlist), its outbound sends to that conversation are refused `409 standing-down`, it finishes the step it holds, and a bounded drained-close retires it once drain is corroborated. This replaces the terminate primitive that round-4 review rejected (symmetric split-brain lets BOTH machines kill their own copy; a succeeding kill resets every brake, so an undiagnosed creation cause becomes an unbounded kill/respawn loop; a mid-tool-call kill destroys in-flight work).

Files: new `src/core/StandDownRegistry.ts` (durable machine-local enforcement record + episode latches + hook marker file), `src/core/StandDownAudit.ts` (coalescing JSONL sink), `src/core/standDownDrain.ts` (the corroborated drain predicate + the frozen bypass constants); modified `src/monitoring/SessionReaper.ts` (producer on the vetoed-closeout path, per-tick maintenance, drained-close, owner-scoped dwell), `src/core/SessionManager.ts` (verified `standDownDrainedClose` option + drain observation I/O), `src/server/routes.ts` (`POST /standdown/evaluate`, `GET /standdown`, operator-release, and the voice-half refusal in `/telegram/reply/:topicId`), `src/core/deliverToConversation.ts` (minted-id arm), `src/monitoring/PresenceProxy.ts` (honest standby line), `src/monitoring/delivery-failure-sentinel/recovery-policy.ts` + `delivery-failure-sentinel.ts` (`finalize-standing-down`), `src/core/instarSettingsHooks.ts` + `src/commands/init.ts` + `src/core/PostUpdateMigrator.ts` (the `*`-matcher canonical set, its shared ensure function, the guard script body, and the CLAUDE.md sections), `src/core/types.ts` + `src/config/ConfigDefaults.ts` + `src/core/devGatedFeatures.ts` (`monitoring.standDown`), `src/commands/server.ts` (composition root).

**Five rounds of independent second-pass review produced 48 findings (plus 3 I found while building — 51 changes in all).** They are listed at the end of §Conclusion rather than buried, because most were defects that would have shipped as reassuring no-ops — including a round-4 cluster in which three individually-survivable defects combined to let a genuinely WORKING session be declared drained and closed — the exact harm the rejected terminate primitive was rejected FOR — and three that each made the feature structurally incapable of doing its job at all: the hook read the marker file from a path nothing writes, the drain counter counted REQUESTED calls rather than completed ones, and the hook authenticated with the externalized-secret MARKER (`Bearer [object Object]`) so every evaluate call 401'd into the fail-open path.

**One correction to the spec, made honestly rather than silently.** The spec's §Rollout says the predecessor's `closeoutActivenessBypass` "CODE default flips to false, and `migrateConfig` rewrites a persisted `true`". I checked before building it: that predecessor NEVER SHIPPED — `git log -S closeoutActivenessBypass` on `JKHeadley/main` is empty, the key appears in no config on disk, and the only implementation was uncommitted work in this worktree. There is therefore nothing to retire and no persisted value to migrate. Building a migration for a config key that never existed would be theatre that reads as diligence. The uncommitted terminate primitive was discarded; only `validateConfirmedMoveAssertion` (which the spec reuses as its admission bar) was carried forward.

## Decision-point inventory

- `standdown-guard.js` "block this tool call?" — **add** — marker-file + registry lookup, code-owned allowlist, fail-OPEN on every uncertainty. The AUTHORITY is the server's registry entry; the hook is a thin deterministic enforcement point.
- `/telegram/reply/:topicId` "refuse this send?" — **add** — in-process topic-keyed lookup plus a fire-time ownership re-check. Deterministic, not LLM-gated.
- `deliverToConversation` (id<0) "refuse this send?" — **add** — the same lookup for minted (Slack) conversations, which never traverse the Telegram route.
- `SessionReaper` closeout "register a stand-down?" — **add** — fires ONLY where today's closeout already failed (a vetoed terminate), gated on the existing liveness+dwell+freshest-interaction preconditions.
- `SessionReaper` "is the session drained?" — **add** — corroborated multi-signal predicate; every uncertainty resolves to NOT drained.
- `SessionManager.terminate` bypass assembly — **modify** — one new named bypass, applied only after the authority's OWN probe confirms the `drained` state.
- `recovery-policy` 409 classification — **modify** — `standing-down` becomes terminal-and-silent instead of terminal-and-escalating.
- `SessionReaper` topic-moved dwell — **modify** — now owner-scoped (an owner change resets the count).
- `ReapGuard` — **pass-through** — unchanged; the drained-close uses its existing `bypassedReasons` mechanism.

---

## 1. Over-block

**What legitimate inputs does this change reject that it shouldn't?**

Three real ones, each bounded:

1. **A muzzled session's genuinely-useful tool call.** If the ownership record is WRONG (this machine really is the right one to answer), the muzzle blocks legitimate work. Bounded by: the cadence re-verify releases within ~2 ticks of the record correcting itself; the fire-time ownership re-check at the send funnel releases the entry the instant ownership returns, without waiting for the hysteresis; and every hook uncertainty fails open. Not bounded by: nothing releases a muzzle whose record stays wrong — that is what the TTL + attention item exist for, and it is why expiry freezes rather than escalating to a kill.
2. **An outbound send from a legitimate NON-duplicate caller to a muzzled topic.** The refusal is TOPIC-keyed, not sender-keyed, so ANY caller sending to that topic on that machine is refused — including a background job that has a genuine reason to post. Accepted deliberately: this route carries no authenticated session identity (`metadata` is caller-supplied), so keying on a claimed sender would be attribution dressed as authentication. The internal deterministic senders (reap-notify, cold-start lifeline fallback, owner-dark ladder) call `telegram.sendToTopic` directly and are exempt by construction, which is what keeps genuine system notices flowing.
3. **A PROTECTED session — RESOLVED, was a real defect.** Registration fired on every non-terminated closeout attempt, and the terminate authority returns `skipped: 'protected'` for a protected session, so a session on the operator's never-touch list would have had its tools blocked and its voice refused — and, because `protected` is in `DRAINED_CLOSE_NEVER_BYPASSED`, it could never be drain-closed either. It would have ridden the TTL into the frozen state. `#registerStandDown` now consults `protectedSessions()` and refuses with a named `protected` reason before anything else.

4. **An unresolvable ownership read at the send funnel — RESOLVED, the fail direction was inverted.** The fire-time re-check refused when `sessionOwnershipRegistry` or `meshSelfId` was null, because only a *thrown* error hit the fail-open catch. An infrastructure gap would have looked like a duplicate and silenced a legitimate reply. Now an unresolvable read RELEASES, consistent with the spec's rule for this decision and with the reverify leg.

5. **A `Write` that was pure note-taking.** The allowlist deliberately excludes file mutation, so a muzzled session cannot even write a scratch file. Accepted: an unmatched `Write` could rewrite the guard script itself, and "action" has to include disk.

---

## 2. Under-block

**What failure modes does this still miss?**

1. **Non-claude frameworks keep their tools.** `installCodexHooks` is a separate path; codex/gemini/pi/grok duplicates are muzzled on VOICE immediately and on TOOLS not at all in v1. Declared in the spec's coverage matrix and tracked as CMT-2031, not a silent gap.
2. **Drain is unprovable outside claude-code**, so those entries never reach `drained` and ride the shorter TTL to the operator instead of closing themselves. Deliberate: a fabricated drain observation would close a session on no evidence.
3. **A cooperating-but-noncompliant model.** The hook stops tool calls; it cannot stop a model from *reasoning*. If the model never stops retrying, the block-echo drain signal is what lets it converge anyway — but a model that finds an un-blocked side channel (an allowlisted `Read` loop) is not stopped. Bounded by the TTL.
4. **The boot fail-open window.** A corrupt durable registry starts EMPTY, so for the minutes until the producers re-derive their verdicts nothing is enforced. This is the pre-existing status quo, never a new leak — and it now raises one attention item and a `degradedBoot` row on `GET /standdown` rather than being silent.
5. **The minted-id (Slack) refusal arm is structurally unreachable in v1 — DECLARED, not fixed.** Entries are only produced with a topicId resolved through the Telegram session→topic binding, so no negative minted id can ever appear in the registry and the Slack arm's lookup can never find anything. The seam stays wired (it is the correct shape for the day a producer covers Slack-bound sessions, and costs one map read), but it is NOT live parity with the Telegram arm and this artifact no longer claims it is. A Slack-bound duplicate in v1 is muzzled on NEITHER half — same declared-gap class as the non-claude frameworks. <!-- tracked: CMT-2031 -->

6. **Worktree sessions — PARTIALLY resolved, and the earlier wording here overstated it.** The hook resolved `.instar/config.json` and the marker from `CLAUDE_PROJECT_DIR`, but a worktree checkout has neither, so the read failed and the guard exited 0 — for exactly the sessions doing mutating work. `INSTAR_AGENT_HOME` is now injected at every spawn site and the hook prefers it for both reads. What that does NOT fix, and what the first version of this paragraph wrongly implied was closed: the settings entry still resolves the guard SCRIPT itself from `${CLAUDE_PROJECT_DIR}/.instar/hooks/instar/standdown-guard.js`, so in a worktree that does not carry `.instar/hooks/` the hook never executes and no env var can help. This agent's own dogfood repo tracks `.instar/hooks/`, which is exactly why the gap reads as closed here and would not be closed on a fleet agent. The voice half is unaffected (it is server-side). Declared, not silently carried. <!-- tracked: CMT-2031 -->

7. **A partition can produce two speaking copies.** Chosen deliberately (see §7).

---

## 3. Level-of-abstraction fit

The split is deliberate and, I think, the load-bearing design decision:

- **The hook is a low-level enforcement point with NO judgement.** It reads a marker, asks the server, and obeys. It cannot decide anything about ownership.
- **The registry is an ENFORCEMENT CACHE, not an authority.** It is named that way in the module docstring because the temptation to treat it as the answer to "who owns this conversation?" is exactly the mistake that would make it dangerous. The authority lives in the replicated ownership records and the duplicate reconciler's evidence ladder; the cadence re-verify keeps the cache a mirror with bounded staleness.
- **The producer sits at the seam where the EXISTING authority already failed.** It does not add a new detector for "is this a duplicate?" — it consumes the closeout's already-validated liveness+dwell+ownership verdict and acts only when that verdict's chosen remedy (terminate) was refused.

A lower-level primitive existed and is used rather than re-implemented: `ReapGuard`'s `bypassedReasons` cascade. A higher-level gate existed and is fed rather than paralleled: the closeout itself.

---

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [x] **No — this change produces a signal consumed by an existing smart gate** (the producer half), **and its blocking half is deterministic enforcement of a verdict computed elsewhere, not a new detector with authority.**

The hook and the funnels DO block. They are not brittle detectors granted authority: neither computes whether a duplicate exists. Both look up a record whose creation required an evidence chain that is CHECKED, not merely upstream. The review found the original wording overstated this: the freshest-interaction leg was selecting a different flag, not gating registration, and `validateConfirmedMoveAssertion` — which the spec's Frontloaded Decision 5 names as "the single admission bar" — had zero callsites. Registration now genuinely routes through it, so at the point of use the code verifies trusted local identity (never self-report), `self-is-owner`, the freshest-interaction invariant, the dwell against the threshold in force, and the AGE of the liveness proof itself — the last of which nothing else covers, and which stops a snapshot that went stale while the owner died from admitting a muzzle. Each refusal is named. The brittle-detector-with-authority antipattern is "a cheap check decides to block"; here a cheap check *executes* a decision an expensive, corroborated, independently-revalidated path already made, and every failure mode of the cheap check resolves to ALLOW.

The one place a caller could have smuggled authority — the terminate bypass — was specifically designed against: the reaper passes `standDownDrainedClose: true` (a claim), and `SessionManager` confirms it against its own `standDownDrainProbe` before applying its OWN frozen three-reason list. A caller cannot name keep-reasons. An integration test asserts the call carries no `bypassedReasons` property.

---

## 4b. Judgment-point check (Judgment Within Floors standard)

No new static heuristic at a competing-signals decision point.

Every decision this change adds is an INVARIANT in the spec's own classification, and each is conservative in the same direction: registration requires the predecessor's validated evidence chain and refuses on contested work; the hook's allowlist is code-owned and unknown-means-blocked; drain requires positive corroboration on four legs with every uncertainty resolving to "wait"; release fails toward RELEASE on every uncertainty.

The ONE genuine competing-signals question — *what should happen to a muzzled session that never drains?* — is explicitly NOT answered by a heuristic. It goes to the operator via an attention item, floored at zero destruction (both halves stay enforced, nothing is killed, nothing is deleted) with a deterministic terminal rung (hold frozen, do nothing further). That is a floor + human arbiter, declared in the spec's `## Decision points touched` table as a judgment-candidate.

---

## 5. Interactions

- **Shadowing.** The voice-half check runs in `/telegram/reply/:topicId` AFTER the topicId/text validation and BEFORE the invisible-payload guard and the tone gate. A 409 therefore short-circuits the tone gate for that send — correct, because the send is not going to the user at all. It cannot shadow the negative-topicId guard (that returns first). The stand-down maintenance pass runs BEFORE the per-session closeout loop each tick, deliberately: a released entry must not then be drained or closed on a verdict that no longer holds.
- **Double-fire.** The closeout and the stand-down could both act on the same session in one tick. Resolved explicitly: `#standDownTick` returns the set of sessions it closed and the closeout loop skips them. Without this, a drained close would be followed by a terminate on an already-dead session, an `already-terminal` veto, and a fresh (misleading) stand-down registration — one wasted register/close cycle per close. The integration test pins the clean-close outcome.
- **Races.** The registry is single-writer in the server process, so the funnels and the reaper share it synchronously with no lock. The marker file is read from OTHER processes on every tool call, so every write is write-temp+rename and a torn read fails open. `PresenceProxy` and this feature both emit per-topic user-facing lines; the stand-down's line rides the per-episode notice budget and the proxy consults the registry FIRST, so a muzzled topic gets ONE honest line instead of a stream of "actively working".
- **The honest line's budget was consulted nowhere — RESOLVED twice.** Round 4 moved the line onto the deterministic send path but claimed the budget only after success without ever READING it first, so it went out on every tier emission — "at most once per episode" was the comment over a loop, and the deterministic path bypasses the reply-route duplicate suppression that would have absorbed the repeats. A non-consuming `hasNotice` read now gates the send, and the claim still commits only on success.
- **Two audiences, one budget — RESOLVED.** The per-episode notice budget was shared between the tmux line injected into the muzzled session and the user-facing standby line, so whichever fired first permanently silenced the other: a divert could leave the USER with nothing, which is the exact silence this design exists to prevent. The budgets are now per channel.
- **Swallowed exceptions.** The maintenance pass is wrapped so remediation for a duplicate can never take down the reaper's primary job. That wrapper also hid a broken test seam through three runs of the integration suite, so it now logs a `console.warn` alongside the audit row, and the integration test asserts zero `standdown-tick-error` rows on the happy path. A wrapper that only writes to a log nobody reads is a silent failure with extra steps.
- **Feedback loops.** The one real loop is the block-echo cycle: blocking a tool call makes the model write to its transcript, which looks like activity, which prevents drain, which keeps the muzzle on, which blocks more calls. That is why `evaluateDrain` has the `block-echo-only` basis — without it a muzzled session could never drain. The P19 brakes cover the others (episode latch against release→re-register oscillation, TTL that resumes rather than resets, release hysteresis, terminal `expired`).

---

## 6. External surfaces

- **Other agents / users:** none until the operator flips a dev agent out of dryRun. The feature is dev-gated (dark on the fleet) and ships `dryRun: true` even on a dev agent.
- **External systems:** none. No new egress; the hook talks to `127.0.0.1` only.
- **Persistent state:** two new small files (`state/standdown.json`, `state/standdown-active.json`) and one new log (`logs/standdown.jsonl`, rotated at 5MB). All machine-local; all safe to delete.
- **Response formats:** `/telegram/reply/:topicId` gains a 409 status it never returned before. Verified terminal-and-silent through `recovery-policy` (the new `finalize-standing-down` action) so it cannot enter the retry loop or produce a false "couldn't deliver" notice. `DeliveryOutcome` gains a `standing-down` reason carrying `standDown: true`, which the beacon already treats as not-a-dead-letter.
- **Operator surface (Mobile-Complete):** the operator-facing actions are (a) decide about a duplicate holding contested work and (b) release a frozen expired episode. Both arrive as attention items written in plain words with the decision in the body — the conversational surface is primary, exactly as the spec requires. `POST /standdown/:sessionName/operator-release` exists as the deterministic lever, not as the operator's surface; no curl is ever required of the operator. It is **dashboard-PIN gated** through the shared `checkMandatePin` (so it inherits the timing-safe compare and the durable brute-force lockout): expiry is a deliberately human-arbitered state, and a Bearer-only exit would let any other live session of this same agent clear a decision the human was asked to make — self-granting exactly the authority the freeze withholds. The review caught this as Bearer-only; it was not.

- **New spawn env var:** `INSTAR_AGENT_HOME` is now injected at all four session-spawn sites. Additive and generally useful (it is the correct answer to "where is agent-scoped state?" for any hook, and the worktree gap it closes is not specific to this feature); no existing consumer reads it, so nothing changes for anything that does not opt in.

---

## 6b. Operator-surface quality

No operator surface — not applicable. This change touches no dashboard renderer, approval page, or grant/revoke/secret form. Its operator interaction is entirely through the existing attention-queue surface, whose rendering is unchanged.

---

## 7. Multi-machine posture (Cross-Machine Coherence)

**machine-local BY DESIGN, with a proxied-on-read pool view** (`machine-local-justification: hardware-bound-resource`).

An entry muzzles a PROCESS on this machine's disk — replicating it would be meaningless at best and, at worst, would muzzle the winner. The verdicts it MIRRORS (ownership records, epochs) are already replicated, and the cadence re-verify is the declared agreement invariant with one-tick bounded staleness plus hysteresis. The pool-wide question is answered by `GET /standdown?scope=pool`, riding the shared WS4.4(f) poll cache and tolerant of a dark peer.

Explicitly:
- **User-facing notices:** yes, two — the per-episode standby line and the attention items. One-voice gating is inherent rather than bolted on: an entry exists ONLY on the losing machine, so only the losing machine can emit them, and each is capped per episode.
- **Durable state on topic transfer:** the entry does NOT strand. If the topic moves back, the fire-time ownership re-check releases it at the next send and the cadence re-verify releases it within the hysteresis. If the session vanishes, the next maintenance pass marks it cleanly closed.
- **Generated URLs:** none.
- **Asymmetry:** a machine the record names as owner refuses to register its own copy (`self-is-owner`), so a symmetric mutual muzzle requires BOTH records to be wrong at once.
- **The stated tradeoff:** under partition, "at most one voice" and "at least one voice" cannot both hold. This chooses at-least-one-voice — a partitioned episode can briefly produce two speaking copies, which is exactly the pre-existing condition (never worse than status quo), is bounded by the exactly-once inbound ledger and outbound duplicate suppression, and self-heals on partition heal. Failing toward silence would turn every partition into an unreachable agent.
- **Single-machine agents:** a strict no-op. No ownership-elsewhere reading ever exists, so no entry is ever created.

---

## 8. Rollback cost

- **Hot-fix:** `monitoring.standDown.enabled: false` — production of entries stops, the hook exits 0 on its config gate (before any I/O), the funnels stop consulting, and existing entries age out by TTL. No deploy needed.
- **Data migration:** none. The two state files are self-contained and safe to delete; deleting them at rest simply means no session is muzzled.
- **Agent state repair:** none. Existing agents that took the settings migration keep a `*`-matcher hook entry pointing at a script that exits 0 immediately when the feature is off — measured cost is one config read per tool call, which is the same class as the existing per-call hooks.
- **User visibility during rollback:** none. Nothing user-facing exists until the operator flips dryRun off, and rollback while dryRun holds is invisible by construction.

---

## Conclusion

The review process changed the implementation fifty-one times: three defects I found while building, and forty-eight found by five independent review rounds (8, 9, 9, 9 and 13). The ratio is the honest measure of what the review was worth.

**Found while building (3):** the terminate-authority interface originally had the reaper pass an explicit `bypassedReasons` array — the blanket-activeness-bypass antipattern wearing a different name — and now passes a claim the authority verifies against its own probe before applying its own frozen list; a double-fire between the drained close and the closeout in the same tick, which would have produced a wasted register/close cycle and a misleading audit row on every close; and the spec's `closeoutActivenessBypass` retirement clause, which turned out to describe a predecessor that never shipped.

**Found by the second-pass reviewer, round 1 (8), all fixed:**
1. **The drain predicate was reduced to two of its four legs.** The tick clock was passed as the drain boundary instead of the entry's, so every transcript record was older than the boundary: `grew` was always false, `nonAllowlistedCalls` always 0, and the block-echo basis was unreachable dead code. The corroborated drain is the *entire* justification for crossing `active-process`, `recent-user-message` and `open-commitment`, so a weakened predicate there is precisely the blanket bypass that round-4 review rejected, shipping under this feature's name.
2. **Protected sessions were muzzled** (see §1.3).
3. **`unprovableFrameworkTtlMinutes` was unreachable** — the check tested whether the dep *existed* rather than what it *returned*, so the shorter TTL and its config key were dead code.
4. **The fire-time ownership re-check failed toward blocking** (see §1.4).
5. **The operator-only release was Bearer-clearable** (see §6).
6. **The canary fired on the success path.**
7. **The hook silently no-opped in worktree sessions** (see §2.5).
8. **`validateConfirmedMoveAssertion` had zero callsites** while the spec named it the single admission bar and this artifact claimed it was carried forward (see §4).

**Found by the second-pass reviewer, round 2 (9), all fixed.** Round 2 existed because round 1's last finding was procedural: the artifact had been written against a tree that then kept moving. It was worth running, because two of its nine findings were more serious than anything in round 1:

1. **CRITICAL — the hook read the marker from a path nothing writes.** `config.stateDir` IS the `.instar` directory, so the registry writes `<agentHome>/.instar/state/standdown-active.json`; my round-1 fix for the worktree gap wrote the hook's read as `<agentHome>/state/...`, dropping the `.instar` segment — while the config read one line above kept it. The two disagreed inside a single function. Every marker read would have ENOENT'd, exited 0, and the tool muzzle would never have fired once in production. All 24 hook tests were green because the fixtures wrote to the same wrong path. The regression test now derives the expected path from `StandDownRegistry.markerPath` itself, so a hand-written fixture can never agree with a wrong implementation again.
2. **CRITICAL — `drained` was unreachable, so the happy path was the escalation path.** The call counter counted `tool_use` blocks, which are written when a call is REQUESTED — and a hook-blocked call is requested too. One blocked call pinned the count non-zero for the entry's whole life, and `evaluateDrain` checks that leg first, so it returned `calls-since-boundary` before it could ever reach the block-echo branch. The retry-looping session the block-echo basis exists to let converge could never converge; every episode would have ridden its TTL into the frozen state and paged the operator. Two structural changes: count RESULTS (a call that actually ran) and never a result carrying the block message; and window every observation from the LAST OBSERVATION rather than a fixed registration boundary — measured from a fixed boundary "the transcript grew" is monotonic, so a session that went quiet an hour ago still reads as active forever. Convergence now comes from consecutive clean windows, which is also what lets the in-flight step the muzzle deliberately allows land in one window and be gone by the next.
3. **The canary still fired on the compliant path** — round 1's fix removed the never-asked false positive but not the asked-then-complied one, which is the commoner shape. It now counts work completing after the guard was last consulted, which is the actual bypass signature.
4. **An unresolvable read released AND latched** — one transient null ownership read would have permanently disabled a legitimate muzzle, a stronger consequence than the two-legged reverify path it was meant to mirror. The unresolvable branch now releases without arming the latch.
5. **The fire-time re-check covered one send arm, not both** — the minted-id (Slack) arm refused without it, so §1.4's bound on over-blocking held for Telegram conversations and not for Slack ones. Mirrored.
6. **The two notice audiences shared one budget** (see §5).
7. **The unprovability probe ran the full drain I/O and discarded it** — a tmux capture, a full process listing and a 512KB transcript read on every registration attempt, to answer a question the framework name answers for free.
8. **An undocumented config coupling could silently disable the whole feature** — the validator's 300s liveness-evidence ceiling versus the snapshot's `2 × tickIntervalSec` staleness bound. Past a ~150s tick every registration would refuse `liveness-proof-stale`, for a reason with nothing to do with duplicates. Now a loud boot warning.
9. **This artifact overstated the worktree fix** (see §2.5) — corrected rather than defended.

**Found by the second-pass reviewer, round 3 (9), all fixed:** enumerated in the Second-pass review section below rather than repeated here.

**Found by the second-pass reviewer, round 4 (9), all fixed:** enumerated in the Second-pass review section below.

Roughly a third of the 48 are the same failure shape: a check that *looks* present and is structurally incapable of firing. That is worth naming, because it is the shape this repo's standards keep re-finding, it is invisible to a test suite that only asserts the happy path, and in two cases the tests were not merely silent about it but actively wrong — asserting against a path production never writes, and feeding `evaluateDrain` a combination of inputs the analyser cannot actually produce. The lesson I would carry forward is narrower than "write more tests": where a test needs a value the production code also computes, DERIVE it from the production code rather than writing it down, because a hand-written constant is free to agree with a broken implementation.

One test-integrity note, found the same way: the first version of the hook tests used `execFileSync`, which blocks the test process's event loop, so the in-process stub server could never answer and every verdict test "passed" by timing out into the fail-open path. Three tests were passing without ever exercising the code they named.

Clear to ship behind its dev gate and dryRun default. The enforcement flip is the operator's, on the named soak evidence in the spec's graduation criterion.

---

## Second-pass review

**Reviewer:** independent reviewer subagent, five adversarial rounds plus a closing verification pass.
**Round 1 — CONCERN (8 findings).** Every finding accepted and fixed; enumerated in §Conclusion. Round 1's final finding was procedural: the artifact had been authored against a tree that then kept changing, so its assurance was worth little. That finding is why round 2 exists.

**Round 2 — CONCERN (9 findings), on a frozen tree.** Part A verified all eight round-1 fixes as genuinely present in the code, and Part B found nine more — including two criticals that made the feature unable to function at all. Every finding accepted and fixed; enumerated in §Conclusion, with the one that was a claim in THIS artifact rather than a defect in the code (§2.5, the worktree overstatement) corrected rather than defended.

**Round 3 — CONCERN (9 findings), on a frozen tree.** Part A verified all nine round-2 fixes. Part B found nine more, including a third critical: the hook read `cfg.authToken` and sent `Bearer [object Object]`, because after secret externalization the config holds the marker `{"secret": true}` rather than the token. Every evaluate call would have 401'd, and since the hook fails open on error, the tool muzzle would never have fired once — invisibly, because the test stub never inspected `Authorization`. The env var it should have used was already injected at every spawn site, and this repo's own migrator documents the failure class 340 lines below the bug. I have a standing note to myself about this exact trap from a prior incident; I wrote the note and then made the mistake again. Also in round 3: `growthIsBlockEchoOnly` was defeated by the real transcript shape (Claude Code writes `thinking` and `text` as their own records, so every genuine retry window contained one and the basis never fired); the closed-episode churn brake this artifact CLAIMED as a convergence brake had zero callsites; `mutualMuzzleGraceTicks` was published in config and read from a different object; the anti-mutual-muzzle tiebreak could not fire in a pool of more than two machines because an idle bystander read as a speaking copy; the audit coalescing bucket was reset on only one of seven terminal paths; the `degraded-boot` row could never reach the JSONL (the sink was dereferenced in its temporal dead zone and the throw was swallowed by the audit helper's own catch); and the minted-id arm produced none of the dryRun evidence the Telegram arm produces.

**Round 4 — CONCERN (9 findings), on a frozen tree.** Part A verified all nine round-3 fixes. Part B found the most serious cluster of the whole build: three defects that individually looked minor and together defeated the entire corroborated-drain premise, letting a working session be closed.

1. **The pane leg corroborated nothing.** `idleAtPrompt` was derived from `IDLE_PROMPT_PATTERNS` — status-bar strings (`bypass permissions on`, `shift+tab to cycle`) that are present whether or not a turn is in flight, which is exactly why every other consumer in this repo refuses to trust them alone. The correct primitive (`paneShowsClaudeWorking`, documented as present only mid-turn) already existed and was not used. The leg was effectively always true.
2. **`growthIsBlockEchoOnly` had lost its tie to real block evidence** — a round-3 fix of mine removed it, so the predicate degenerated into "nothing completed in this window", which a quiet-but-thinking session satisfies. It also treated an IN-FLIGHT non-allowlisted call as loop noise, so it could declare drain while the in-flight step the muzzle deliberately allows was still executing — invisible to the process leg too, since an MCP tool call runs inside the excluded MCP subtree.
3. **`drained` was a latch that was never re-verified.** `observeDrain` returned true forever once reached and there was no path back, so one pair of quiet windows permanently authorized the keep-guard bypass and a session that resumed work would be closed the moment an unrelated guard stopped vetoing. A state that can only ever be ENTERED is a symbol, not a verified state — which is P20 inverted, in the one place the spec leans on P20 hardest.

Six more: a peer whose feature is DARK (503) was indistinguishable from an unreachable one, and since this feature is dev-gated a mixed pool is the EXPECTED configuration — so the uncertainty path would routinely release a legitimate muzzle, arm the latch, and raise a factually false HIGH alarm; that same uncertainty release armed the latch, contradicting the round-2 `armLatch` fix; the tiebreak could lift an EXPIRED (human-arbitered) muzzle with no operator; the user-facing honest line was sent through the very route the voice half 409s, so it was structurally undeliverable and burned its per-episode budget failing; expired entries paid the full drain I/O forever; and the "cannot drift" claim about the MCP pattern list was false (it was a hand-copy, and a third copy existed). Also fixed: `endEpisode` reached only 3 of 6 terminal paths, and `health()` hardcoded a threshold every sibling made configurable.

**Round 5 — CONCERN (13 findings), on a frozen tree — and the convergence signal.** Round 5 verified all nine round-4 fixes, answered the two directed questions (drain genuinely CONVERGES for a compliant retry-looping session, and the demotion is correctly ordered against the close), and found no criticals. Its 13 findings, all fixed: the zero-entry early return made the latch/health escalations unreachable in exactly the released-entry state they exist for; the honest line was sent per-tier because nothing read the budget before sending; a registry-known-OFFLINE bystander peer still collapsed the pool answer to unknown and released legitimate muzzles in ≥3-machine pools; the drain demotion and the verdict reasons were written to no sink (so the pane-busy/unknown split bought nothing); `standDown.enabled` without `closeoutLivenessGate` was silently inert (now a loud boot warning); the minted-id (Slack) refusal arm is structurally unreachable in v1 — now DECLARED as such in code and in §2 rather than presented as parity, tracked under CMT-2031; the peer-classification test exercised a hand-written re-implementation rather than the production classifier (now one exported pure function both consume); a session that merely vanished from the running list was recorded as a clean close, inflating the churn evidence; the third hand-copy of the baseline pattern list (closed in the closing verification pass, which caught my first "fix" only updating the docstring's tense); `transcript-unknown` collapsed into `transcript-active`; an off-by-one in the coalescing count; an un-GC'd tiebreak map; and this artifact's own inconsistent accounting.

**Convergence decision (the operator's 80/20 standard).** The operator's standing rule is that convergence is an intelligent 80/20 judgement between iterations, not "iterate until nothing is found." The trajectory: rounds 2–4 each contained at least one critical (feature-inert or working-session-closed class); round 5 contained none — its findings are correctness-of-evidence, observability, and honesty-of-claims issues, and the reviewer independently confirmed the load-bearing loop converges in both directions. That is the meaningful-convergence signal, and I am stopping the review loop here rather than buying round 6 at the cost of the operator's actual request (the shipped feature).

**Closing verification pass — 11 of 13 VERIFIED, 2 NOT-FIXED, both then fixed.** Run so the trace's "reviewer concurred" is a grounded statement: it verified each round-5 fix by file and line and re-ran all four feature suites (116/116). It caught that my B9 "fix" had consolidated only two of the three baseline-pattern copies while the new module's docstring claimed all drift closed, and that three stale round-count strings survived in this artifact. Both corrected; the tier-3 filter now imports the shared constant with its two extra entries declared at the callsite.

**Standing judgement on the review itself.** I wrote this code and I wrote the first review of it, and I did not find any of the 48. Each round's criticals were introduced or missed by work done in direct response to the previous round — which is the argument for repeated rounds on a frozen tree rather than a single pass. The clearest pattern, and the one I would carry to any change of this shape: I verify that code is WRITTEN; the reviewer verifies that it can RUN. Roughly a third of the 48 were checks that looked present and were structurally incapable of firing, and most had green tests over them, because the fixtures were free to agree with the broken code.

---

## Evidence pointers

116 tests total across the three tiers, all green against the final tree, plus the full lint chain.

- `tests/unit/standdown-registry.test.ts` — 60 tests: lifecycle, latches, TTL-resumes, expiry-keeps-both-halves, corrupt-boot marker regeneration, drain predicate boundaries, the MCP-stack process shape, the frozen bypass contract.
- `tests/unit/standdown-guard-hook.test.ts` — 27 tests executing the REAL generated hook against a live stub server: allowlist, unknown-tool-is-blocked, marker fast path with zero HTTP, six fail-open paths, block-message content, the init/migrator anti-drift contract, a discriminating agent-home test (a worktree project dir with the agent home unset reaches no server; with it set, the authoritative call arrives — exit code alone proves nothing here, since both fail open), a path-agreement test that derives the expected marker path from `StandDownRegistry.markerPath` rather than writing it down, and — with the stub server now ENFORCING the bearer against a fixture config holding the externalized-secret marker — a test that the hook authenticates with `INSTAR_AUTH_TOKEN` and reaches a real verdict, plus its companion proving a genuinely wrong token still fails open (which is correct, and is exactly why the first test has to exist).
- `tests/integration/standdown-producer-wiring.test.ts` — 20 tests through the real `SessionReaper` + real registry: registers only on a vetoed closeout, registers nothing when the closeout succeeds, refuses on all three contested-work classes, drained-close passes a claim not a list, dryRun closes nothing, release honors hysteresis, owner-scoped dwell resets.
- `tests/e2e/standdown-lifecycle.test.ts` — 9 tests over real HTTP on a real port: the feature is ALIVE (200 not 503), 409 on the send funnel, the fire-time ownership re-check, dryRun evidence rows on disk, expiry + operator release, an unresolvable ownership read releasing rather than refusing, a Bearer-only release being refused 403 while the PIN release succeeds, and honest 503-when-dark with the evaluate route still failing open.

---

## Class-Closure Declaration (display-only mirror)

No agent-authored-artifact defect — not applicable as a defect fix.

**Self-triggered controller declaration (`unbounded-self-action` class).** This change ADDS a self-triggered controller (the per-tick stand-down maintenance pass, which can register, release, expire, and close sessions on its own), so the convergence argument is owed:

- **Control-loop edge:** the loop's only actuator is the transition of an entry through `standing-down → drained → closed`, plus `released`/`expired`. Registration is gated on the closeout's evidence chain AND refuses when contested work exists; it cannot re-mint an adjudicated episode because a `released`/`expired` episode is LATCHED and re-admission requires a strictly newer ownership epoch.
- **Steady-state bound:** live entries are bounded by (concurrent genuine duplicates) + (expired episodes awaiting an operator ack, each of which has an open attention item by construction). `closed`/`released` entries are pruned on transition; latches are pruned when their epoch is superseded or after 30 days.
- **Settling brakes:** the episode admission latch (kills release→re-register oscillation and the expiry→re-register hourly loop); a TTL that RESUMES rather than resets across re-registrations; release hysteresis of 2 consecutive failed legs; a terminal `expired` state that never escalates to a kill; one injected notice per episode; audit coalescing so a retry-looping model cannot flood the JSONL; the closed-episode churn counter that raises an attention item rather than letting a spawn→register→drain→close cycle run unobserved; the mutual-muzzle grace ticks (a stale pool read cannot break a legitimate muzzle, and an unresolvable one releases rather than leaving the agent silent); and the once-per-condition latch of the `standdown-health` item.
- **Ratchet:** `tests/unit/self-action-convergence.test.ts`.
