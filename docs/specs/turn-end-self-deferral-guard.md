---
title: Turn-End Self-Deferral Guard
status: "DRAFT v4 — SHADOW-scoped (Phase A, observe-only). Round-3 folded (3 reviewers converged on: the result-contract extension + StopGateDb migration/retention are REQUIRED Phase-A prerequisites, not Phase-B). Operator APPROVED the observe-only build (2026-07-05, topic 29836: 'move forward with your recommendations'). Round-4 re-check pending before the `review-convergence` tag; Phase B (ENFORCE) remains DEFERRED + unapproved."
parent-principle: Structure beats Willpower
related-principles:
  - The Agent Carries the Loop
  - Intelligent Prompts — An LLM Gate Must Not String-Match
  - Signal vs Authority
author: Echo
date: 2026-07-04
source-investigation: docs/investigations/deferral-trap-2026-07-04.md
review-findings: docs/specs/reports/turn-end-self-deferral-guard-round1-findings.md
review-convergence: 2026-07-05
review-iterations: 4
review-completed-at: 2026-07-05
scope-note: "review-convergence + approved apply to PHASE A (observe-only) ONLY. Phase B (ENFORCE, §10) remains DEFERRED and separately unapproved."
approved: true
---

# Turn-End Self-Deferral Guard (v4 — shadow-scoped, Phase A CONVERGED)

> **One line:** put a meaning-based, context-aware "are you handing back work you could do yourself?"
> judge on the **turn-end surface**, always-on. **PHASE A (this spec's build):** it runs in SHADOW —
> records would-block verdicts, blocks NOTHING — giving the telemetry to measure whether blocking is
> even worth it. **PHASE B (deferred):** enforce, gated behind the round-2 preconditions in §10.

## Why this is split (round-2 convergence outcome)

Two /spec-converge rounds (findings: `docs/specs/reports/…-round1-findings.md`) established: the
**observe-only** guard is clean and buildable, and every hard/unsafe issue lives in **enforce** — the
existing stop-gate's block path structurally rejects a `continue` without a git-artifact `plan_file`
pointer (AC1, so enforce as-designed would silently never fire), the per-class enforce mode doesn't
compose with the router's global-mode block gate (AM6), the one-shot "never wedge" marker breaks under
message rewording (AM4), and the whole shadow→enforce **graduation chain is agent-forgeable** because
the agent holds the same Bearer token the operator does (S1-S4). Shipping enforce now would ship a
guard that is unbuildable-as-specified, could wedge a real operator decision, and the agent could
quietly disable or weaponize. So Phase A ships the safe, useful observability; Phase B (enforce) is a
separately-converged follow-on with §10's preconditions resolved first.

## §1. Problem (proven — see the source investigation)

A self-deferral — "I'm stopping the build here on purpose… want me to line that up, or steer me
elsewhere?" — slipped every guardrail on 2026-07-04 because it was (1) a plain turn-end (not a routed
send), so it missed the Bash/messaging-route detectors + the tone gate; (2) design-hygiene worded, so
it clean-missed the substring `falseExcuseDeferralGuard`; (3) closed with a real-sounding either/or
question the meaning-based rules are told to PASS. The gap is **surface + semantics** — the
meaning-based judge that could catch a well-worded self-deferral is not on the turn-end surface, and
outside an autonomous run there is no always-on "could you do this yourself?" check.

## §2. Goal / non-goals (Phase A)

**Goal (Phase A):** a context-aware meaning-based judge on the turn-end surface that, in SHADOW, RECORDS
when a turn-ending message hands the operator a decision about work the agent could do itself — with
enough conversational context to distinguish that from a genuine operator decision — producing the
telemetry needed to (later, Phase B) decide and safely enforce. **Phase A blocks NOTHING.**

**Non-goals (Phase A):**
- No blocking, no `exit 2`, no enforce, no graduation, no per-class enforce mode, no operator-gated
  flip. All of that is Phase B (§10).
- No substring bank as the verdict, and (unlike the retracted v1/v2) **no keyword pre-filter on the
  judge's run/skip path** — the judge runs on every turn-end (matching current behavior).
