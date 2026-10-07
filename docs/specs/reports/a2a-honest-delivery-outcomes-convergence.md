# Convergence Report — A2A honest delivery outcomes

## Cross-model review: codex-cli:gpt-5.5 (RAN — every round) + clean-door-anthropic-review: claude-code:claude-fable-5

Convergence ran eight rounds. Every round had six internal reviewers (security, scalability/performance, adversarial, integration/deployment, decision-completeness, lessons-aware), one real external GPT-tier pass through the agent's codex CLI (gpt-5.5 — `ok` status in all eight rounds), and one clean-door Anthropic second read (claude-fable-5, disclosed separately; it never counts as cross-model). gemini-cli was installed but not authenticated (`gemini-not-authed`), so no Gemini pass ran. The Standards-Conformance Gate ran once at round 1 (one `possible-violation` on Close the Loop — addressed by §3's sweep) and the lessons-aware reviewer re-engaged that standard every round; the gate's `specPath` form refused a worktree path, so the `markdown` form was used.

Reviewer model disclosure (D7): the internal reviewers ran as subagents of the authoring session (model `claude-fable-5-1` from round 4 onward; `claude-opus-5-5` for rounds 1–3 before a mid-session model change). One round-4 internal reviewer edited the spec file directly (adding a status value the author had decided against); the edit was reconciled and all later reviewers were instructed read-only.

## ELI10 Overview

When this agent sends a message to another agent, it goes through a shared relay. The relay already answers every message: delivered, held because the other agent is offline, refused, or expired after a day of waiting. Until now the agent's side threw all of those answers away, so every message it sent read "sent, unconfirmed" forever — including two messages to Luna on 2026-10-06 while Luna had been off the relay for 40 hours. Nothing noticed; a human had to ask.

This spec makes the agent listen. A send now answers with what really happened, failures are recorded so the "is this peer alive?" view can show them, and anything with no answer is honestly marked "unknown" rather than guessed either way. It changes no delivery behaviour and adds no automatic resends; those belong to the next increment, which this one gives a trustworthy signal to.

The main trade-off: "no duplicate" wins over "no loss". A reply the agent cannot prove reached the peer is still treated as sent rather than resent, so the peer is never sent the same reply twice; the parent spec's explicit acknowledgement (Layer B) is the eventual exit.

## Original vs Converged

- **Originally**, a message with no answer after a day was marked "failed". **After review**, silence is never failure: it becomes the non-terminal `unconfirmed`, and only an explicit relay refusal or expiry is `failed`. The first draft would have marked messages delivered-while-the-sender-was-offline as lost and let fallback routing resend them.
- **Originally**, the relay's answer could arrive before anyone was listening and be thrown away. **After review**, a 60-second verdict cache and a reordered route (record the send before any wait) close the race.
- **Originally**, a peer going offline would have paged the operator and filed a fleet bug report through the degradation reporter. **After review**, this increment is signal-only: an audit log and the peer-health view; operator notices stay with the parent spec's sentinel and the next increment.
- **Originally**, marking rows `unconfirmed` would have removed them from the existing "peer went quiet" count, so a peer dark for 30 hours would have read healthy. **After review**, that count covers `awaiting-ack ∪ unconfirmed`, and a provably-expired message also marks the peer stale.
- **Originally**, a refused send reused the "delivered but settlement failed" claim path, blocking any retry forever. **After review**, the refusal releases the claim and the "has this reply gone out" check ignores refused entries.
- **Originally**, the design relied on a timer and a stored expiry that did not exist. **After review**, both are specified (a 15-minute single-flight sweep with growing back-off; `relay_expires_at`).
- **Originally**, the new cross-machine health view inherited an exemption that lets every `/threadline/*` path skip the token check. **After review**, the pool view checks the token explicitly (one shared helper, header only), the counters moved to the authenticated branch of `/health`, and the pre-existing exemption is recorded honestly.
- **Originally**, a "banned sender" signal was turned into a per-message failure (and, in one round, into an immediate synthesized verdict). **After review**, a ban is a socket-level signal: affected rows become `unconfirmed` with reason `banned`, and any later real relay answer corrects them. This was the last place the design inferred an outcome instead of reading one.
- **Originally**, an unrecognised refusal reason became "never retry". **After review**, it is "retry unknown"; structured relay-side codes are a dated follow-up (ACT-017).

