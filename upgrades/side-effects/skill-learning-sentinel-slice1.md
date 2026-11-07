# Side-Effects Review — Skill Learning Sentinel, slice 1 (observe, floor, shadow drafting, measurement)

**Version / slug:** `skill-learning-sentinel-slice1`
**Date:** `2026-11-06`
**Author:** `echo`
**Second-pass reviewer:** `echo (reviewer subagent) — required: a sentinel; inbound message hook chain; LLM arbiters`

**Spec:** `docs/specs/skill-learning-sentinel.md` (approved by Justin, topic 139880, 2026-11-06). This slice is §6
"slice 1": §3.1–§3.6, §3.9 (measure only), §3.10 read routes + proposal taps, console section, ladder entry.
**Tier:** 2 (new sentinel with LLM arbiters, new durable stores, a console surface). Ships **dark**
(`monitoring.skillLearning.enabled: false`; `mode: shadow` is the only mode this slice can run in — live writes are
slice 2).

## Summary of the change

A new sentinel, `SkillLearningSentinel`, that (1) records operator requests from the inbound message hooks into a
per-machine append-only ledger (segments + a derived SQLite cache), (2) classifies them in batches on a tick into
procedure keys with outcome attribution for the previous run, every verdict recorded through
`JudgmentProvenanceLog` and refused when the record did not land, (3) applies the deterministic evidence floor and
logs both the static default rung's and the arbiter's draft/wait/never verdict per key, (4) drafts a canonical skill
from the operator's verified messages and the agent's tool-call outline (`RunSlice`), has it reviewed by a different
model family, and writes it to `.instar/skill-learning/proposals/<name>/` only (no framework discovers it), (5) joins
skill-use telemetry to runs and computes per-skill scores and `measurableRate`, (6) exposes `GET /skills/learned`,
`GET /skills/learned/:name`, `POST /skills/learned/proposals/:name/{agree,disagree}` and a console section "What
I've learned to do" registered in `needs-model.js`, and (7) adds the `monitoring.skillLearning` ladder entry.

Files: `src/monitoring/SkillLearningSentinel.ts` (new), `src/monitoring/skillLearning/{Ledger,Classifier,Floor,
Drafter,RunSlice,Evidence}.ts` (new), hook-chain links in `src/commands/server.ts` (Telegram + Slack, chained after
the Human-as-Detector link), `src/server/skillLearningRoutes.ts` (new), `dashboard/console/learned-model.js`,
`dashboard/console/learned.js`, `dashboard/console/needs-model.js`, `src/data/feature-ladders.json`, tests at
three tiers.

## Decision-point inventory

- Structural pre-filter (§3.1) — **add** — `invariant`: provenance facts (`fromUser`, `forwarded`, `authorship`,
  verified operator binding, confirmation reply); each drop counted. No meaning is judged here.
- `repeatable` / `procedureKey` / key folding — **add** — `judgment-candidate`: the batch classifier; conservative
  default "not recorded"; fallback: retry next tick → visible backlog → `unknown`.
- Draft now / wait / never — **add** — `judgment-candidate` inside the evidence floor (≥2 occurrences, ≥1
  corroborated verified clean run, not covered); the static default rung (3/2/2 in 30 days) ACTS in this slice;
  the arbiter's verdict is LOGGED beside it and surfaced as a labelled proposal on the disagreement set — it never
  acts in slice 1 (evidence before authority).
- Outcome labels (§3.6) — **add** — `judgment-candidate`: `accepted` needs a delivered reply + explicit
  acknowledgement; `accepted-inferred` the routine-recurrence verdict; `corrected` the reviewer's attribution;
  default `unknown`.
- Semantic lint flags (description overlap, policy relaxation, ungrounded step) — **add** — signals handed to the
  cross-family reviewer; default when it cannot decide: refuse the draft (a proposal is never written).
- No outbound message is gated, delayed or rewritten. No session is spawned, killed or restarted. The only writes
  are to the sentinel's own ledger/cache/proposals/logs.

---

## 1. Over-block

- The structural filter drops Telegram rows whose `authorship` is UNRESOLVED or pre-layer, and any sender without
  a verified `TopicOperatorStore` binding. A real operator message that arrives before its binding is verified is
  not recorded (counted `not-operator`); it is picked up by the catch-up only if the stored row later carries the
  facts, else admitted as `unverified-catchup` support only. Conservative by design; the counters make the drop rate
  visible on the status route.
