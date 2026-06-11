<!-- DRAFT — completed in Phase 4 of /instar-dev. Phase 1 principle check + Phase 2 plan recorded below first. -->

# Side-Effects Review — Outbound advisory: jargon + raw-file-path gaps for automated senders (inform-only)

**Version / slug:** `outbound-advisory-inform-only`
**Date:** `2026-06-11`
**Author:** `echo (instar-dev agent)`
**Second-pass reviewer:** `required — outbound-messaging decision surface (Phase 5)`

## Phase 1 — Principle check (recorded before any code)

**Does this change involve a decision point?** YES — it touches the outbound-messaging
pipeline, the single most sensitive decision surface in instar. The signal-vs-authority
principle applies directly, and the design (per the converged + approved spec
`docs/specs/outbound-jargon-filepath-gap.md`, r2) was shaped around it:

- `detectRawFilePath` (new) and `detectJargon` (re-scoped) are pure DETECTORS — regex,
  cheap, fail-open, no blocking power. They feed the EXISTING authority
  (`MessagingToneGate.review`) as signals. No new rule, no re-scoped block rule.
- The preflight advisory is honestly named in the spec as a "default-withhold the sender
  always resolves" — the sending agent keeps final authority (fix or `--ack-advisory`,
  both always deliver past the advisory layer). It never consults a judge, never
  escalates against the sender, fails open on every error path.
- The repeated-ignore escalation informs the OPERATOR (one deduped Attention item),
  gates nothing.
- Governing operator constraint (Justin, 2026-06-10): zero new blocking authority.
  r1's deterministic 422 floor was DELETED in r2 for exactly this reason.

## Phase 2 — Plan (recorded before any code)

**Build location:** fresh worktree `.worktrees/echo-outbound-advisory-build`, branch
`echo/outbound-advisory-build`, based off `JKHeadley/main` @ v1.3.484 (verified:
`git remote -v` = JKHeadley https, `package.json` 1.3.484, git identity
`Instar Agent (echo) <echo@instar.local>`).

**Implementation order:**
1. `detectRawFilePath` detector (sibling of `localhost-link.ts`, same linear-regex discipline) + unit tests.
2. `messageKind` union widening (`'automated'`) in all five cited sites + `renderMessageKind` branch.
3. `checkOutboundMessage`: always-compute jargon for non-`reply` kinds (drop the `options.jargon` opt-in; fix the one vestigial caller); feed `signals.filePath`.
4. `POST /messaging/preflight` + `GET /messaging/advisory-log` + server-side single-writer JSONL audit + in-memory escalation index + Attention escalation (fixed sourceContext).
5. Scheduler env injection: BOTH SessionManager spawn env blocks (headless + rerouted-interactive) + JobScheduler `runScriptJob` env (`INSTAR_MESSAGE_KIND`, `INSTAR_JOB_SLUG`, `INSTAR_SENDER_CLASS`).
6. `telegram-reply.sh` template: metadata forwarding in BOTH body builders, preflight loop + `--ack-advisory`, curl timeout ms→s clamp, queue metadata column in BOTH script queue writers (quote-safe).
7. `PendingRelayStore` COLUMN_ADDS metadata column + `DeliveryFailureSentinel.postReply` threading + redrive exemption via `X-Instar-DeliveryId` validated against a real queue row.
8. Relay-hop forwarding (3-layer widening) so kind/senderClass/ack survive the cross-machine hop.
9. `/telegram/reply`: read `metadata.messageKind` → `checkOutboundMessage`; `acked` audit row; kindless-job-send + class-spoof breadcrumbs; senderClass validation against the job definition.
10. Config plumbing via LiveConfig (live re-read; `?? true` defaults — rollback without restart).
11. PostUpdateMigrator: current live telegram-reply SHA → allowlist; CLAUDE.md template section (add advisory awareness, remove hand-curl example); `migrateFrameworkShadowCapabilities` marker.
12. All three test tiers per spec §6; release fragment; this artifact completed; trace; commit; PR; CI; merge (Phase 7 auto-merge on green).

