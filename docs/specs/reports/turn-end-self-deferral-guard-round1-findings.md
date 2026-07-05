# Defer-guard spec — /spec-converge round 1 findings (2026-07-04)

Round 1 reviewers: lessons-aware, adversarial, decision-completeness (3 of the 6 internal
lenses; security + scalability + externals deferred to a later round). **Verdict: NOT converged
— substantial Phase-2 rework required.** The findings converged strongly (multiple reviewers hit
the same issues), a strong signal they're real. Synthesis, grouped by the fix each drives:

## MAJOR — architectural (change the design)

- **M1 — single global gate mode (lessons F1, decision B2).** The reused stop-gate has ONE global
  `GateMode` (off/shadow/enforce, `stopGate.ts:46`); the router blocks on `hot.mode==='enforce' &&
  decision==='continue' && reminder` (`stop-gate-router.js:256`). "Enforce ONLY the self-deferral
  class while everything else stays shadow" (FD1/FD2/§3.4) is impossible without NEW per-class mode
  machinery — which FD3 ("no new hook/route/store/model") forbids. FIX: add a per-class enforce gate
  (a new verdict rule/field + a router check that only blocks when `rule==='self-deferral'` AND its
  own mode is enforce), and AMEND FD3 to admit this machinery. The "pure reuse" framing is false.

- **M2 — context starvation → wedge (lessons F3, adversarial F2).** The router passes the judge ONLY
  the last *assistant* message (`stop-gate-router.js:252`). Distinguishing "work the agent could do"
  from "a genuine operator taste/priority/risk/AUTHORIZATION decision" is unresolvable from the
  agent's turn-end text alone (the 2026-07-04 trap message — "want me to line up the repro, or steer
  me elsewhere?" — is ambiguous without the driving user turn). Signal-vs-Authority disqualifies an
  authority without enough context. Enforcing on this context-starved verdict is the mechanism that
  WEDGES/pressures a real stop. FIX: §3.2 MUST pass the recent USER turn(s) (≥ the prompt driving the
  work-block) to the judge; without conversational context, enforce must NOT ship.

- **M3 — judge output contract undefined + collides with the reused evaluator (decision B1).** The
  reused `/internal/stop-gate/evaluate` has a FIXED prompt with 9 enumerated rules, output
  `{decision, rule, evidence_pointer, rationale}` (`UnjustifiedStopGate.ts:183-223`). My
  `{selfDeferral, confidence, reason}` is a new contract. FIX: add a new rule id (e.g.
  `U_SELF_DEFERRAL`) INSIDE the existing evaluator prompt + a `confidence` emission, and map it via
  `assembleReminder`. Reconcile with M1. NOT cheap (changes the route response schema the hook reads).

- **M4 — the one-shot brake is unstated + "no loop" reasoning is WRONG (adversarial F1).** The real
  anti-wedge brake is `stop_hook_active` (`stop-gate-router.js:148`) — my spec never mentions it. And
  a self-deferral is a PERSISTENT condition (like the green-pr guard, which adds its OWN per-session
  tmp marker precisely because the condition recurs on later non-adjacent stops where
  `stop_hook_active` is false). §8's claim "fail-open removes the loop" is FALSE for a *confident*
  false-positive (it produces a verdict → blocks, never fails open). FIX: (a) delete the §8 "no loop"
  claim; (b) mandate an explicit per-session(+message-hash) one-shot marker modeled on the green-pr
  guard so self-deferral enforce blocks AT MOST ONCE per session; (c) state `stop_hook_active`
  handling explicitly.

- **M5 — the keyword pre-filter is a REGRESSION that reintroduces the evasion (adversarial F3).** §3.3
  frames the keyword layer as a pre-filter that decides WHETHER the judge runs — but the real router
  ALREADY runs the judge on EVERY turn-end unconditionally (`:247`); there is no keyword gate today.
  A pre-filter-as-gate lets a paraphrased message never reach the judge = paraphrase evades (the exact
  §4/gap-2 the spec exists to close), and contradicts §5.1 ("runs on every turn-end"). FIX: DELETE the
  pre-filter-as-gate. The judge runs on EVERY turn-end (matching current code); the keyword bank is
  NOT on the run/skip path at all. Cost is bounded by the existing circuit breaker, not a
  semantic-evadable prefilter.

