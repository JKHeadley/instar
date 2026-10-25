# Convergence Report — Internal Telegram routes require a lifeline-only secret

**Spec:** [docs/specs/telegram-internal-route-lifeline-secret.md](../telegram-internal-route-lifeline-secret.md)
**Slug:** `telegram-internal-route-lifeline-secret`
**Converged at:** 2026-10-12
**Iterations:** 4

## Cross-model review: codex-cli:gpt-6-astra

A real outside (non-Claude) review ran through the codex CLI in all four rounds, each on a changed spec body (hashes `44919386`, `35930e60`, `4e023c27`, `7ae78193`). A clean-door second read on `claude-fable-5` ran in rounds 1 to 3 (`clean-door-anthropic-review: claude-code:claude-fable-5`); it is a Claude-family read and is not counted as cross-model. The gemini CLI was not authenticated on this machine (`gemini-not-authed`), so there was one outside family, not two.

The codex reviewer reads only the spec text and one context document. It said so in every round and marked its findings as specification findings, not measured behaviour.

## How this review stopped (read this first)

The skill's rule is two consecutive rounds with no finding that changes what gets built. **This review did not reach that.** Every round, including the fourth, produced at least one finding the reviewers classed as design.

Counts are the internal reviewers' own tallies, duplicates across reviewers not merged; the outside reviewers' findings are listed separately in the catalog.

| Round | Build-changing findings (internal) | Largest one |
|---|---|---|
| 1 | 30 | a session could rewrite the guard's own state through the Bearer-only file editor; arming waited for the first Telegram message; a refused lifeline lost the message after 100 retries |
| 2 | 20 | "sender not trusted" skipped one of two operator binds and left six other readers of the forged id |
| 3 | 11 | the 24-hour allowance could run out on a quiet machine before the lifeline was ever asked to restart; the posture row would have alarmed on healthy agents |
| 4 | 3, all rated low | one attention throttle shared by three kinds let a routine notice use up the slot a security notice needed |

After round 4 the author also made one change that no reviewer in that round had seen in code: in observe, an unarmed guard no longer starts stripping identity or refusing taps after 24 hours (see "Round 4"). **That change and the three round-4 fixes have not been through a further review round.** The independent second-pass reviewer of the side-effects artifact was shown them.

The review was stopped after round 4 under the brief for this work ("stop converging when findings stop changing the build, not after a fixed number of rounds"). Round 4 was run as a verification round with one combined internal reviewer instead of three. What it found, and what was done about each item, is listed under "Round 4" at the end, so the reader can judge whether stopping there was right.

## How the rounds were run

- **Internal reviewers.** Six perspectives (security, adversarial, scalability, integration, decision-completeness, lessons-aware) plus the Verify-the-State and Self-Heal-Before-Notify checks. In rounds 1 to 3 they ran as three subagents covering two or three perspectives each, reported separately. In round 4 one subagent covered all of them. This was a cost choice by the author; the skill describes one subagent per perspective.
- **The implementation existed during review.** The reviewers were pointed at the code as well as the spec and asked to flag any spec statement that was wrong about the system. Several of the most useful findings came from that (for example the second operator bind in the message pipeline).
- **Standards-Conformance Gate.** Ran in every round: round 1, 2 flags; round 2, 4 flags; round 3, 6 flags; round 4, 4 flags. Never degraded. The round-4 flags are listed below.
- **Per-round model.** The internal reviewers ran on the authoring session's model, `claude-opus-5-5`.

## ELI10 Overview

An Instar agent has a small helper, the lifeline, that listens to Telegram and passes each message and each button tap to the agent's main server. When it does, it says who sent it, and the server believes that. It uses it to decide who the operator is and whether an Approve button was tapped by the right person.

The only thing protecting that hand-off was the agent's ordinary API password, and every working session the agent starts holds that password. So a session could have called the same door and said "this is from the operator".

This design gives the lifeline and the server a second key that sessions are not given. The server only treats a sender as real when the request arrives with that key. The hard part is not the key. It is rolling this out without losing messages, because the lifeline can keep running old code long after the server updates, and old code does not know about the key. So the server refuses no message until the lifeline has proven it sends the key, and it asks an old lifeline to restart.

The main trade-off: everything on the machine runs as one user, so a session that deliberately goes and reads the key file can still forge a request. This stops forging through the password a session normally holds. It does not stop a determined one.

## Original vs Converged