**Decision points touched:** outbound `/telegram/reply` pipeline (signals only), new preflight route (advisory only), Attention queue (operator-inform only).
**Existing detectors/authorities interacted with:** `detectJargon`, `detectLocalhostLink`, `MessagingToneGate.review` (B2/B12 untouched in scope), grounding-before-messaging hook (independent layer, unchanged).
**Rollback path:** `messaging.outboundAdvisory.enabled:false` + `messaging.outboundFloor.jargonAlways:false` (live config, no restart); scheduler env injection inert without script/route consumers; queue column is nullable + idempotent-ALTER (legacy rows fine).

## Summary of the change

Implements the converged + approved spec `docs/specs/outbound-jargon-filepath-gap.md` (r2): structural
`automated` message-kind stamping at job spawn (SessionManager both lanes + JobScheduler script env),
the jargon signal single-sourced for non-reply kinds, a new `detectRawFilePath` signal detector, an
inform-only preflight advisory in `telegram-reply.sh` backed by `POST /messaging/preflight` +
`GET /messaging/advisory-log`, a server-side single-writer audit with repeated-ignore escalation, kind
metadata threading through the durable relay queue / sentinel redrive / cross-machine relay hop, and
full migration parity (SHA allowlist + CLAUDE.md + shadow mirrors). Files: `src/core/raw-file-path.ts`
(new), `src/messaging/OutboundAdvisory.ts` (new), `src/core/MessagingToneGate.ts`,
`src/server/routes.ts`, `src/server/AgentServer.ts`, `src/core/SessionManager.ts`,
`src/scheduler/JobScheduler.ts`, `src/templates/scripts/telegram-reply.sh`,
`src/messaging/pending-relay-store.ts`, `src/monitoring/delivery-failure-sentinel.ts`,
`src/messaging/TelegramAdapter.ts`, `src/core/TelegramRelay.ts`, `src/core/PostUpdateMigrator.ts`,
`src/scaffold/templates.ts` + three test tiers.

## Decision-point inventory

- `evaluateOutbound` / `checkOutboundMessage` (routes.ts) — **modify (signals only)** — two new SIGNALS (jargon for non-reply kinds, filePath for all kinds) feed the EXISTING authority; no decision logic changed; block/allow remains solely the authority's.
- `MessagingToneGate.review` — **pass-through** — receives the new kind + signals as context; rules untouched (no B12 re-scope, no new rule).
- `POST /messaging/preflight` (new) — **add (advisory only)** — deterministic detectors, returns advisories; CANNOT refuse a send (the server delivers regardless — proven by test).
- `telegram-reply.sh` preflight loop — **add (default-withhold the sender always resolves)** — honestly named per spec §2.4: the first flagged attempt does not deliver; resolution (fix or ack) belongs exclusively to the sender; fail-OPEN on every error path.
- Repeated-ignore escalation — **add (operator-inform only)** — one deduped Attention item; gates nothing.
- Observability breadcrumbs in `/telegram/reply` — **add (log lines only)** — never affect delivery; wrapped in a try/catch.

---

## 1. Over-block

The server holds NO new block surface — `/telegram/reply` delivers a raw-path automated message
exactly as before (test-proven). The script-side withhold can over-fire two ways:

- `detectRawFilePath` false positive (e.g. a legitimate user-actionable path in a power-user setup):
  costs the sender one `--ack-advisory` re-run; the message still delivers unchanged. Bounded cost,
  stated in the spec's risk table.
- `detectJargon` false positive on an automated send: same single-re-run cost. Jargon is deliberately
  NOT computed for conversational replies, so the over-block tail the operator has repeatedly warned
  about cannot grow on the main path.

A genuinely-flagged localhost link is the one case `--ack-advisory` cannot deliver — but that block
belongs to the PRE-EXISTING localhost guard (untouched); the advisory's static guidance states this
honestly rather than promising ack-delivery.

## 2. Under-block

- A job that hand-curls `/telegram/reply` (bypassing the script) sends kindless and skips the
  preflight entirely — named residual (§2.1/§2.5), bounded by the kindless-job-send breadcrumb and the
  removal of the hand-curl example from the CLAUDE.md template. Accepted by design (sender sovereignty).
- `isProxy`/`isSystemTemplate`/`willRelay` system-composed sends skip `checkOutboundMessage` today and
  are untouched — there is no sender to inform. Named residual.