- The judge's classification is a SIGNAL recorded for measurement; it never alters the turn's outcome.

## §3. Design (Phase A — shadow only)

### §3.1 Surface — reuse `stop-gate-router.js` + the existing evaluator

The existing `/internal/stop-gate/evaluate` route + `UnjustifiedStopGate` authority already run on
**every** turn-end unconditionally (`stop-gate-router.js:247`). Phase A adds a classification that the
route RECORDS but never turns into a block.

### §3.2 The judge — a shadow-only classification (avoids the enforce-path wall)

- **(a) The judge emits `U_SELF_DEFERRAL` as an `allow`-class verdict** carrying extra fields
  `{selfDeferral: bool, confidence: high|medium|low, deferredWorkIsAgentOwnable: bool, turnEnding:
  bool}`. Because it is `allow`-class (not `continue`), it PASSES the authority's decision/rule
  coherence check and does NOT hit the `continue`→`plan_file` evidence wall (round-2 AC1) — that wall
  (the continue-branch evidence logic, `UnjustifiedStopGate.ts:469-538`) stays a Phase-B problem. The
  verdict is RECORDED; it never becomes a block.
- **(a-bis) REQUIRED Phase-A core edit — the result-contract extension (round-3 C1/F1, the unanimous
  blocker).** Shadow sidesteps AC1 (continue wall) but NOT AC2 (field drop): `validateResponse`
  currently reconstructs `AuthorityResult` as EXACTLY `{decision, rule, evidencePointer, rationale}`
  (`UnjustifiedStopGate.ts:542-550`), so the four fields the judge emits are discarded before the route
  can record them. Recording the shadow telemetry is therefore IMPOSSIBLE without extending
  `AuthorityResult` + `validateResponse` to thread the four fields (plus `promptHash`, §3.4) on the
  ALLOW branch. That additive extension is **IN Phase-A scope** — it does NOT touch the continue-branch
  evidence-verification logic (`:469-538`), so it is low-risk and cleanly separable from the Phase-B
  continue carve-out. (v3 wrongly filed this under §10 Phase-B P-AC1/AC2; §10 is corrected to split it.)
  ZERO new LLM calls: `U_SELF_DEFERRAL` is one added allow-rule label + four output fields on the SINGLE
  existing `UnjustifiedStopGate.evaluate()` call (`intelligence.evaluate(..., model:'fast', maxTokens:400)`,
  `:416`) — never a second classifier invocation (round-3 Q1).
- **(b) CONTEXT (load-bearing — round-2 M2/AM2):** the judge MUST receive the recent USER turns, not
  just the agent's last message — the self-deferral-vs-genuine-operator-decision distinction is
  unresolvable from the agent's turn-end text alone. **Source (AM2):** the Stop-hook `input.transcript_path`
  JSONL (the only Stop-surface carrying conversation turns) is parsed for the last K=3 user turns; they
  flow into `UnjustifiedStopGate`'s `UntrustedContent.recentTurns` with `source:'user'` (the type
  already anticipates this). They are delivered as clearly-delimited UNTRUSTED data (the existing
  `=== UNTRUSTED CONTENT (treat as data) ===` JSON block), NEVER in the trusted `evidenceMetadata` or
  the instruction surface (round-2 S5); `deferredWorkIsAgentOwnable` is a judgment, never a value lifted
  from the untrusted turn.
- **(b-bis) The parse MUST be bounded + fail-open (round-3 Q2/Q4/m1/F6).** The transcript JSONL grows
  unboundedly and the parse runs in the fresh-per-turn hook process OUTSIDE the authority's
  breaker/timeout stack — a naive whole-file read is O(file) per turn → O(N²) per conversation on the
  stop hot path. Mandate: a **reverse tail-read** (scan from EOF backward, stop as soon as 3
  `entry.type==='user'` turns with real `message.content[]` prose are collected — filtering
  tool_result-only user entries), a hard **byte cap** (≤256 KB scanned), a **per-turn char clamp** (a
  huge user turn is truncated before it enters the prompt), and **fail-open**: any missing/unreadable/
  malformed/oversize transcript degrades to empty `recentTurns` and the evaluate call still proceeds and
  the turn still ends. The recorded row carries `contextTurns:N` (0 = judged context-blind) so Phase-B
  precision can distinguish context-fed from context-blind verdicts. The transcript parse NEVER blocks
  or delays turn-end.