- **Originally** the server refused on a mode switch alone. **Now** it refuses no message until the lifeline has proven it sends the key, and a current lifeline proves it within seconds of starting through its own small route. A lifeline on old code can never be refused by surprise.
- **Originally** an old lifeline was only asked to restart when its first message arrived. **Now** the server asks one minute after it starts, so a quiet machine updates without anyone sending anything.
- **Originally** "do not trust this sender" meant skipping one operator bind. **Now** every identity claim in the request is removed in one place before anything can read it. The review found a second bind, the inbound log, two ratifiers, command authority and the agent-to-agent hook all still reading the forged id.
- **Originally** a button tap without the key was accepted in watch-only mode. **Now** it is refused as soon as the proof exists, in either mode, because a tap is nothing but an approval.
- **Originally** watch-only mode could be held open forever by sending one request a day without the key. **Now** it ends after 7 days at the latest.
- **Originally** a refused lifeline would retry 100 times and then drop the message. **Now** it holds the message without limit, asks less and less often, and tells the user after ten minutes.
- **Originally** the guard's own record ("am I armed?") could be rewritten through the file editor, which needs only the ordinary password. **Now** that file, and the record of handled taps, are in the never-served list beside the key.
- **Originally** there was no true off switch; the "watch-only" setting still changed behaviour. **Now** there is a `bypass` setting that restores the old handling, and neither setting can be changed over the API.
- **Originally** a tap that failed, or whose handling was cut off, looked like a success when it arrived again. **Now** it is still not applied twice, but it answers as a failure.
- **Originally** the guard was not in the list of safety guards the agent watches. **Now** it is, as a critical one.

## Iteration Summary

| Iteration | Reviewers who flagged design issues | Design findings | Precision findings | Spec sections changed |
|-----------|-------------------------------------|-----------------|---------------------|-----------------------|
| 1 | security, adversarial, scalability, integration, decision-completeness, lessons, P20; codex; clean-door | 30 | 14 | whole spec rewritten: arming, startup proof, deadline, restart budget, key-material coverage, no-budget refusal, reports table, decision table |
| 2 | security, adversarial, scalability, integration, decision-completeness, lessons, P20; codex; clean-door | 20 | 7 | sender-not-trusted definition, 24-hour allowance, bypass, refusal brakes and notice, posture manifest, rollback |
| 3 | integration, lessons, P20, security, adversarial; codex; clean-door | 11 | 12 | boot nudge, allowance clock, posture semantics, attention delivery, tap outcome states, ledger, rotation |
| 4 | adversarial, integration, lessons/P20; codex | 3 | 11 | per-kind attention throttle, mode source, independent unarmed reports, mode-dependent allowance, wording |

## Full Findings Catalog

Findings are grouped; duplicates across reviewers are merged. "→" is the resolution.

### Round 1