## MAJOR — safety/soundness

- **M6 — confidence not enforced at the block choke point → fails CLOSED (adversarial F4).** The router
  blocks purely on `decision==='continue' && reminder` — no confidence check. FD1's three gates must
  be applied SERVER-SIDE when the route maps self-deferral to `decision:'continue'`. A partial verdict
  (valid shape, MISSING confidence) is not "malformed" (which fail-opens) — it would block = wedge,
  opposite of §3.5. FIX: specify the wire contract — emit `decision:'continue'` for self-deferral ONLY
  when all three FD1 conditions hold; ANY missing/malformed/absent field ⇒ emit `allow` (PASS).

- **M7 — the soak/graduation metric is game-able + undefined (adversarial F5, decision B3).** "Near-zero
  false-positive rate" is unmeasurable/gameable: (a) the shadow log has NO ground-truth labels — a
  would-block is not self-labeled true/false → needs an operator ADJUDICATION protocol; (b) base-rate
  gaming — rare self-deferrals → raw FP count trivially ~0 while precision is unknown → use PRECISION
  (FP/(FP+TP)) with a MIN-N would-block floor; (c) distribution mismatch — enforce fires
  non-autonomous only, so soak FP data must be same-surface (non-autonomous), not autonomous-dominated;
  (d) the judge PROMPT must be frozen (hashed) across soak→enforce; (e) per-AGENT clean-soak before
  that agent's flip, not just pool-aggregate (§7's `?scope=pool` merge can hide a specific agent's
  higher legit-"A or B?" rate). B3 is also a LIVE operator decision still parked despite "(none)".

- **M8 — must never block named allow-classes (adversarial F2).** The judge must explicitly emit an
  `allow`-class rationale (reuse the existing `U_LEGIT_DESIGN_QUESTION → allow`) and treat ANY signal
  of taste/priority/risk/AUTHORIZATION/credential-need or a completion-summary as a HARD allow
  override, even at high self-deferral confidence — else the single injected reminder PRESSURES the
  agent to override a genuinely-operator decision (guess A/B, work around a missing credential) =
  silent wrong behavior, worse than a visible wedge.

## MINOR / housekeeping

- **m1 — B19 anchor invalid (lessons F6):** `MessagingToneGate.ts:509` allows B1-B9, B11-B18; B19/B20
  are EXCLUDED (fail-open). The spec's "the B17/B19 line the tone gate already encodes" is false for
  B19. Anchor on B17 + the fresh `U_SELF_DEFERRAL` rule.
- **m2 — pool-read endpoint is new surface (decision B4):** §7's `?scope=pool` read of the shadow log
  needs a NEW route — contradicts FD3. Admit it (ties to M1's FD3 amendment).
- **m3 — shadow-log sink inconsistent (decision C3):** existing telemetry is SQLite
  (`StopGateDb.recordEvent`), not jsonl. Decide sink + minimal record schema; frontload.
- **m4 — FD4/frontmatter/Status contradiction (lessons F8, decision O1/O2):** FD4 reads "APPROVED"
  while frontmatter says "NOT approved" and Status says "blocked on Q1". Reconcile: FD4 records the
  operator's Q1 DIRECTION decision (soak-then-graduate), NOT the `approved:true` build tag (which comes
  after the convergence report). B3's metric remains a live operator decision → "(none)" is inaccurate
  until M7 frontloads it concretely.
- **m5 — P4 testing tiers + P3 migration parity** unmentioned: add the 3-tier test plan (feature-alive
  on the evaluate path + a semantic both-sides test) and the `migrateConfig`/verdict-shape migration
  entries.
