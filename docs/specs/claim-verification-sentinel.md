---
title: "Claim-Verification Sentinel — tiered fact-checking of outbound claims"
slug: "claim-verification-sentinel"
author: "echo"
status: draft
# review-convergence / approved are written by Codey's spec-converge run + operator — NOT here.
---

# Claim-Verification Sentinel

## Problem statement

The single sharpest failure class of an LLM agent is **asserting a claim from memory or inference instead of from ground truth** — confabulation and conflation. It is the root of the incident that spawned this thread (I told the operator the mentee was "capped at ~4 lanes," conflating a per-session worktree count with the number-of-sessions axis; the authoritative operating-model document already carried the correct model, and I asserted from memory rather than reading it). The operator's framing: *a very well-tuned "claim verification" sentinel whose job is to detect claims in a message (of any sort) and fact-check them however possible — tuned to the criticality of each claim, with a team of subagents doing due-diligence verification. This is one of THE fundamental problems of current LLM agents, and it is directly a coherency problem.*

Instar already proves the pattern in miniature. The **time-claim check** (`core/time-claim.ts`) detects a claim about how long the session has been running and verifies it against the live session clock before the message sends — a NOT-SENT advisory fires when the claim contradicts ground truth. That is a **one-claim, single-oracle instance of exactly this sentinel.** This spec generalizes it: claims of any kind → criticality classification → verification "however possible" (a cheap deterministic lane + a subagent due-diligence lane), on the same fail-open advisory substrate.

## 1. Foundation (capability-grep evidence — the step the withdrawn context-wedge spec skipped)

`capability-grep`:
- `grep -rl "session-context" src/` → the five existing session-start context providers, each `{present, block}` + a `GET …/session-context` route (`core/OrgIntentManager.ts:200`, `core/PreferencesManager.ts:387`, `core/BootSelfKnowledge.ts:261`, `users/TopicOperatorStore.ts:166`, `PlaywrightProfileRegistry.buildSessionContextBlock`), assembled by `PostUpdateMigrator.getSessionStartHook()` (`core/PostUpdateMigrator.ts:9710`) + its compaction twin `getCompactionRecovery()` (`:10790`). — the substrate for **boot-loading a ground-truth source** (MECH-1).
- `grep -rl "OutboundAdvisory\|composeAdvisories\|preflight" src/` → the outbound preflight substrate: `POST /messaging/preflight` (`server/routes.ts:11321`), `messaging/OutboundAdvisory.ts` (`AdvisoryCode` union `:52`, static `GUIDANCE` table `:63`, `composeAdvisories` fail-open detector chain `:131`, `OutboundAdvisoryAudit` single-writer `:277`), client-side "NOT SENT — advisory" emission (`templates/scripts/telegram-reply.sh:269`, `exit 0` deliberate). — the substrate for **the sentinel's detect→verify→advise surface**.
- `grep -rln "detectTimeClaim\|time-claim" src/` → `core/time-claim.ts` (pure/total detector, `:160`; anchored regexes, generous tolerance `:144`; caller passes pre-computed clocks — the module stays pure). Route wiring + dev-gate at `server/routes.ts:11351` (`resolveDevAgentGate(...'messaging.outboundAdvisory.timeClaim.enabled', undefined)`). — **the exact template** this sentinel generalizes.
- Ground-truth READ surfaces already exposed (Registry-First): `GET /session/clock`, `GET /sessions[?scope=pool]`, `GET /commitments`, `GET /guards[?scope=pool]`, `GET /sessions/reap-log`, `GET /green-pr-automerge`, the GitHub PR API. The "however possible" verification is largely **wiring to read surfaces that already exist**, not net-new oracles.

**Foundation verdict:** the sentinel is a THIN generalization of a LIVE, proven pattern (TIME_CLAIM on the OutboundAdvisory substrate), not a new subsystem. No duplicate-engine risk (the context-wedge lesson): there is exactly one outbound-advisory preflight and one claim-detector pattern; this extends both.

## 2. Proposed design — three stages, criticality-tiered

The sentinel runs as an **outbound preflight** (the existing `/messaging/preflight` path), producing advisories — never a hard block.

### Stage 1 — Claim detection (LLM, one bounded pass)
An LLM pass over the outbound text extracts discrete factual claims. Each is a structured record: `{ span, claimType, referencedEntities, hedged }`. Claim-types seed a small open taxonomy: `temporal` (elapsed/remaining), `capacity/limit`, `completion` ("X merged / tests pass / done"), `cross-agent-action` ("I registered/sent/handed X"), `operator-decision` ("you approved / whose credential"), `state-fact` ("session Y is running"), `external-fact`. Hedged/opinion/first-person-intent spans ("I'll try", "I think") are marked `hedged` and drop to the lowest tier. This replaces TIME_CLAIM's single regex with a general extractor — but it stays one bounded pass over one message (like the tone gate), never a per-sentence investigation.