**Security / adversarial**
- HIGH, design. Guard state and tap store editable through the Bearer-only file editor → both placed under the key-material never-served list (state file renamed to share the secret's prefix).
- MEDIUM, design. A failed re-read discarded a good in-memory secret and failed open → the holder keeps the last good value.
- MEDIUM, design. A transiently unreadable valid secret could be overwritten → only a successfully read malformed file is replaced.
- MEDIUM, design. Arming waited for the first Telegram message → `POST /internal/lifeline-proof`.
- HIGH, design. One secretless request a day kept a fleet agent in observe forever → 7-day deadline.
- MEDIUM, design. Forged requests could drive lifeline restarts and exhaust the shared daily cap → persisted budget.
- MEDIUM, design. Unproven taps could fill or evict the durable claim store → separate in-memory store.
- MEDIUM, design. `POST /sessions/:name/input` can still show a session forged text → stated as an unchanged neighbouring surface.
- LOW, precision. `/health` field wording; "first statement" wording; in-memory rate limits.

**Scalability / integration**
- HIGH, design. A machine whose lifeline never forwards never armed → startup proof and periodic proof.
- HIGH, design. A persistent refusal ended in a drop after 100 strikes → `ForwardSecretRefusedError`, no budget burned.
- MEDIUM, design. The restart-loop claim held only for equal versions → budget; no write with an unknown target.
- MEDIUM, design. The tap store's multi-machine posture and justification key were wrong → residual declared (see round 2 and 3 for the rest of this thread).
- MEDIUM, design. In observe a replaced secret file was never noticed by the lifeline → stale-secret hint header.
- LOW, design. `enforce` was not live on key removal → only the live reader is consulted.
- LOW, design. State files not handled as machine-local → key-material list, registry entry, retention policy.
- LOW, design. Secret creation retried on every request when unavailable → 30 s backoff; `/health` no longer creates the file.
- LOW, precision. Per-request sync writes unbounded for unverified callers → coalescing (this became a code change).

**Decision-completeness / lessons / P20**
- HIGH, design. The spec did not describe what was built (five decisions only in code) → written in.
- HIGH, design. Decision-point table missing rows → added.
- HIGH, design. The refusal path lacked the drop protection the 426 path has → no-budget outcome.
- HIGH, design. Know Your Principal applied to messages but not taps → taps refused once armed in either mode.
- MEDIUM, design. Lifeline-side secret fault undeclared → declared.
- MEDIUM, design. Guard not in the posture inventory → declined in round 2 with a reason; the reason was rejected in round 2 and the guard was registered.
- MEDIUM, design. Rollback section wrong → rewritten twice.
- MEDIUM, design. No test with a real previous-release lifeline → stated as not covered; the round-2 reviewer accepted that as an honest limit.
- HIGH, design. "Armed" declared in one direction; restart-signal trigger had no row; `/health` fields read symbols; corrupt and absent state conflated; Standard B classes undeclared → all addressed.

**Codex (round 1).** Persisted arming contradicts rollback safety → Rollback rewritten. Bearer token can prevent default enforcement indefinitely → deadline. Unreadable secret restores impersonation → message delivered untrusted, tap refused.

**Clean-door (round 1).** Pre-arm window is fail-open → startup proof. Graduation rule not justified over arming alone → reason stated. Complexity relative to the threat → noted; the observe mode and its exit are required by the brief. Silent permanent mismatch → reported. Undefined terms → Terms section.

### Round 2

- HIGH, design (security, adversarial, lessons, codex). Sender-not-trusted gated one of two binds and left the inbound log, ratifiers, command authority, topic-profile ingress, the a2a hook and the session tag reading the forged id → identity dropped once, at the top of the route; message flagged; pipeline gated.
- MEDIUM, design. The 426 handler's signal write was unbudgeted → shares the guard's budget for an unverified request.
- MEDIUM, design. A wrong header avoided the security report → any unverified request after arming reports.
- MEDIUM, design. Replay under a persistent refusal was an unbounded overlapping loop → single-flight, stop at first refusal, backoff.
- MEDIUM, design. A persistent refusal on a current lifeline was silent to the user → lifeline notice after ten minutes.
- MEDIUM, design. Tap-store justification key still wrong → argued as channel-seat state, marked contestable, flagged for the operator. The round-3 integration reviewer judged this acceptable and a replicated claim disproportionate.
- MEDIUM, design. Rollback wrong in two places (`enforce: false` does not stop tap refusals; deleting the state file does nothing on a running server) → `bypass` key; text corrected.
- MEDIUM, design. The manifest-decline reason did not hold → registered in `GUARD_MANIFEST`.
- MEDIUM, design. Security class did not reach the operator → attention item.
- LOW, design. `no-lifeline-ingress` armed on a null adapter → "not configured" derived from config; a configured but absent adapter waits for proof.
- LOW, design. Disjoint tap stores; silent corrupt load; `refusing` false while taps refused; self re-injection refusable after a disk fault → all fixed.
- Codex. Rollback does not stop all refusals → `bypass`. Sender-not-trusted contract incomplete → as above. Migration exposure has no deadline before arming → 24-hour allowance.
- Clean-door. Sender trust fail-open before arming → allowance. Deadline can break an unfound caller silently → attention item. Unacknowledged alternatives → one sentence. "Observe" refuses taps → naming note.
- Precision: nine items (missing decision rows, CLAUDE.md text disagreeing with the spec in three places, report-table wording, rollback detail).

### Round 3

- HIGH, design (integration, P20). The 24-hour allowance could run out on a quiet healthy machine before the lifeline was ever asked to restart; the clock slid across restarts → boot nudge 60 s after server start; allowance clock keyed on the earlier of persisted `observingSince` and the secret file's timestamp.
- HIGH, design (integration, lessons). The posture row would raise false "critical path unguarded" alarms: permanently on machines with no lifeline, and on every fleet agent after the manifest's calendar soak window → a no-lifeline machine arms eagerly and enforces; `dryRun` reported only for observe held by config.
- HIGH, design (security, P20). The attention item fired once ever (fixed id, create returns the existing row) and its throttle was in memory → dated id, persisted throttle, released when the item could not be created; `bypassed` and an expired allowance raise one too.
- MEDIUM-LOW, design (adversarial). An unverified message still claimed a key in the exactly-once ledger and could pre-claim a real message's id → no ledger claim for an untrusted request.
- MEDIUM, design (P20). The `secret-mismatch` timing claim was wrong → text corrected.
- MEDIUM, design (P20). The lifeline's notice was recorded as sent before sending → recorded on success.
- Codex. Lost rollout state restores the allowance → clock keyed on the secret file. Dedupe retention unstated → stated. Interrupted claims lack a recovery state → `pending` / `done` / `failed`.
- Clean-door. Corrupt state reopens the hole for 24 h → as above. No rotation story → added. Rollout machinery heavy → noted. Wall-clock dependence → noted. Terms → added.
- Precision: eleven items (three config "settings" vs two keys, `/a2a/inbox`, text-triggered authority, CLAUDE.md counters wording, binding standards list, phone rollback path).

### Round 4

One combined internal reviewer (all perspectives), codex, the clean-door read, and the conformance gate.

**Internal reviewer.** Confirmed all eight round-3 items resolved in the code. Security: no material findings. Three design findings, all rated low by the reviewer:
- Adversarial. One 24-hour attention throttle was shared by all three kinds, so a routine "lifeline has not updated" item could suppress a security item for a day → the throttle is now per kind.
- Integration. `/health` reported `mode: enforce` with `modeSource: default-observe` on a machine with no lifeline → a `no-lifeline-ingress` source value.
- Lessons / P20. The unarmed reports were an else-if chain, so a persistently wrong secret hid the "still unarmed" report and the day-old attention item → evaluated independently.
- Eleven precision items (stale comments, the "ten minutes" notice timing, the tap store being written twice per tap, missing decision rows and field names) → all applied.

**Codex (round 4), verdict "serious issues", three items.**
- A verified tap is checked against the in-memory store of unproven taps, so an unproven caller who knew a tap's id in advance could suppress it → not changed; stated in the spec with the assumption it rests on (Telegram's callback ids are not predictable).
- That check does not survive a server restart, and "possible only during the pre-arm allowance" was wrong (bypass also accepts unproven taps) → text corrected, limit stated.
- Two processes repairing a malformed secret file at once can publish different values → not changed; both sides re-read on the next mismatch and converge on the file; stated in the side-effects review.