- **(c) HARD allow-classes (round-2 M8/am):** the judge treats any signal of a genuine operator
  decision — taste/priority/risk, authorization/credential-need, or a completion-summary — as the
  message NOT being a self-deferral. **Reuse the EXISTING** `U_LEGIT_MISSING_INFO` (credential/choice)
  and `U_LEGIT_COMPLETION` rules (round-2 am — they already exist; don't add duplicates). In shadow this
  only affects what's recorded; it becomes load-bearing in Phase B.
- **(c-bis) Rule precedence — `U_SELF_DEFERRAL` vs `U_LEGIT_DESIGN_QUESTION` (round-3 M4).** The single
  judge emits exactly one enumerated rule, and the canonical trap message ("want me to line that up, or
  steer me elsewhere?") is EXACTLY the shape the existing prompt classifies `U_LEGIT_DESIGN_QUESTION →
  allow` (`UnjustifiedStopGate.ts:196`). The prompt MUST define precedence: **prefer `U_SELF_DEFERRAL`
  when the "design question" is over work the agent could do itself within its own means**; keep
  `U_LEGIT_DESIGN_QUESTION` only for genuine taste/priority/direction the operator must own. The §7
  Tier-1 both-sides fixture asserts the trap message → `U_SELF_DEFERRAL` and a real taste question →
  `U_LEGIT_DESIGN_QUESTION`.
- **(c-ter) Shared-prompt regression guard (round-3 M2).** There is ONE authority, ONE `SYSTEM_PROMPT`
  (`:183-223`), ONE LLM call — co-resident with the drift-death classifier. Adding the rule + fields +
  user-turn context edits that shared prompt. Phase A MUST regression-test that the EXISTING rules'
  classifications are unchanged against a frozen fixture set (before/after the prompt edit) — a
  precondition of the prompt change, since a shift would be a live-guard regression if the authority is
  ever run in enforce for drift-death.
- **(d) Anchor B17 + the fresh rule (round-2 m1):** encode the B17 "within your own means" line
  freshly for the stop surface; do NOT lean on B19 (excluded from the tone-gate enforceable allowlist).

### §3.3 The keyword bank is NOT on the run/skip path (round-2 M5)

The judge runs on **every** turn-end. The `parked-on-user.ts` phrase bank is at most an
`evidence_pointer` hint surfaced as DATA to the judge — never decides whether the judge runs, never the
verdict. Cost is bounded by the existing circuit breaker.

### §3.4 Shadow sink (round-2 m3/S4)

Record each classification via the EXISTING `StopGateDb` `events` table (`recordEvent`, one row per
turn-end already, `routes.ts:2857+`) — Phase A WIDENS that row, it adds no rows (round-3 Q3 volume:
marginal cost ≈ 0). New columns + SQLite types: `selfDeferral INTEGER(0/1)`, `confidence TEXT`,
`agentOwnable INTEGER(0/1)`, `turnEnding INTEGER(0/1)`, `allowClassRule TEXT NULL`, `promptHash TEXT`,
`surface TEXT('autonomous'|'non-autonomous')`, `contextTurns INTEGER`. **No raw message/user-turn text
is added** (round-2 S4): store the structured fields + `promptHash` only, NOT raw content (the existing
`reason_preview` raw column is NOT extended; Phase-B's pool read must exclude it).

- **Column migration MUST be BUILT (round-3 M3/F2) — the assumed mechanism does not exist.**
  `StopGateDb` today is `CREATE TABLE IF NOT EXISTS` over a fixed `SCHEMA` array with NO `ALTER TABLE`,
  NO `PRAGMA user_version`, NO migration (`StopGateDb.ts:79-170`, grep-confirmed). `CREATE … IF NOT
  EXISTS` is a NO-OP on an already-existing on-disk `stop-gate.db`, so the new columns silently never
  appear on a deployed agent and `recordEvent`'s named-param INSERT throws. Phase A MUST build an
  idempotent post-`CREATE` migration: for each new column, `PRAGMA table_info(events)` → `ALTER TABLE
  events ADD COLUMN <col> <type>` only if absent. This is a **Migration Parity Standard** obligation
  (existing agents must gain the columns on update). Also extend the `EvalEvent` type (`:48-60`), the
  `insertEvent` prepared statement (`:184-191`), the `recordEvent` binding (`:256-270`), and add a
  self-deferral counter to `rollupAggregate` (`:234-249`).
- **Retention MUST be added or correctly cited (round-3 Q3) — the v3 "inherits bounded retention" claim
  was FALSE.** `StopGateDb` has no prune/TTL/vacuum/max-rows anywhere (grep-confirmed); `recentEvents`
  clamps a READ to ≤1000, not storage. The `events` table grows one row/turn forever, and FD2 (judge
  on every surface incl. long autonomous runs) is the highest-volume writer. Phase A MUST add real
  age-based retention (e.g. prune `events` older than N days on a cheap cadence; WAL is already on) and
  cite it here — do NOT ship §3.4 asserting a bound that isn't real.
- **`promptHash` hashes the STABLE TEMPLATE, not the per-call string (round-3 M1/F7).** The purpose is
  edit-detection (Phase-B frozen-prompt soak reset, §10 P-AM7); `sha256(exact assembled prompt at call
  time)` varies every call (per-call untrusted content) and defeats that purpose. Define
  `promptHash = sha256(SYSTEM_PROMPT template)` — the stable rubric text, excluding per-call
  `evidenceMetadata`/`untrustedContent`. Compute it INSIDE `evaluate()` (where the template lives) and
  carry it on `AuthorityResult` via the §3.2(a-bis) extension — the route cannot compute it (round-3 M1).
- **`surface` source (round-3 m2):** the route already computes `getHotPathState(...).autonomousActive`
  (`routes.ts:2824`) — derive `surface` from that, not a second source.

### §3.5 Phase A changes nothing about the turn outcome

The router's block gate is untouched. The classification is recorded; `exit 0` always. There is no
marker, no per-class mode, no `exit 2` in Phase A — so the round-2 marker (AM4), mode-composition
(AM6), and CONTINUE_CEILING (am) hazards do not exist in shadow (they are Phase-B design items, §10).

## §4. Multi-machine posture (Phase A)

- **Judge/record: machine-local by nature** — runs where the session runs; the sink is the local
  `StopGateDb`.
- **Soak telemetry read: proxied-on-read (Phase B surface, not built in Phase A).** Phase A only WRITES
  the local sink. A pool read of the soak telemetry is a Phase-B item (§10), and when built MUST exclude
  raw text (round-2 S4).

## §5. Self-Heal-Before-Notify — N/A

Synchronous per-turn signal→record. No watcher, no retry loop, no operator notice. N/A. The sink is the
`StopGateDb` with Phase-A-BUILT age-based retention (FD7/§3.4 — NOT pre-existing). (The v2 "fail-open
removes the loop" claim is gone; Phase A has no loop because it never blocks.)

## §6. Frontloaded Decisions (Phase A)

- **FD1 — Phase A blocks nothing.** The judge classification is recorded only. (The enforce gate FD1 of
  v2 moves to Phase B, §10.)
- **FD2 — the judge runs on every turn-end** (all surfaces, incl. autonomous), so the shadow telemetry
  covers the full distribution; a later enforce decision (Phase B) will restrict to the non-autonomous
  surface.
- **FD3 — REUSE + these NAMED Phase-A additions:** the `U_SELF_DEFERRAL` allow-class rule + the four
  fields + the transcript_path user-turn context wiring + the `StopGateDb` columns + the template
  `promptHash`. NO new hook, NO new route, NO block path, NO new LLM call/model. (Smaller than Phase B —
  but NOT "pure reuse"; the two core edits below are required prerequisites, round-3.)
- **FD4 — DIRECTION: operator-decided + APPROVED (2026-07-04→05, topic 29836: "soak then graduate" →
  "move forward with your recommendations").** Records the operator's shadow-first direction AND the
  build go-ahead for Phase A (observe-only). Phase B (enforce) remains separately unapproved.
- **FD5 — context depth K = 3 user turns** (cheap, shadow-observable, reversible).
- **FD6 — the result-contract extension IS in Phase-A scope (round-3 C1/F1, the unanimous blocker).**
  Extend `AuthorityResult` + `validateResponse` to thread the four fields + `promptHash` on the ALLOW
  branch (§3.2 a-bis). This is a core edit, but additive and separated from the continue-branch
  evidence logic — it is NOT the deferred Phase-B carve-out. Without it Phase A silently records NULLs.
- **FD7 — the `StopGateDb` column migration + retention ARE in Phase-A scope (round-3 M3/Q3/F2).** Build
  the idempotent `PRAGMA table_info` + `ALTER TABLE ADD COLUMN` migration (Migration Parity) AND real
  age-based retention (§3.4). The assumed "schema migration" and "bounded retention" did NOT exist.
- **FD8 — enable key (round-3 F4):** the gate is `monitoring.selfDeferralGuard` resolved by the
  dev-agent gate (block omits `enabled` → on-for-dev, dark-fleet), NOT a `.shadow`/`.mode` sub-flag.
  OFF-state behavior: the judge still runs (the existing stop-gate call is unconditional) but Phase A
  does NOT emit the `U_SELF_DEFERRAL` rule in the prompt and records no self-deferral columns — i.e. the
  gate switches the shadow classification + recording, not the base stop-gate.

## §7. Testing (P4) + Migration parity (P3) — Phase A

- **Tier 1 (unit):** the `U_SELF_DEFERRAL` classifier on a fixture set — a true self-deferral →
  `selfDeferral:true`+high; each existing allow-class (credential via `U_LEGIT_MISSING_INFO`, completion
  via `U_LEGIT_COMPLETION`) → `selfDeferral:false`; the verdict is `allow`-class (never `continue`, so it
  can't block); `promptHash` is a hash of the STABLE template (stable across calls, changes on a prompt
  edit — round-3 M1/F7). **Precedence fixture (round-3 M4):** the canonical trap message → `U_SELF_DEFERRAL`;
  a genuine taste/priority question → `U_LEGIT_DESIGN_QUESTION`.
- **Tier 1 (regression — round-3 M2):** the EXISTING rules' classifications (drift-death, the allow-classes)
  are byte-for-byte unchanged against a frozen fixture set, before vs after the shared `SYSTEM_PROMPT`
  edit — the prompt change may not shift the co-resident classifier.
- **Tier 1 (result-contract — round-3 C1/F1):** `validateResponse` PRESERVES the four fields +
  `promptHash` on an allow-class verdict (they are not dropped); a verdict with them missing records
  nulls without throwing.
- **Tier 1 (migration — round-3 M3/F2):** on a DB created at the OLD schema, the `ALTER TABLE ADD COLUMN`
  migration adds each column idempotently (safe to run twice); `recordEvent` then inserts the new
  columns without throwing. **Retention (round-3 Q3):** the prune deletes rows older than N days and
  leaves newer rows.
- **Tier 1 (transcript parse — round-3 Q2/Q4):** the bounded tail-read returns ≤3 user turns from a
  large fixture JSONL within the byte cap; a missing/malformed/oversize transcript → empty `recentTurns`
  + `contextTurns:0`, never throws.
- **Tier 2 (integration):** the evaluate route over HTTP with the transcript-parsed user context →
  records to `StopGateDb` with the new columns + no raw text; `exit 0` always.
- **Tier 3 (feature-alive):** the Stop-hook → route → record path runs on a real turn-end, writes one
  shadow row (with the four fields populated, not null), blocks nothing.
- **Migration parity:** `migrateConfig` adds `monitoring.selfDeferralGuard` (existence-checked, no
  `enabled` key → dev-agent-gated per FD8); the BUILT `StopGateDb` `ALTER TABLE` migration adds the new
  columns to existing on-disk DBs (FD7 — `CREATE IF NOT EXISTS` does NOT); the Stop-hook body
  (transcript_path context extension) is regenerated on migration (always-overwrite).

## Open questions

*(none for Phase A. Phase B carries the deferred decisions in §10.)*

## §10. Phase B (ENFORCE) — DEFERRED, gated preconditions

<!-- tracked: topic-29836 -->
<!-- The Phase-B (enforce) deferral is operator-approved shadow-first (topic 29836, 2026-07-05) and
     owned by the defer-guard task; it ships ONLY after the §10 preconditions below AND a separate
     operator approval. This is a tracked, deliberate deferral — not an abandoned one. -->


Enforce is a SEPARATE follow-on spec + convergence. It ships ONLY after ALL of these round-2 findings
are resolved AND re-converged AND the operator applies `approved:true` on the Phase-B spec:

- **P-AC1 — the continue/evidence-pointer wall (Phase B ONLY):** carve `U_SELF_DEFERRAL` out of the
  authority's `plan_file`/`postVerifyEvidence` requirement (`UnjustifiedStopGate.ts:469-538`) and decide
  route-synthesized-continue so a self-deferral can produce a BLOCKING `continue`. Editing the
  safety-critical continue-branch evidence core must be explicitly admitted + reviewed. **NOTE
  (round-3 C1 correction):** the *additive* half — extending `AuthorityResult`/`validateResponse` to
  THREAD the four fields + `promptHash` on the ALLOW branch — is NOT here; it moved to Phase A (FD6),
  because it's required to RECORD shadow telemetry and does not touch this continue-branch logic.
- **P-AM6 — per-class enforce mode composition:** the router must branch on `result.rule` (block
  `U_SELF_DEFERRAL` on a CLASS mode, others on global); hot-path exposes the class mode; bump
  `GATE_ROUTE_VERSION`.
- **P-AM4 — the one-shot brake:** key the marker on `sessionId` ALONE (block at most once per session,
  full stop) — NOT the message hash (which re-blocks on rewording, breaking "never wedge").
- **P-AM7 — the soak gate:** precision on the Wilson LOWER-BOUND (not point estimate), a raised N_min,
  non-autonomous same-surface data only, frozen call-time `promptHash`, per-agent (not pool-aggregate)
  clean-soak.
- **P-S1/S2/S3 — the graduation must be PIN-gated (not agent-forgeable):** adjudication of shadow
  would-blocks routes through `checkMandatePin` and records the AUTHENTICATED operator; ONLY
  operator-authenticated labels count toward precision; the `→enforce` class-mode flip is PIN-gated; the
  EFFECTIVE mode is read from an operator-authenticated store, not a bare agent-writable config value.
- **P-S4 — pool telemetry read excludes raw text** (hash/structured fields only); the one-shot marker
  key is a fixed-width hex digest.
- **P-am — CONTINUE_CEILING:** decide whether `U_SELF_DEFERRAL` increments the shared per-session
  continue counter (it must NOT silently weaken the drift-death guard).
- **P-M8 residual:** the allow-class override has no structural backstop (judge-self-reported) — Phase-B
  must state that residual risk + how the soak bounds it.

## Status

v4 — Phase A (observe-only shadow) CONVERGED (4 review rounds: 6 internal lenses + a focused Phase-A
round-3 + a round-4 re-check; conformance gate unavailable/404 on this agent — recorded, non-blocking).
Operator APPROVED the observe-only build (2026-07-05, topic 29836). Round-1/2/3 findings folded; the
round-4 re-check verdict is CONVERGED with no new Phase-A blocker. Phase B (ENFORCE, §10) is a separate
future spec — DEFERRED and separately unapproved. Now in BUILD.