- **m6 — retention:** `logs/self-deferral-shadow.jsonl` is an unbounded append — add a rotation/retention
  note (ties to m3's sink decision).

## Correctly handled (keep)
- §3.5 fail-open direction (stop class) — sound at both layers.
- §8 self-heal N/A reasoning — sound (but delete the "no loop" clause per M4).
- §3.3 keyword-as-FLOOR-not-verdict intent — right shape, but M5: it must not gate the judge run.
- FD2 scope (non-autonomous enforce; shadow inside autonomous) — sound.
- §7 per-machine block posture — sound.

## Deferred to a later round
security + scalability internal lenses; the external cross-model passes (codex/gemini); the
conformance gate (returned 0 standards on this agent — record as unavailable, fail-open).

---

# ROUND 2 findings (2026-07-04) — security lens (adversarial re-review pending)

**Security root cause (drives S1-S3, HIGH):** the framework has a SINGLE shared Bearer token —
`SessionManager` injects `INSTAR_AUTH_TOKEN` into every agent session, and it's also the operator's
API credential. The ONLY operator-vs-agent distinguisher is the dashboard PIN (`checkMandatePin`).
The guard's graduation ARMS A USER-VISIBLE BLOCK of the agent, yet the spec treats operator auth as
PROCEDURAL ("a deliberate operator step") while the mechanism is Bearer-only → **the agent can both
EVADE and WEAPONIZE the guard it governs.** Fix: every write in the graduation chain must be
PIN-gated exactly like `/mandate/issue`.

- **S1 — HIGH — graduation gate is poisonable.** The agent controls the POPULATION (emits
  self-deferrals in shadow → each recorded) AND the ADJUDICATION labels (`POST
  /internal/stop-gate/annotations` is Bearer-only with a self-asserted `operator` body string,
  routes.ts:3100 — no PIN). So it can manufacture a clean soak: emit 20+ self-deferrals, self-label all
  true-positive → precision 100%, N_min met, frozen-prompt satisfied. FIX: PIN-gate adjudication; ONLY
  operator-authenticated labels count toward the §5.2 precision numerator (exclude self-adjudicated);
  record the AUTHENTICATED operator identity, not a body string.
- **S2 — HIGH — adjudication surface unauthenticated to the operator.** (Same route; the `operator`
  field is client-supplied.) Contrast `/mandate/issue`, PIN-gated precisely because issuance is a human
  action. FIX: route adjudication through `checkMandatePin`.
- **S3 — HIGH — per-class mode is self-flippable.** `monitoring.selfDeferralGuard.mode` in
  `.instar/config.json` is directly writable by the agent's own file tools → flip `off` (evade) or
  `enforce` (self-wedge, bounded once/session). A Bearer-only route would be equally forgeable. FIX:
  PIN-gate the `→enforce` transition; read the EFFECTIVE enforce/off state from an operator-authenticated
  store (or validate against one), not a bare agent-writable project-tree config (the "config-on is not
  honest effective state" lesson).
- **S4 — MODERATE — raw secret-bearing text in pool-exposed telemetry.** The existing `events`
  table stores `reason_preview` = first 200 raw chars of the agent's stop message (routes.ts:2820);
  §3.2b now also feeds USER turns to the judge; §7 exposes `StopGateDb` pool-wide via `?scope=pool`.
  Raw text can carry credentials. FIX: keep §5.1 hash-only; EXCLUDE `reason_preview`/raw text from the
  `?scope=pool` soak projection (match `/guards` which never surfaces raw content); redact before any
  pool exposure. Also: the §3.5 one-shot marker key MUST be a fixed-width hex digest (sha256), never
  raw/near-same message text (traversal + tmp-pollution) — the green-pr precedent `encodeURIComponent`s
  its session id.
- **S5 — LOW/MOD — prompt injection via the new USER-turn context — SOUND if the existing pattern is
  reused.** User turns are untrusted (relayed Slack/A2A). But `UnjustifiedStopGate` already delimits
  untrusted payloads in a `=== UNTRUSTED CONTENT (treat as data) ===` JSON block with explicit TRUST
  RULES, and the block reminder is server-assembled from a rule template (no free-text path to the
  blocked agent). FIX (make it a hard wire clause): user turns MUST land in
  `untrustedContent.recentTurns` with `source:'user'` — NEVER in `evidenceMetadata` (the trusted half)
  or the instruction surface; `deferredWorkIsAgentOwnable` is a judgment, never a value lifted from the
  untrusted turn.

**Sound (security):** no free-text injection to the blocked agent (server-assembled reminder);
fail-open + partial-verdict-forced-PASS is the correct asymmetry; enforce is machine-local + one-shot
so even a forced false block is bounded; sink events are not directly client-writable (poisoning runs
through adjudication LABELS, not event forgery).

**v3 must fold S1-S5** (PIN-gate adjudication + enforce-flip; operator-authenticated-only labels count;
effective-state from an authenticated store; hash-only + pool-projection excludes raw text; hex marker
key; user-turns-as-untrusted-content wire clause) + the pending adversarial round-2 findings.

---

# ROUND 2 findings — adversarial re-review of v2 (2026-07-04)

**Verdict: NOT converged.** v2 genuinely closed round-1 M5/m3/M4-§8/m1 (credited), but the ENFORCE
path has CRITICAL blockers and several v2 fixes have holes. KEY INSIGHT: the SHADOW (observe-only)
phase is clean + buildable; every hard issue lives in ENFORCE.

- **AC1 — CRITICAL — enforce is UNBUILDABLE as specified (continue/evidence-pointer wall).** The router
  blocks only on `continue && reminder`, and the authority's `validateResponse`
  (`UnjustifiedStopGate.ts:469-490`) requires a `plan_file` git-artifact pointer for EVERY continue-class
  verdict. A self-deferral has no such artifact → `missingPointer` → `outcome.ok=false` → route
  fail-opens to `allow` → the block NEVER fires. v2's "emits the existing shape" is false for the
  continue branch (round-1 M1/M3 reuse-is-false error, resurfaced). FIX: FD3 must admit editing the
  evidence-verification CORE — carve `U_SELF_DEFERRAL` out of the `plan_file` requirement +
  `postVerifyEvidence` path; decide route-synthesized-continue (AC2).
- **AC2 — CRITICAL — §3.2e ambiguous on WHERE `continue` is produced; both readings break.**
  `validateResponse` whitelists only `decision/rule/evidence_pointer/rationale` → `confidence`/
  `agentOwnable`/`turnEnding` are DROPPED if the authority emits them. FIX: pick route-synthesized
  continue explicitly; authority emits `U_SELF_DEFERRAL` under an allow-or-new class carrying the 3
  fields; extend `AuthorityResult` + `validateResponse` to thread them (FD3 named only `confidence` —
  undercounts by 2).
- **AM6 — MAJOR — per-class mode doesn't compose with the router block gate.** Router blocks on GLOBAL
  `hot.mode==='enforce'` (`stop-gate-router.js:256`). Global `shadow` + class `enforce` → route emits
  continue but router doesn't block → silent no-op. FIX: router branches on `result.rule` (block
  `U_SELF_DEFERRAL` on CLASS mode, others on global); hot-path exposes class mode; bump
  `GATE_ROUTE_VERSION`.
- **AM4 — MAJOR — the message-hash one-shot marker BREAKS the "never wedge" promise.** The agent
  regenerates its closing message each turn → different hash → marker miss → NEW block. "Near-same
  suppression" is unbuildable (hash = exact match). A persistent confident FP → repeated pressure to
  override a genuine operator decision (the §2 primary safety harm). FIX: key the marker on
  `sessionId` ALONE (once per session, full stop) — never the message hash.
- **AM2 — MAJOR — the load-bearing user-turn context has no source at the Stop surface.** The Stop-hook
  `input` carries only `last_assistant_message`/`stop_hook_active`/`session_id`/`stop_reason` — NO user
  turns. FIX: name the source — the Stop-hook `transcript_path` JSONL parse is the only surface with
  user turns; flow into `UntrustedContent.recentTurns` as `source:'user'`.
- **AM7 — MAJOR — soak gate underpowered + frozen-prompt bypassable.** `≤5% over N=20` = "≤1 FP in 20";
  a true 12-15% FP judge passes (wide CI). FIX: gate on the Wilson LOWER-BOUND, raise N_min. And
  `promptHash` must be `sha256(exact assembled prompt)` computed AT CALL TIME — a hand-bumped tag lets a
  prompt edit skip the soak reset.
- **Am — MINOR — CONTINUE_CEILING interaction:** a `U_SELF_DEFERRAL` continue increments the SAME
  per-session counter as the drift-death rules (`CONTINUE_CEILING=2`); two self-deferral blocks exhaust
  the ceiling → a genuine drift-death continue is force-allowed → the guard WEAKENS the other guard.
  Decide whether `U_SELF_DEFERRAL` increments the shared counter.
- **Am — MINOR:** class-mode flip has no endpoint/hot-reload (config.json field vs the global mode's
  dedicated endpoint+file → two stores, race, inconsistent state); the allow-classes ALREADY exist
  (`U_LEGIT_MISSING_INFO` = credential/choice, `U_LEGIT_COMPLETION`) — "reuse" not "add"; and the M8
  allow-override has NO structural backstop (purely judge-self-reported — safety rests on LLM precision
  + the soak).

**THE DECOMPOSITION the findings support:** SHADOW (observe-only: judge runs every turn-end, records to
StopGateDb, no block) is CLEAN + buildable now and gives the telemetry to even measure whether enforce
is worth it. ENFORCE carries ALL the hard items (AC1/AC2 unbuildable-as-specified, AM6 composition, AM4
marker, AM7 soak power, S1-S4 agent-forgeable graduation) as gated preconditions. Recommend: build
SHADOW first; design ENFORCE as a separate, carefully-converged follow-on.

---

# ROUND 3 findings — v3 Phase-A focused re-review (2026-07-04→05)

Three reviewers (adversarial re-check, scalability, decision-completeness) on the v3 SHADOW scope.
**All three converged on the same blocker.** Phase A is buildable + safe (blocks nothing) but NOT
converged as v3 wrote it. Folded into v4.

- **R3-C1 (CRITICAL, unanimous) — the four fields have no Phase-A path to the sink.** `validateResponse`
  reconstructs `AuthorityResult` as exactly `{decision, rule, evidencePointer, rationale}`
  (`UnjustifiedStopGate.ts:542-550`) → the four judge fields are dropped before the route can record
  them. Recording (the whole point of shadow) REQUIRES extending `AuthorityResult`/`validateResponse`
  on the ALLOW branch — which v3 mis-filed as Phase-B P-AC1/AC2. v3 was self-contradictory (FD3 said A,
  §10 said B). FIX (v4): the additive extension moved to Phase-A scope (FD6, §3.2 a-bis); §10 P-AC1
  split so only the continue-branch carve-out stays Phase B. AC1 (continue wall) IS sidestepped by
  allow-class; AC2 (field drop) is NOT — v3's "sidesteps the wall" overclaimed.
- **R3-M1 — `promptHash` can't be computed at the route** (prompt assembled inside `evaluate()`); AND
  the "exact assembled prompt at call time" scope defeats edit-detection (varies every call). FIX (v4):
  hash the STABLE `SYSTEM_PROMPT` template, computed in `evaluate()`, carried on `AuthorityResult`.
- **R3-M3/Q3/F2 — `StopGateDb` has no migration + no retention** (grep-confirmed: only
  `CREATE TABLE IF NOT EXISTS`, no `ALTER TABLE`/`user_version`/prune). v3's "schema migration adds the
  columns" + "inherits bounded retention" both asserted nonexistent mechanisms → columns silently never
  appear on deployed agents (INSERT throws), table grows forever. FIX (v4): BUILD the idempotent
  `PRAGMA table_info`+`ALTER TABLE ADD COLUMN` migration AND real age-based retention (FD7).
- **R3-M2 — shared `SYSTEM_PROMPT` coupling with the drift-death classifier** — the prompt edit is
  co-resident; needs a byte-for-byte regression fixture (existing classifications unchanged). FIX (v4):
  §3.2 c-ter + §7 regression tier.
- **R3-M4 — `U_SELF_DEFERRAL` collides with `U_LEGIT_DESIGN_QUESTION`** (the trap message is exactly the
  existing design-question shape). Needs prompt precedence + both-sides fixture. FIX (v4): §3.2 c-bis.
- **R3-Q2/Q4/m1/F6 — the transcript_path parse is unbounded + outside the fail-open stack.** FIX (v4):
  byte-capped reverse tail-read, entry-type filter, per-turn clamp, fail-open to empty `recentTurns` +
  `contextTurns` marker (§3.2 b-bis).
- **R3-Q1/F4/m2 — clarifications:** ZERO new LLM calls (folded into the one existing call); the enable
  key is `monitoring.selfDeferralGuard` dev-agent-gated (not `.shadow`/`.mode`) with defined off-behavior
  (FD8); `surface` derives from `getHotPathState().autonomousActive`.

**Converged/sound (kept):** AC1 sidestep real; shadow recording infra (event row + `mode`/`exit 0`)
exists; untrusted-content wire correct; no new hook/route/model; §10's deferral of the truly-hard
enforce items (AM6/AM4/AM7/S1-S3) is a clean cut. Direction + build APPROVED by operator 2026-07-05.