**Clean-door (round 4), verdict "minor issues".**
- The observe mode and its exit rule may be more machinery than the problem needs, since no other caller exists in the repo → not changed; the brief requires an observe default with a defined exit.
- The restart-signal file was not in the protected list, so the file editor could write it around the budget → added to the never-served list.
- "Observe" is a misleading name once armed → not renamed; the spec says what observe does and that `bypass` is "nothing changes".

**Conformance gate (round 4), four flags.**
- Know Your Principal: possession of a same-user file does not prove the caller is the lifeline → the stated limit.
- No Unbounded Loops: the held-message retry has no sustained-failure breaker → not changed. The alternative breaker is dropping the message, which the brief forbids; the interval is capped at fifteen minutes and the user is told.
- Bounded Blast Radius: the held-message queue has no size bound → not changed; this is the existing lifeline queue, and it grows only by the user's own messages.
- Maturation Path: fleet agents in observe had identity stripped and taps refused without a development-agent soak → **changed after the round.** An unarmed guard in observe now changes nothing, for as long as it stays unarmed. The 24-hour pre-arm allowance expires only in enforce, which development agents run first. Once armed, observe still drops unproven identity and refuses unproven taps; by then the only callers affected are not the lifeline. The cost is stated in the spec: a fleet agent whose lifeline never updates keeps the original hole, loudly (hourly report, attention item after a day, `/guards` row off).

That last change reverses, for fleet agents only, part of what rounds 2 and 3 asked for (a bound on the pre-arm window everywhere). The author chose the brief's rule that a rollout must not degrade a real operator's messages over the reviewers' request, and says so here because no reviewer has ruled on the trade.

**Added after the last round, unreviewed:** the spec's `## Maturation plan` section. The tag writer requires it and no round had it in front of it. It restates the rollout already in the spec (enforce on development agents, self-ending observe on the fleet) and names the evidence to read on a development agent.

## Convergence verdict

Stopped at iteration 4 under the brief's rule. The skill's two-consecutive-quiet-rounds criterion was **not** met; see the first section. The spec carries no open questions. One posture (the tap claim store staying machine-local) is flagged in the spec and the PR for the operator to ratify or reject at review.