### Stage 2 — Criticality classification (the tractability pillar)
Each claim gets a criticality tier that sets its verification budget:
- **low** — hedged, opinion, already-quoted, or a claim with no actionable consequence → no verification (or a cheap deterministic check only).
- **medium** — a stateful fact with a cheap deterministic ground-truth source (clock, session/PR registry, commitment store, operating-model doc) → the **synchronous cheap lane** (Stage 3a).
- **high** — a load-bearing claim: a completion the operator will act on, a cross-agent action asserted as landed, a capacity/limit, an operator-decision attribution, or an irreversible-action precondition → the **subagent due-diligence lane** (Stage 3b).

Criticality is what makes the whole thing affordable: you do not investigate everything — you investigate what matters if wrong. **Fail-safe default: on classifier uncertainty, round UP a tier** (an unclassifiable claim is treated as at least medium; never silently dropped to low).

### Stage 3 — Verification "however possible" (a router → the cheapest sufficient verifier)

**3a. Synchronous cheap lane (deterministic ground-truth check).** Where a single oracle exists, verify inline — pure, fast, fail-open, exactly as TIME_CLAIM verifies against the clock. Router map (claimType → oracle):
- `temporal` → `GET /session/clock` (the existing check, now one entry in the table).
- `capacity/limit` → the **boot-loaded operating-model doc** (the first new source — MECH-1 below).
- `completion`/`state-fact` (session/PR/commitment/guard) → the matching Registry-First read (`/sessions`, PR API, `/commitments`, `/guards`, reap-log).
A contradiction → a `CLAIM_CONTRADICTION` advisory (fix + re-send), reusing the NOT-SENT surface. This lane runs inline in the preflight and is bounded like the tone gate.

**3b. Subagent due-diligence lane (the rich part — high-criticality only).** For high-criticality claims with no single deterministic oracle ("did this cross-agent handoff actually land?" — needs reading tool-traces/logs/PRs), the sentinel dispatches a **bounded team of verifier subagents**, each returning `{ verdict: supported|refuted|unverifiable, evidenceRef }`. Because this lane is expensive + slow, it runs in one of two modes by sub-criticality:
- **irreversible-action-precondition** (the top tier — "on whose approval", "the tests pass so I'm merging") → **synchronous hold**: accept the latency because the stakes justify it; the message holds on a NOT-SENT advisory until the sender resolves it.
- **everything else high** → **asynchronous**: the message SENDS (fail-open — latency preserved), and the verifier team runs out of band; a later `refuted` verdict raises a **correction/attention item** ("you told the operator X; verification found not-X") rather than gagging the already-sent message. This is the honest engineering answer to "a subagent team on every message would be too slow" — it reserves synchronous cost for the irreversible class only.

### The surface (signal-first, fails safe — the design line promised to the operator)
- Contradicted claim → NOT-SENT advisory (fix + re-send), reusing `OutboundAdvisory` + `telegram-reply.sh` verbatim.
- High-criticality **unverifiable** claim → a soften-or-confirm advisory (not a block).
- **NEVER a silent gag.** Fail-OPEN on every verifier error / unreachable oracle / classifier timeout (the message sends) — composes with *No Silent Degradation*: every detection + verdict is audited (metadata-only), the audit trail IS the report, and an async `refuted` becomes a visible correction, never a silent drop.

## 3. The two earlier mechanisms fold in as the first concrete pieces
- **Boot-injection of the operating-model doc (MECH-1):** a sixth session-context provider (mirror `BootSelfKnowledge.sessionContext` — byte-bounded delimited envelope, fresh-read per call; new `GET /<foundation>/session-context` route gated by `resolveDevAgentGate(...enabled, config)`; one fetch+concat block added to BOTH `getSessionStartHook()` and `getCompactionRecovery()`). This gives the sentinel (and me, every session) a **ground-truth source** for `capacity/limit` claims. Note: no operating-model doc surface exists on disk today (only `.instar/ORG-INTENT.md`), so this creates a new authoritative `.instar/` file + its reader. This piece has value on its own (the model is in front of me every session) AND is the sentinel's first non-clock oracle.
- **Operating-model / capacity claim-check (MECH-2):** the first NEW claim-type detector in the router (`capacity/limit` → the boot-loaded doc), mirroring TIME_CLAIM's pure-detector shape (`core/<detector>.ts`, code + `GUIDANCE` entry + fail-open push in `composeAdvisories`, dev-gated in the preflight route). This is the direct structural fix for the conflation that started the thread.