- A one-shot sender that ignores its advisory drops that one message with no re-fire behind it; the
  per-slug aggregate escalation is the bound. Accepted residual cost of inform-only, per the operator's
  explicit constraint.
- `detectRawFilePath` misses path shapes outside its three alternatives (e.g. bare relative
  `foo/bar.txt` with an unknown top dir, Windows `C:\` paths). Deliberate precision-first scope —
  the LLM authority's B2 judgment still covers them on gated kinds.

## 3. Level-of-abstraction fit

Correct layers throughout: the detector is a cheap deterministic sibling of `localhost-link.ts` in
`src/core/`; the signals feed the EXISTING authority instead of running parallel to it (the spec's
grounding correction explicitly rejected a new gate); the advisory loop lives in the mandated relay
script (the only place that can inform the sender BEFORE delivery without giving the server veto
power); the audit/escalation live server-side where the single-writer guarantee is enforceable. The
kind is stamped at the SPAWNER (the only layer that structurally knows a session is a job).

## 4. Signal vs authority compliance

**Required reference:** docs/signal-vs-authority.md

- [x] No — this change produces signals consumed by an existing smart gate.

`detectRawFilePath` and the re-scoped `detectJargon` are pure detectors feeding
`MessagingToneGate.review`. The preflight advisory holds no blocking authority: its withhold is always
and only resolved by the sender, never escalates, never consults a judge, and fails open on every
error path — the spec names it honestly as a "default-withhold the sender always resolves" rather than
claiming "no authority at all". r1's deterministic 422 floor was DELETED per the operator's
inform-only constraint; no block rule was added or re-scoped anywhere in this change.

## 5. Interactions

- **Shadowing:** the preflight runs BEFORE the send, script-side; the existing pipeline (localhost
  guard, tone gate, dedup, length cap) runs unchanged server-side afterward. One send can legitimately
  receive two differently-shaped interventions (grounding hook + advisory) — independent layers; the
  advisory text never claims to be the only check.
- **Double-fire:** the `acked` audit row is written ONLY on successful delivery, so an
  acked-then-queued send audits once, after the redrive — verified that the queue carries
  `advisoryAck` whole, closing the escalation false-fire on transient delivery failures.
- **Races:** the escalation index is in-memory single-process (write-time, no poller); restart resets
  are accepted, stated best-effort observability. JSONL appends are single `appendFileSync` calls
  (O_APPEND).
- **Feedback loops:** the escalation raises Attention items through `createAttentionItem` with a
  FIXED sourceContext and stable per-signature ids (id-dedup prevents re-raise loops). **Corrected
  after the second-pass review:** HIGH/URGENT items are EXEMPT from the per-source topic budget, so
  the original all-HIGH design would have been an un-budgeted topic-per-signature flood for a
  topic-varying sender. Iterated: per-signature items are NORMAL (the budget genuinely binds — a
  burst-invariant test feeds escalations through the REAL AttentionTopicGuard and asserts allowed
  topics ≤ the budget); the per-slug aggregate is the single loud HIGH bound (one deduped item per
  slug); once a slug's aggregate has fired, further per-signature items for that slug are suppressed.
- The sentinel's `postReply` signature widened with optional trailing params — all existing callers
  and test doubles remain compatible (verified by the full suite).

## 6. External surfaces

- **Other agents on the machine:** job sessions of every framework (claude/codex/gemini) get the new
  env vars — inert unless the relay script consumes them. The CLAUDE.md awareness section reaches
  Codex/Gemini via the shadow-capability mirror.
- **Install base:** the `telegram-reply.sh` re-deploy rides the SHA-gated migrator; user-modified
  scripts are never stomped (`.new` + degradation event, existing behavior). The queue column arrives
  via idempotent ALTER on every writer — legacy rows read null metadata and ride the delivery-id
  breadcrumb exemption.
- **External systems:** no new egress. The preflight is a localhost call; detectors are local regex.
- **Persistent state:** new `logs/outbound-advisory.jsonl` (size-rotated, single `.1` rollover); new
  nullable `message_metadata` column in the pending-relay SQLite (additive, no migration needed for
  rollback).
- **Timing:** the preflight adds one localhost round-trip (~ms) + ~100ms of process spawns per
  automated send; bounded by the clamped curl timeout; the conversational path is untouched.

## 7. Rollback cost

- **Hot levers (live config, NO restart):** `messaging.outboundAdvisory.enabled:false` disables the
  preflight + escalation; `messaging.outboundFloor.jargonAlways:false` reverts the jargon signal.
  Both are read per-request through LiveConfig.
- **Code revert:** the scheduler env injection is inert without the script/route consumers, so a
  partial rollback degrades safely in any order.
- **Data:** the JSONL audit and the nullable queue column need no cleanup on rollback (additive,
  null-tolerant readers).
- **User visibility during rollback:** none — worst case, automated sends simply stop being advised.

## Conclusion

The review confirms the design holds the operator's governing constraint structurally: zero new
blocking authority anywhere in the server; the only withhold lives script-side, is always resolvable
by the sender alone, and fails open on every error path (each proven by a test, not asserted). The
named residuals (hand-curl bypass, system-composed sends, one-shot drops) are bounded by breadcrumbs
and the escalation, and are the accepted cost of inform-only — the operator chose this trade
explicitly. One design change came out of testing: the fix-landing resolution threshold was tuned to
0.4 Jaccard after measuring the founding incident shape (~0.47) vs the gaming heartbeat (~0.06).
Clear to ship pending the required second-pass review (outbound-messaging decision surface).

---

## Second-pass review (required — outbound messaging surface)

**Reviewer:** subagent (claude, independent second-pass)
**Independent read of the artifact: concern → resolved → concur (re-confirmed below)**

First-pass verdict (verbatim): the core inform-only claims all verified adversarially against the
code (no new server-side blocking authority; no silent drop — the NOT-SENT line precedes every
withhold; fail-open complete across curl failure/timeout/non-200/malformed-JSON/missing-python3/
disabled; secret-safety bounds hold at all four echo sites; queue/redrive/relay threading and
migration parity verified). Three concerns were raised:

1. **(Load-bearing) The §5 flood-bound claim was FALSE as written:** per-signature escalations were
   HIGH, and HIGH bypasses BOTH the per-source budget and the universal topic budget — a
   topic-varying sender would have produced K un-budgeted HIGH topics (the 2026-06-05 flood shape);
   the spec-required burst proof test was missing, which is exactly why the false claim survived.
   **Resolution (implemented):** per-signature items demoted to NORMAL (budget-eligible); per-slug
   aggregate kept as the single deduped HIGH; per-signature suppressed once the slug aggregate has
   fired; burst-invariant test added driving 10 distinct misbehaving signatures through the REAL
   `AttentionTopicGuard` and asserting allowed topics ≤ the budget, plus a suppression test.
2. **Two §6 assertions were absent.** **Resolution (implemented):** non-telegram (slack) automated
   send asserted to receive the jargon + filePath signals (with the slack route now threading
   `metadata.messageKind`, mirroring telegram); the Tier-2-location nit (route tests under
   `tests/unit/` driving a real express app) stands with this note.
3. **(Disclosed, no action)** the 0.4 Jaccard fix-landing threshold can under-resolve a heavy
   rewrite; bounded to NORMAL/budgeted items by resolution 1.

**Re-confirmation (independent, after the iteration):** concur — "All three resolutions verified in
code and tests against the real `AttentionTopicGuard` (35/35 green)"; the burst test was verified
non-vacuous (a revert to HIGH fails both assertions). The one cosmetic nit (a stale test-header
comment) was fixed in the same pass.

---

## Evidence pointers

- `tests/unit/telegram-reply-advisory-script.test.ts` — the REAL shipped script under bash + recording
  curl shim: NOT-SENT literal/exit-0, ack annotation, fail-open ×2, legacy-body byte-shape, ms→s clamp,
  queue metadata on HTTP-000.
- `tests/unit/raw-file-path.test.ts` (26) · `tests/unit/outbound-advisory.test.ts` (17) ·
  `tests/unit/outbound-advisory-routes.test.ts` (15) · `tests/unit/pending-relay-metadata.test.ts` (4) ·
  `tests/unit/relay-kind-forward.test.ts` (2) · spawn-env assertions in
  `tests/unit/session-manager-behavioral.test.ts`.
- `tests/e2e/outbound-advisory-alive.test.ts` (5) — production-init alive + auth + on-disk audit +
  live kill switch.