- Slack rows are support-only (asserted identity) — a Slack-only operator never gets a clean run and therefore
  never a draft. Stated in the spec (decision 4); Slack verification is not in this spec.
- A draft is refused when any clean run's tool-call outline is truncated (`draft-refused: evidence-cut`). Long
  autonomous runs will often exceed the per-run byte cap; those keys wait for a shorter clean run. Visible in the
  log and status counters.

## 2. Under-block

- `accepted-inferred` can credit a run the operator silently tolerated; it is half-weighted and excluded from the
  primary rung-2 metric (slice 1 only reports it).
- The classifier can fold two genuinely different procedures into one key; the misfire detector (slice 1 computes
  it from telemetry) and the operator's disagree tap are the backstops.
- A verified operator who pastes untrusted text (a forwarded email body, a web page) into their own message gets
  it treated as operator-authored; the provenance-of-references lint, the outline-only rule and the cross-family
  review are the mitigations, and slice 1 writes proposals only — nothing renders.

## 3. Level-of-abstraction fit

The sentinel is a consumer of existing seams (the inbound hook chain, `HumanAsDetectorLog` categories,
`TopicMemory`, `TurnEvidence`, the parity rule's canonical layout, `JudgmentProvenanceLog`, `featureEvidence`), not a
new authority over any of them. It does not extend `CorrectionLearning` (different keys, different ledger) but
copies its shed/rate-ceiling discipline. The classifier and drafter are routed internal LLM calls with component
ids — the same altitude as `TopicIntentExtractor`.

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [x] No — every deterministic check in this slice produces a signal or enforces a structural/provenance
  invariant; the only "block" is refusing to write a proposal file, which no message or action depends on.
- [x] The arbiters (classifier, drafter, reviewer) are LLM authorities with recorded reasoning, inside deterministic
  floors, and in this slice they act on nothing outside the sentinel's own proposal directory.

## 4b. Judgment-point check (Judgment Within Floors standard)

Every number in this slice is either a floor with a stated irreversible consequence or enumerable domain (≥1
corroborated clean run: nothing to learn from otherwise; ≥2 occurrences: the definition of recurrence; the money
ceiling), a static default rung that the arbiter must beat in shadow (3/2/2, 30 days), or a signal (growth notice,
measurable floor, Jaccard 0.6, batch 20, tick 10 min). The operator struck the previous hard caps on 2026-11-06; none
remain. Evidence before authority: this slice logs the arbiter beside the default and never lets it act.

---

## 5. Interactions

- **Hook chain:** the new links wrap the previous callback and call it first; a throw in the sentinel's link is
  caught and counted, never propagated (the Human-as-Detector and correction-capture links keep running).
  Verified by a unit test that the chain still calls every prior link when the sentinel throws.
- **Double-fire:** the correction sentinel and this one both see a correction-class message; they keep separate
  ledgers and the spec says a preference-phrased request reaches both. No shared state.
- **Races:** per-machine ledger segments (one writer each); the derived cache is rebuilt from segments; the
  classifier batch is idempotent by `source`.
- **Feedback loops:** the arbiter sees prior operator verdicts; it cannot act in this slice, so no loop closes.
- **Telemetry:** reads only the slice-0 per-machine files; rows with an absent `session_name`/`topic_id` are
  `unknown`, never "not used".

## 6. External surfaces

- New read routes and three PIN-gated taps (agree / disagree / the weekly label-audit samples); the console gains a
  section on the existing Learned page; a new `needs-model.js` need source (proposals awaiting a tap).
- New persistent state under `.instar/skill-learning/{ledger,proposals}/` (synced), `.instar/state/skill-learning.db`
  (derived, git-ignored), `logs/skill-learning.jsonl`, provenance rows.
- LLM spend: the sentinel's own `LlmQueue` with `maxDailyCents` 50; component ids `skillLearning.classifier`,
  `.drafter`, `.reviewer` so `/metrics/features` attributes every call.
- No Telegram message is sent by this slice. Dark on the fleet.
- Operator surface: agree/disagree on the console with the proposal body and paraphrases on the first screen.

## 6b. Operator-surface quality

1. Leads with the primary action: each proposal card opens with the skill's plain description, the paraphrases
   that triggered it, and the agree / disagree buttons (disagree asks for a one-word reason tag).
2. No raw internals as primary content: procedure keys, hashes and ids are de-emphasised support metadata; the
   body renders as text (`textContent`), never markdown→HTML.
3. Destructive actions de-emphasised: no destructive action exists in this slice.
4. Plain language + phone width: verified at 390×844 before merge (screenshot in the PR).

## 7. Multi-machine posture (Cross-Machine Coherence)

- Ledger and proposals: **replicated** as per-machine shards under `.instar/skill-learning/` (one writer each,
  git-synced; the cache is derived locally).
- Observation runs on every machine that receives messages (the hook chain), classification on every machine over
  its own pending rows; drafting is **single-writer** on the lease holder (coordination rule, lease-epoch fenced).
- Status route `GET /skills/learned` answers for THIS machine by default and names `machine`; `?scope=pool` (slice
  2) merges. No user-facing notice; no generated URL.
- The console section reads the local route; a dark holder shows "not switched on here".

## 8. Rollback cost

Flag off (`monitoring.skillLearning.enabled: false`) stops everything; a code revert removes the sentinel, routes
and console section. Left behind: ledger segments, proposals and the cache (inert files), provenance rows. No
data migration, no user-visible regression (dark).

## Deviations from the spec text (recorded per Decision Provenance)

The integration map (2026-11-06) found these seams differ from the spec's prose; the build follows the code, the
spec's intent is unchanged:

- (a) `authorship` is joined at read time, not on the live `LogEntry` → the Telegram seam filter is
  `fromUser && !forwarded && telegramUserId === TopicOperatorStore.getOperator(topicId)?.uid` (a verified binding).
- (b) No reply-to field on entries → an acknowledgement is the next operator message on the same topic after a
  delivered agent reply (topic + time); a `PendingConfirmation` reply is matched by topic + send-time window.
- (c) Fail-closed provenance keys on `JudgmentProvenanceLog.recordDecision()` returning null or a positive
  `writeErrors` delta since the last tick — not on the decision-quality meter's dry-run flag.
- (d) Slack catch-up is impossible today (dual-write bug, feedback filed) → Slack rows come from the live hook only,
  support-only, `identity: asserted`.
- (e) `checkMandatePin` is a closure inside `createRoutes` → extracted to an exported helper
  (`src/server/mandatePin.ts`) the new routes call with a skill-specific message.
- (f) `skillParityRule.remediate` throws `CanonicalSkillError` on `user-edit-conflict`; `readCanonicalSkill` and
  `verifyRendering` are exported for the drafter/lint.
- (g) Hook-chain idiom: capture the previous `onMessageLogged` and call it first; Slack had no Human-as-Detector
  link, so the sentinel's Slack link is the first in that chain.
- (h) LLM calls go through the sentinel's own `LlmQueue` into `sharedIntelligence.evaluate` with component ids
  `skillLearning.{classifier,drafter,reviewer}` registered in `componentCategories`, `llmBenchCoverage` and
  `provenanceCoverage` (CI ratchets); an admission error is a rejected promise → counted, retried next tick.
- (i) `boundedHead/Tail` are char-based; transcript paths come from `resolveFrameworkTranscriptPath`.
- (j) Attention items: `telegram.createAttentionItem(obs, { conditionKey, sticky, lane, needsUser, silent })`;
  self-heal close via `updateAttentionStatus(id, 'DONE', { closedBy: 'cause-cleared' })` (slice 3).
- (k) `TopicMemory.getMessagesSince(topicId, sinceIso, limit)` is the catch-up reader.
- (l) Routes copy the `createQueuePaceRoutes` module idiom and mount beside it in `AgentServer`; the console section
  lives in `renderLearned` with pure functions in `learned-model.js`; the ladder entry already landed in slice 0.
- (n) The standby pre-validates the operator PIN before forwarding a tap to the lease holder (the holder re-checks
  it), which is stricter than the spec's "forward unchanged" text; recorded as a deliberate deviation (safer, and a
  bad PIN never crosses the mesh).