## 4. Phasing (ships dark; each phase independently valuable)
- **v1 (core, dark):** Stages 1–2 + the **synchronous cheap lane (3a)** with the deterministic oracles (temporal already live; capacity via boot-loaded doc; completion/state via the Registry reads) + the boot-injection source. This alone prevents the whole conflation/stale-state class inline, cheaply. Ships behind the dev-agent gate (`messaging.outboundAdvisory.claimVerification.enabled` omitted → live-on-dev / dark-on-fleet), advisory-only.
- **v2 (subagent due-diligence, dark):** Stage 3b — the criticality-high tier, the verifier subagent team, the sync-hold-for-irreversible vs async-correction split. Depends on v1's classifier + router being proven.
- The classifier's tier boundaries + the async/sync split are the parts that most benefit from real soak data before graduation off dark.

## Decision points touched
- **Claim-criticality classifier** — `judgment-candidate`. Competing signals ("how much does it matter if this claim is wrong?"). Floor: bounded action space (the fixed tier set low|medium|high|irreversible); conservative default = **round UP on uncertainty** (fail-safe); fallback ladder ends at a deterministic rung — classifier unreachable → treat every extracted claim as **medium** (cheap-lane deterministic check only, never a silent skip, never the expensive lane). Arbiter: the classifier LLM within that floor.
- **Verification routing (claimType → oracle)** — `invariant`. A deterministic table given the claimType + tier; justified (no competing-signal judgment — a temporal claim always routes to the clock).
- **Hold-vs-advise-vs-pass** — `invariant`. Deterministic given `(criticality, verdict)`: contradiction → advise; irreversible+unverified → hold; high+async+refuted → correction; else pass.
- **Claim detection (extraction)** — not a gate on information flow (it only *finds* claims to route); it feeds the classifier. Fail-open: extractor error → no claims → message sends.

## Multi-machine posture

The runtime preflight check is **stateless** and runs on whichever machine serves the send — identical to the existing `/messaging/preflight` + `OutboundAdvisory` path, which is already per-send-machine. No durable runtime state to replicate. The ground-truth oracles it reads are already pool-aware where it matters (`/session/clock` per-machine; `/sessions?scope=pool`; `/guards?scope=pool`). The one durable surface is the **claim-verification audit log**, which is machine-local by design.