## Iteration Summary

| Iteration | Reviewers who flagged DESIGN | DESIGN / PRECISION findings | Spec changes | Standards-Conformance Gate | Externals |
|---|---|---|---|---|---|
| 1 | security, scalability, adversarial, integration, decision-completeness, lessons, codex | 22 / 9 | full rewrite: verdict dispatcher + cache, `unconfirmed` state, sweep relabels only, no DegradationReporter notice, reason-code mapping, pool-scope read, unified posture | ran (1 flag: Close the Loop) | codex ok (SERIOUS), fable ok (MINOR) |
| 2 | security, scalability, adversarial, lessons (+ integration/decision clean) | 7 / 14 | stale over awaiting∪unconfirmed; claim released on reject; ordering before the wait; retryable refusal rule; transition table; brakes | unavailable in-worktree (`specPath escapes specsDir`); constitution re-engaged by lessons-aware | codex ok (MINOR), fable ok (MINOR) |
| 3 | lessons, integration, adversarial (+ security/scalability/decision clean) | 4 / 18 | every refusal → `failed` with stored retry flag; outbox written once after the wait; `hasCanonicalReplyFor` ignores refused entries; single verdict writer; ban contradiction removed | — | codex ok (MINOR), fable ok (MINOR) |
| 4 | security, scalability (+ 4 clean) | 2 / 15 | `/threadline/*` auth exemption disclosed; pool scope token-checked; counters moved to authed `/health`; `hasCanonicalReplyFor` ANY-settled rule; dedupe key defined | — | codex ok (SERIOUS: enum contradiction), fable ok (MINOR) |
| 5 | security, decision-completeness (+ 4 clean) | 2 / 17 | `banActive` early-resolve removed (bans expire; never synthesize); helper named; ACT-017/ACT-042 committed; 502-without-body rule | — | codex ok (MINOR), fable ok (MINOR) |
| 6 | scalability, adversarial (+ 4 clean) | 2 / 14 | ban → `unconfirmed` (reason `banned`), non-terminal; `sendSeq` clear rule; bounded dedupe set; unmapped → unknown retryability; stale rule as one SQL expression; shared `bearerMatches` | — | codex ok (MINOR), fable ok (MINOR) |
| 7 | (none) | 0 / 19 | contradictions tidied; lowercase `'banned'` wire value; token-only helper in `middleware.ts`; ISO-with-`T` invariant; renumbering | — | codex ok (MINOR), fable ok (MINOR) |
| 8 | (none — converged) | 0 / 13 | `banSuspected` declared; `relay_status IS NULL` guard on the ban transition; early-clear note; no-token case; `?.`; security-posture summary; loss-risk trade-off stated; lost-queued-ack edge case; bridge justification | — | codex ok (MINOR), fable ok (MINOR) |

Externals were run on every round because the spec body changed every round (hash differed each time); no delta-skip was taken.

## Full Findings Catalog