- (o) `startServer` in server.ts sits at TypeScript's control-flow-analysis limit (TS2563); the sentinel is wired
  through ONE expression (`startSkillLearning(...)` in `src/monitoring/skillLearning/wire.ts`, replacing the
  reconciler's own `start()` call) and bound to `AgentServer` through a constructor option, not new statements.
  The judgment-provenance log and the topic-operator store are constructed later in boot and are read through
  lazy proxies: a missing log fails CLOSED (`recordDecision` → null ⇒ no verdict recorded, row stays pending).
- (m) A shared contract file `src/monitoring/skillLearning/types.ts` holds the row shapes, the `LedgerReader`
  interface and the status shape so the three builders meet on one definition (config field names follow slice 0's
  `SKILL_LEARNING_DEFAULTS`: `defaultGate.{minSupport,minDistinctDays,minDistinctSessions,windowDays}`).

## Conclusion

Written before the build from the approved spec; the integration map and the build may change file names, not
decisions. The reviewer subagent appends below.

## Class-Closure Declaration (display-only mirror)

`defectClass: unbounded-self-action`, `closure: guard`, `guardEvidence: {enforcementType: ratchet, citation:
tests/unit/self-action-convergence.test.ts, howCaught: the sentinel's tick is registered as controller
skill-learning-tick; under sustained pressure its LLM emits are bounded by the pending-row count per batch, the
spend ceiling and the per-topic rate ceiling (steady-state bound: zero calls once the backlog is empty), and a
failed batch is retried next tick, never within one (settling brake)}`. No other agent-authored-artifact defect is
fixed in this slice.

## Second-pass review

_(appended by the reviewer subagent)_

**Concern raised:** the sentinel has no production wiring — nothing in `src/` constructs or binds it, so with the flag on the feature is dead, not dark — and three design-level gaps (lease gating, a 30-day floor delay, the arbiter's `never` acting) contradict the artifact's own answers.

Reviewed independently against the code (2026-11-06, read-only; tests not run). Findings:

1. **blocks-now** — `src/commands/server.ts` constructs none of `Ledger`/`SeamFilter`/`Classifier`/`Outcomes`/`SkillLearningSentinel`, never calls `installSkillLearningSeamFilter()` (`src/monitoring/skillLearning/SeamFilter.ts:236`) nor `AgentServer.setSkillLearningSentinel()` (`src/server/AgentServer.ts:833`); only the two links exist (`server.ts:17576`, `:18259`). Flag on ⇒ the links count `unlinkedMessages`, routes answer 503, no observation, no tick, no LlmQueue. The "feature is alive" E2E (`tests/e2e/skill-learning-alive.test.ts:95`, `:136`) binds the sentinel by hand and so does not mirror the production init path (Testing Integrity, Tier 3). Fix: wire in server.ts behind the flag — ledger `start()` off the boot path; seam filter with `operatorUidForTopic = getTopicOperatorStore().getOperator(topicId)?.uid` (verified-only, confirmed at `src/users/TopicOperatorStore.ts:359`); classifier + outcomes with the sentinel's own queue; `installSkillLearningSeamFilter`, `setSkillLearningSentinel`, `start()` — then an E2E that boots that path. If builder 1B is mid-edit here, this stands until it lands.
2. **major** — Drafting is not lease-gated. §7 above says single-writer on the lease holder; `SkillLearningSentinel.evaluateKeys` (`src/monitoring/SkillLearningSentinel.ts:249-312`) and `Outcomes.tick()` (`src/monitoring/skillLearning/Outcomes.ts:158-178`, which finalizes EVERY machine's provisional rows) take no `holdsLease` dependency. Two flagged machines draft one key into the same synced `proposals/<name>/` (sync conflict) and write competing outcome revisions — the double-write §3.6 forbids (the reducer counts it; it should not happen). Fix: add `holdsLease: () => boolean` to the deps; skip the `keys`/`growth` phases and the outcomes finalization + late-flip when false; status names `observeOnly: true`. Observation and classification stay on every machine.
3. **major** — Over-block §1 does not list: every non-`corrected` label is written `provisional: true` (`Outcomes.ts:204`) and finalizes only after `windowDays` = 30 (`Outcomes.ts:171-177`); `evaluateFloor` skips provisional rows (`src/monitoring/skillLearning/Floor.ts:101`). Net: no key passes the floor until ≥30 days after its first accepted run, so "the arbiter may act earlier than the default rung" (spec §3.3) is impossible and the rung-1 sample starts a month late. The spec makes timeout outcomes provisional and calls `accepted` corroborated by the explicit ack. Fix: count `accepted` / `accepted-inferred` as clean while provisional (a later flip to `corrected` already removes them); keep `unknown`/`weak-positive` out.
4. **major** — The arbiter DOES act in slice 1: an unexpired arbiter `never` suppresses a default-rung `draft` (`src/monitoring/skillLearning/Arbiter.ts:376-377`, `SkillLearningSentinel.ts:356`), while the inventory and §4b above say it "never acts". Consequence for the positive control: the direction "default would draft; arbiter says never" yields no proposal, so no operator tap ever samples it — the shadow comparison measures one direction only. Fix: in shadow still write the proposal with a tri-state label (`disagreement: 'arbiter-only' | 'default-only' | null` on the sidecar + `ProposalSummary`) and let `never` suppress only the re-ask; or correct §4b and the spec sentence and record the asymmetry as accepted.
5. **minor** — §1 says the seam drops `authorship` UNRESOLVED rows; `SeamFilter.ts:121-132` has no authorship check (deviation (a) is what the code does; `DropReason` has no such reason). §1 also says catch-up can grant full standing; `catchUp` (`SeamFilter.ts:155-172`) always admits `unverified-catchup` and admits ANY `fromUser` sender (no binding check), so non-operator text reaches the classifier prompt (spend + prompt surface; no ledger effect beyond `occurrences`). Fix the artifact text; check the binding in catch-up or skip classifying unbound catch-up rows.
6. **minor** — The standby pre-validates the PIN before forwarding (`src/server/skillLearningRoutes.ts:108-110`); spec §3.2 says it never does. Safer, but a PIN that differs between machines fails on the standby and the lockout counts there. Record as deviation (n) or move the check below `holderUrlOf`.
7. **minor** — New persistent state missing from §6: `skill-learning/sentinel-state.json` (`SkillLearningSentinel.ts:192`) has no machine suffix inside a synced dir. Fix: `sentinel-state.<machineId>.json`, or put it under `state/`.
8. **minor** — `classifyUnreadable` (`src/monitoring/skillLearning/Classifier.ts:325-341`) permanently classifies a row `repeatable:false` after 3 text misses, recorded `arbiter: true`. Not a gate on anything user-facing, but TopicMemory lag makes it lossy. Fix: a re-openable state, and record it `arbiter: false` (it is the deterministic default, not a judgment).
9. **minor** — `attachSkillLearningSeams` (`SeamFilter.ts:299`) is unused in `src/`; the chain-throw test at `tests/unit/skill-learning-seam-filter.test.ts:177` exercises it while production uses `contained()` (covered at `:234`). Delete the helper or label the test.
10. **minor** — §4 says the arbiters act on nothing outside the proposal directory; a struck policy-relaxation line also raises a silent attention item (`SkillLearningSentinel.ts:548`) and every verdict writes ledger rows. Spec-sanctioned; name them.
11. **minor** — `Outcomes.readTelemetry` (`Outcomes.ts:328-348`) re-reads every telemetry file on every run close and every `measurableRates()`. Fine dark; an offset cache before slice 2.

Confirmed clean: no `rmSync`/`unlinkSync`/`rmdirSync` outside `SafeFsExecutor` (`Ledger.ts:243,310,331`; `SkillLearningSentinel.ts:146`); no TODO/stub; proposals land only at `<stateDir>/skill-learning/proposals/<slug>` with the slug validated by `SKILL_NAME_RE` before the join (`SkillLearningSentinel.ts:490,604`); `.instar/skills`, `.claude/skills`, `.agents/skills` are read only (`:641-659`, `:754-765`); the ledger stores `source` + the scrubbed ≤160-char paraphrase, never text (`Ledger.ts:380-386`; `SeamFilter.ts:183-215` passes `text` only to the pure detector); provenance fail-closed holds — classifier refuses on `recordDecision` null or a `writeErrors` delta (`Classifier.ts:190-199`, `:294-299`, `:336`), sentinel refuses on a null id at all three calls (`:390-394`, `:417`, `:477`, `:542`); component ids are literals at every call site (`Classifier.ts:241`, `SkillLearningSentinel.ts:381-382`) and registered in `componentCategories.ts:147-149`; the contract in `types.ts` is honoured by all three halves (sentinel implements `SkillLearningSentinelLike`, routes consume it, console reads `SkillLearningStatus` fields; the E2E builds a literal `SkillLearningStatus`); `mandatePin.ts` is the one gate and `routes.ts:14925` delegates to it; the console renders every drafter string through `text:` (textContent), never markup (`dashboard/console/learned.js:105-110`); `needs-model.js` registers the need source; the floor is count-only with no time bound, 3/2/2@30d is the default the arbiter must beat, the growth notice refuses nothing, no hard cap found; no deterministic check gates any message or action — the only refusal is a file not written. Rollback as §8 states (flag off + restart; revert leaves inert files).

### Re-review

Re-verified against the code after the fixes (read-only; tests not run).

- (1) Wiring lands: `src/monitoring/skillLearning/wire.ts:73` `startSkillLearning` is called once at `src/commands/server.ts:15379` and the result is handed to `new AgentServer({ … skillLearningSentinel })` (`:31758`; `AgentServer.ts:1402,1520`). `SkillLearningSentinel.create` (`SkillLearningSentinel.ts:771-872`) builds the real `Ledger`, `Outcomes`, `SeamFilter` (operator = `asVerifiedOperator(topicId)?.uid`, verified-only), `Classifier` on the sentinel's own `LlmQueue`, and `start()` installs the seam filter and opens the cache off the boot path. Provenance and the operator store are lazy proxies that fail closed (`wire.ts:91-103`; `_judgmentProvenance` is built at `server.ts:25343`, `_agentServerRef` at `:32318`, both after the sentinel starts, and read at call time). Covered by `tests/unit/skill-learning-wire.test.ts:51-140`, including the source-level check that server.ts calls it once with the real seams.
- (2) `holdsLease` is threaded (`wire.ts:48`, `server.ts:15379`, `SkillLearningSentinel.ts:258-259,292-296`, `Outcomes.ts:177,216`): a non-holder runs ingest/classify/close and skips keys, growth, finalization and the late flip; status names `observeOnly`.
- (3) `Floor.ts:85-106` counts `accepted` / `accepted-inferred` while provisional; `unknown` / `weak-positive` stay out.
- (4) `Arbiter.ts:236-246`: a default `draft` always drafts; `never`/`wait` only hold their own re-ask; `disagreement` is tri-state on the sidecar, summary and log (`types.ts:180,199`; `SkillLearningSentinel.ts:640,646,943`), tested both directions (`tests/unit/skill-learning-arbiter.test.ts:86-115`, `skill-learning-sentinel.test.ts:208-227`).
- (5) `catchUp` applies the structural filter (`SeamFilter.ts` — `not-user` / `forwarded` / `not-operator` counted); (6) deviation (n); (7) `sentinel-state.<machineId>.json` (`:256`); (8) `arbiter: false` (`Classifier.ts:334`); (11) telemetry parse cache by (size, mtime) (`Outcomes.ts:336-368`). Deviation (o) explains the single expression.

Remaining, none blocking:
- minor — the console does not show the `disagreement` label; `proposalCardText` (`dashboard/console/learned-model.js:246-254`) ignores it, so the operator cannot see which rung dissented (spec §3.3 "labelled"). Add one line: "the static rule would have waited" / "my own judgment would have waited".
- minor — `retryAfter` on `RequestRow` (announced as in flight) is not in `types.ts` / `Ledger.pendingRows` yet; an unreadable row is still classified `not-repeatable` for good.
- minor — the classifier's *attributed* revision (`Outcomes.ts:204-213`) is not lease-gated, unlike finalization and the late flip. In practice the observing machine is the holder (Telegram ingress is lease-gated), so note it rather than fix it now.
- minor — `holdsLease` reads `true` while `leaseCoordinatorRef` is still null during boot (`server.ts:15379`); the first tick is 10 minutes in, so harmless, but `wire.ts` could default to observe-only until the ref exists.
- note — server.ts now imports `SkillLearningSentinel.js` → `Ledger.js` → `better-sqlite3` statically; `routes.ts` and `MessageProcessingLedger.ts` already do the same, so this is not a new boot-failure class, but the SeamFilter.ts header (`:28-31`) overstates that the native module never loads at boot.

**Concur with the review.**

**Follow-up (2026-11-06, ratchet):** slice 0's fail-safe catches are marked (cherry-picked); the two slice-1 catches the no-silent-fallbacks scanner flagged (`SkillLearningSentinel.start` bound-start failure, logged; the per-phase guard that records `phaseFailures` + a degradation row) now carry in-window `@silent-fallback-ok` reasons. No behaviour change.

**Follow-up (CI, 2026-11-07):** `tests/unit/SqliteRegistry-wiring.test.ts` requires every long-lived better-sqlite3 store to be allowlisted and to register its handle; the ledger cache now keeps the unregister fn and calls it in `close()` (the registry contract), and is allowlisted. No behaviour change.

**Docs-site addition (2026-11-07):** `site/src/content/docs/reference/cli.md` and `site/src/content/docs/guides/test-as-self.md` document `instar test-as-self` (docs-coverage command floor). Documentation only.