machine-local-justification: operator-ratified-exception — the claim-verification audit is a per-machine record of what THAT machine advised on its own send path, identical in posture to the existing `logs/outbound-advisory.jsonl` (single-writer, per-send-machine); a pool-merged read is a follow-on, tracked, matching how other per-machine audit surfaces expose a merged view. (Ratification artifact ref: this spec's operator-approval commit, to be recorded at approval time — flagged for the integration reviewer to CONTEST whether a merged-read posture should be v1 rather than machine-local.)

## Self-Heal / degradation posture
Not a monitor/watcher that raises operator notices on first detection, so the escalation-gate self-heal ladder does not gate v1 (a preflight advisory is a per-send signal, not a recurring watcher). The **async v2 correction path** IS operator-facing on a `refuted` verdict — it must ride the existing attention surface with the standard P19 brakes (dedupe-key per claim, max-attempts on the verifier team, backoff) and route through the tone-gated `/attention` surface, never a per-claim topic flood. The verifier subagent team must carry `No Unbounded Loops` brakes (bounded team size, per-claim wall-clock, breaker).

## Testing
- Unit: the claim extractor (seeded claim corpus → expected claim-type/criticality), each deterministic oracle verifier (contradiction + agreement + unreachable→fail-open), the criticality round-up-on-uncertainty invariant, the hold/advise/pass decision table.
- Integration: full `/messaging/preflight` pipeline with the new codes, dev-gate on/off (503-when-dark parity), the NOT-SENT advisory emission for a contradicted capacity claim, fail-open on a downed oracle.
- E2E: a real send whose text contains a wrong capacity claim → NOT-SENT advisory → corrected re-send → delivered; a wrong completion claim caught against the live PR/registry.
- Adversarial: a claim crafted to dodge extraction (paraphrase); a high-criticality claim with a flapping oracle (breaker); the classifier timing out (→ medium fallback, message still sends).

## Frontloaded decisions / open questions
- **v1 scope is fixed** (cheap lane + boot source) — the subagent team is explicitly v2, so the build agent never stops mid-run to ask "should I add the subagent team?" (answer: not in v1).
- Open (for spec-converge, not blocking): the exact tier→sync/async boundary in v2 (which high claims hold vs correct-after); whether the boot-injected operating-model doc should be a new `.instar/` file or an extension of ORG-INTENT.md (the report shows ORG-INTENT is the only existing authoritative doc surface — reuse-vs-new is a converge decision).

## Migration parity (per the Migration Parity Standard)
- Boot-injection hook change ships to existing agents via the **always-overwrite** `migrateHooks()` (edit `getSessionStartHook()` + `getCompactionRecovery()` string builders — no `migrateSettings` needed since the settings.json registration is unchanged). **Reconcile** the stale standalone `src/templates/hooks/session-start.sh` (which lacks the session-context fetch blocks) so a NEW agent gets the same block as an updated one.
- The dev-gated `enabled` keys are OMITTED from `ConfigDefaults.ts` (→ `resolveDevAgentGate` decides); add an idempotent existence-checked stripper only if a stale default-shaped `enabled:false` could exist. Any non-gated tunable (byte caps, verifier team size, thresholds) gets a `migrateConfig` add-missing backfill.
- CLAUDE.md awareness (`generateClaudeMd()` + a content-sniff `migrateClaudeMd`) + a `CapabilityIndex` entry, per the Agent Awareness Standard.

---

## Operator directives (2026-07-20) — three first-class dimensions

The operator expanded the feature with three coupled directives. All three are first-class, not follow-ons — they are what turns this from a checker into a self-improving, self-cheapening system.

### A. Evolve/mature with usage + feedback (self-improvement loop)
The sentinel is NOT a static ruleset. Every verdict it produces is enrolled as a graded decision through Instar's existing LLM-Decision Quality machinery (annotate → deterministic grade-pass → per-model essence). Claims whose ground truth later becomes known feed back as settled grades. The criticality classifier's tier boundaries and each verifier's prompt are calibrated FROM these accumulated grades over time — not hand-tuned once. Foundation exists: the decision-quality meter (/decision-quality), correction-learning, and the benchmark-divergence detector are live; this rides them (no new engine).
- Decision-point: the calibration is ADVISORY input to the (still deterministic-floored) classifier — it never removes the round-up-on-uncertainty floor. A drifting calibration can only make the sentinel more conservative, never license a skipped check.

### B. Auto-detected special-case promotion (the cost/scale unlock — the sharp idea)
The general checker (expensive, large-model oversight) is the DEFAULT path. A SPECIAL-CASE MINER observes the stream of checked claims and detects claim SHAPES that (i) recur frequently AND (ii) are verifiable by a stable cheap oracle (the time/clock class → the live clock is the prototype). When a shape clears a promotion bar it is GRADUATED into a cheap dedicated checker — a deterministic rule or a small-model check — that thereafter handles that claim class inline, exactly the way the hand-built time-vs-clock check works today, only DISCOVERED automatically. The general model then only spends effort on novel/uncertain claims.
- **Promotion gate (the honest guard):** a shape graduates ONLY after (a) it clears a recurrence + confidence bar AND (b) the candidate cheap checker is VALIDATED against known-correct answers over a holdout — it must agree with the expensive path / ground truth above a threshold before it is trusted. A promoted checker whose live agreement rate later FALLS is auto-DEMOTED back to the general path. This structurally prevents baking in a fast-wrong shortcut.
- **Fleet-general:** the miner + the promoted cheap-checker library ship to EVERY Instar agent, so each grows its own special-case library from what it sees in the wild — not a central hand-authored set. The time-check becomes the SEED prototype, not the only case.
- Decision-point: promotion/demotion is a judgment-candidate with a deterministic floor (recurrence count + holdout-agreement thresholds are the invariant gate; the miner proposes, the thresholds dispose).

### C. Benchmark-corpus integration (the data flywheel — operator-named #1 benchmark scenario)
Every claim checked, paired with the answer eventually known to be correct (regardless of whether the first guess was right), is emitted as a LABELED benchmark data point: { claim-shape, claim-type, verifier door+model, verdict, eventual-ground-truth, cost, latency }. This is a real benchmark corpus generated as a BYPRODUCT of the feature doing its job. It feeds the existing benchmark work (the doorway/model registry + benchmark-divergence detector) to answer "which door+model is best per claim-type on cost/speed/accuracy" — the operator-named #1 benchmark-tuning scenario. The corpus is the SHARED substrate for both B (special-case validation holdout) and A (grade feedback).
- **Privacy:** the emitted record is scrubbed through the existing credential/PII scrub chokepoint — it stores claim SHAPE + verdict metadata + ground-truth + cost/latency (the tuning signal), never raw sensitive claim content.

## Revised phasing (folding A / B / C)
- **v1 (core, dark):** the 3-stage checker + the cheap deterministic lane + the boot-loaded operating-model source + EMIT the labeled corpus (C is cheap — logging with ground-truth backfill). The flywheel starts collecting data from day one, before B/A act on it.
- **v2:** the special-case MINER + promotion/demotion gate (B) + the subagent due-diligence lane.
- **v3:** closed-loop calibration (A) driving classifier/verifier tuning from the accumulated corpus + benchmark integration surfacing the per-claim-type door+model winners.
- Each phase ships dark → dry-run → live on the graduated-rollout track. The value compounds: A needs C's labels; B needs C's holdout; C is valuable on its own from v1.