### Round 1 (DESIGN unless marked P)
- Security: DegradationReporter notice leaks peer names to the external feedback service (HIGH); ack origin not proven relay-only; untrusted relay reason text reaches agent context; `delivery_expired` not matched to recipient; unbounded relay TTL; per-send listeners; relay-sourced `failed` is attacker-influenceable (P); method owner/TTL units (P). → notice removed; origin invariant + test; code mapping + clamp; recipient match; TTL clamp; dispatcher; non-goal note.
- Scalability: ack arrives before listener/row (HIGH); listener flood (HIGH); nonexistent timer (HIGH); missing TTL column/index (HIGH); single UPDATE can't feed per-peer counts; banned `error` frame; null tracker (P); subscribe on `ThreadlineClient` (P). → cache + ordering; dispatcher; new `setInterval`; `relay_expires_at` + indexes; `RETURNING`; ban row; `tracker?.`.
- Adversarial: ack-before-record race; TTL unstored; local-transport rows swept; upgrade burst; late `delivered` after sweep; multi-machine late verdicts; nonexistent timer; `markFailed` also fails `escalated`; event source (P); half-open socket (P). → cache; column; `transport='relay'` filter; `relay_tracking_since`; `unconfirmed` → `awaiting-ack`; posture limit stated; timer; `escalated` included; `ThreadlineClient`; edge case.
- Integration: ack race; rejected leaves side effects claiming success; MCP drops `relayStatus`; timer/TTL; late reply can't clear failure; wrong multi-machine key + lint failure; listener-daemon mode (LOW); precision (#2139 ref, `escalated`, error frames, migration sniff, sentinel ids). → ordering; outcomes after the wait; `SendMessageResult` fields; timer/column; `unconfirmed`; unified posture + pool scope; non-goal; fixes.
- Decision-completeness: 3 s cheap tag rejected; timer, TTL, enum, units, dedupe storage, grace constants, two misclassified rows. → all frontloaded.
- Lessons: silence treated as failure (HIGH); first-detection notice via DegradationReporter (HIGH); timer/column/enum; edge-case contradiction (P); 502 triggers retries (LOW). → `unconfirmed`; notice removed; fixed; `retryLater` + wording.
- codex: ack race; TTL; enum drift; edge-case conflict; `invariant` overclaim; alternatives undiscussed. fable: same contradiction; TTL; enum; race; broker rationale; 502 semantics.

### Round 2
- Security: pool read recursion / unsafe `:fp` param (DESIGN); relay text reaches agent (DESIGN, LOW); TTL clamp in reply, bidi stripping, outbox on reject, mixed-version undercount (P). → validated param, default scope on peers, body cap; codes only; fixes.
- Scalability: 3 s wait in front of `captureOrigin`/`recordThreadMessage` (DESIGN, HIGH); SQL-side ISO compare; sweep source states; waitForReply budget; `(peer_fp,state)` index; latency; cache TTL (P). → reordered; JS cutoffs; `awaiting-ack` only; concurrent wait; index.
- Adversarial: sweep switches off the stale signal (DESIGN, HIGH); `retainReplyClaimFailure` blocks retry forever (DESIGN, HIGH); escalation unreachable for swept rows; outbox-before-wait; late verdicts; thread-ack ordering (P). → stale over awaiting∪unconfirmed; claim released; `findOverdue` includes `unconfirmed`.
- Integration: wrong claim call (P, HIGH); omitted side-effects in ordering; waitForReply+rejected; `:fp` encoding/null tracker; standby wording; rollback side-effect (P). → fixed.
- Decision-completeness: no DESIGN; sweep states, reason mapping, waitForReply rule, two rows, audit bound (P).
- Lessons: sweep clears the only stuck-message alarm (DESIGN, HIGH); brakes incomplete; rollback inert rows; `recordAck` accepts `unconfirmed`; `expired` corroboration; pool awareness (P). → fixed.
- codex/fable: `rejected`-forever ambiguity; sync wait coupling; cap loss semantics; rollback risk; `delivery_expired` id format; dual verdict paths; ban leaves sends unconfirmed; 502 semantics.

### Round 3
- Lessons: retryable refusal must be `failed`, not `unconfirmed` (DESIGN); DegradationReporter dedupe/class-only; growing back-off; stale column + clearing rule (P).
- Integration: outbox has no update-by-id (DESIGN); rejected thread-log leg → `diverged` symmetry (DESIGN, LOW); `relayVerdicts` mechanism, MCP has no timeout, test text, wording (P).
- Adversarial: outbox entries satisfy `hasCanonicalReplyFor` after reject (DESIGN, HIGH); retryable `unconfirmed` has no exit (DESIGN); claim-release position; stale rule needs code filter; ban contradiction (P).
- Security/scalability/decision-completeness: no DESIGN; precision (2 MB cap, ban text in `message`, clamped TTL, reason rows; waiter cleanup, append-once, MCP timeout, ORDER BY; outbox rule, rotation, counters, verdict shape, table rows).
- codex/fable: ban contradiction; `retryable` naming; volatile side channel; transition table; pool merge semantics; double-recording; `unconfirmed` exit; rollback de-escalation; glossary.

### Round 4
- Security: `/threadline/*` bypasses Bearer auth — pool scope and counters would be public (DESIGN). → inline token check; counters to authed `/health`; exemption disclosed.
- Scalability: unbounded dedupe set on untrusted text (DESIGN, minor). → hashed key, 32-key cap.
- Adversarial/integration/decision-completeness/lessons: no DESIGN; precision (`banned-rejected` literal, `hasCanonicalReplyFor` ANY-settled rule, re-drive naming, legacy entries, JSON shape, index name).
- codex: enum inconsistency; ban overreach; broker rationale; glossary. fable: prefix matching fragility; duplicate-id vs re-drive; delivered-no-reply pooling; 502.

### Round 5
- Security: `banActive` short-circuit can record a delivered message as `rejected` (DESIGN) → removed. Decision-completeness: the early-resolve was a synthesized verdict with no table row (DESIGN) → removed, row added.
- Scalability/integration/adversarial/lessons: no DESIGN; precision (`requireBearer` does not exist; `/health` is public with an authed branch; `RouteContext` field; flush-ack clearing; re-drive bound; `unmappedReason` ledger event; pool principal).
- codex: ban ordering proof; prefix fragility; 502; retention; mixed-version. fable: ban overclaim; 502 ambiguity; ordering assumption; prefix contract; clarity.

### Round 6
- Scalability: `unmappedReason` dedupe set unbounded (DESIGN, minor) → hashed key + cap. Adversarial: inferred ban verdict irrevocable (DESIGN, medium) → ban → `unconfirmed`; "ack after the frame" unimplementable (P) → `sendSeq`.
- Security/integration/decision-completeness/lessons: no DESIGN; precision (absent token 403; `instarVersion` new field; dedupe key; table row; `mixedVersion` definition).
- codex: ban precision; `relay-unconfirmed` settled vs never-die-out; state model invariant; auth duplication; prefix bridge. fable: prefix matching; ordering pinned not contracted; 502; stale predicate in prose; clarity.

### Round 7 — no DESIGN findings from any reviewer
- Precision only: stale column-table cell; `retryLater` null case; narrowed Layer-A claim; `recordRelayStatus` bullet; `banActive` on `'connected'`; re-drive bound per topic; lowercase `'banned'` wire value; token-only helper in `middleware.ts` (agent-id rule in pool branch only); `instarVersion` expression + disclosure accepted; `sendSeq` monotone; aggregates; ISO-with-`T` invariant; duplicate paragraph; renumbering; minimal-invariant-path note.
- codex: retry contradiction; ban state mismatch; prefix bridge; complexity summary. fable: rollback contradiction; relay-vs-reply authority sentence; prefix mitigation placement; timestamp invariant; editorial.

### Round 8
- All six internal reviewers: **no DESIGN findings.** Precision only — security: no-`authToken` case, optional chaining on the version expression; adversarial: `banSuspected` undeclared, `relay_status IS NULL` guard, early-clear on reconnect; decision-completeness + lessons: the minimal-path note sat inside the transition table, the `expired` half of the authority sentence, where the ISO invariant is enforced; scalability + integration: none.
- codex (MINOR): route verdicts reliable only while the socket is owned; prefix bridge; `relay-unconfirmed` settled is a loss-risk policy; audit-log fingerprints; auth posture summary. fable (MINOR): bridge justification; lost `queued` ack then genuine expiry; `sendSeq` heavy for a hint (kept — the previous round's adversarial reviewer required an implementable clear rule); clarity; 502.
- Decision-completeness final counts: frontloaded-decisions 10 · cheap-tags-surviving 0 · contested-then-cleared 0 (one cheap tag was contested and REJECTED in round 1 and became a frontloaded fixed decision) · open user-decisions 0.

## Convergence verdict

Converged at iteration 8. Rounds 7 and 8 each produced zero DESIGN-class findings from all six internal reviewers; the GPT-tier external pass ran in every round (`codex-cli:gpt-5.5`, status `ok`) and returned MINOR in rounds 2–8; `## Open questions` is empty; the machine-local-justification lint is clean. Spec is ready for user review and approval. Honest limits carried in the spec itself: the relay-prose prefix mapping is a bridge until ACT-017; `relay-unconfirmed` replies are treated as settled (no-duplicate over no-loss) until the parent spec's Layer B; the `/threadline/*` auth exemption is pre-existing and surfaced for a separate audit.
