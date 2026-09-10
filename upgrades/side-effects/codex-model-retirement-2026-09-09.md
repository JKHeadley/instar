# Side-Effects Review — Codex model retirement 2026-09-09: relive the tier map, the safety floor, and the 404 self-heal path

**Version / slug:** `codex-model-retirement-2026-09-09`
**Date:** `2026-09-09`
**Author:** `Echo (instar-dev agent)`
**Second-pass reviewer:** `required — see Second-pass review below`

## Summary of the change

OpenAI retired the whole gpt-5.4/5.5 generation from the ChatGPT-account Codex surface. Instar
had those ids hardcoded in **three** places that pick a model, so every internal codex LLM call
— every sentinel, gate and reflector — failed instantly on every machine in the fleet. Worse,
the retirement also killed `CODEX_CHATGPT_FALLBACK_MODEL`, the floor the existing
model-retirement self-heal retries onto, so the self-heal swapped one rejected model for another
and the agent stayed dark. A fourth defect kept the self-heal from firing at all for one of the
two retirement shapes.

Files touched:
- `src/providers/adapters/openai-codex/models.ts` — `TIER_TO_MODEL` (fast/balanced →
  `gpt-5.6-sol`, capable → `gpt-6-astra`) and `CODEX_CHATGPT_FALLBACK_MODEL` → `gpt-5.6-sol`.
- `src/core/frameworkSessionLaunch.ts` — the second (session-launch) codex tier map, plus the
  two `?? 'gpt-5.5'` codex last-resort defaults.
- `src/providers/adapters/openai-codex/observability/eventNormalizer.ts` —
  `classifyCodexErrorMessage` now also recognises Codex's **404** model-removal wording, which
  previously fell through to `'unknown'`.
- `tests/unit/codex-model-tier-resolution.test.ts`,
  `tests/unit/providers/adapters/openai-codex/observability/eventNormalizer.test.ts`,
  `tests/unit/codex-cli-provider-execjson.test.ts` — coverage + de-hardcoding.

All model ids here are **live-probed, never guessed** (probe run 2026-09-09 against the
operator's ChatGPT subscription): `gpt-5.6-sol` and `gpt-6-astra` answered a trivial prompt;
`gpt-5.4-mini`, `gpt-5.4`, `gpt-5.6`, `gpt-6`, `gpt-5.6-mini` and `gpt-6-mini` returned
400 "not supported when using Codex with a ChatGPT account"; `gpt-5.5` returned 404.

## Decision-point inventory

- `classifyCodexErrorMessage` (`eventNormalizer.ts`) — **modify** — widened by one narrow
  pattern. It is a pure classifier: it returns a label and holds no block authority. Its label
  is consumed by the retry authority in `CodexCliIntelligenceProvider.evaluateWithModelObserved`.
- `TIER_TO_MODEL` / `resolveModelForFramework('codex-cli', …)` — **modify** — data maps, not
  decision points. They select *which* model answers, never *whether* a call is permitted.
- `CODEX_CHATGPT_FALLBACK_MODEL` — **modify** — the retry target the existing authority uses.
  The authority itself is unchanged.

No decision point is added, removed, or given new authority.

---

## 1. Over-block

No block/allow surface is added — but the classifier change does widen a **retry** trigger, and
the honest over-fire question is: what non-retirement error could now be misread as a retirement
and cause one extra model swap?

The pattern requires Codex's exact wording *with a quoted model id*:
`The model \`X\` does not exist or you do not have access to it`. Concretely rejected by the
pattern (verified by an explicit negative test): a bare `404 Not Found`, a generic
`unexpected status 404 Not Found: no such endpoint`, and `The file does not exist or you do not
have access to it.` The residual over-fire case is a genuine **entitlement** failure — an
account that legitimately lacks access to a model it named. That case now retries once on the
verified floor and succeeds, which is the desired behaviour, not a defect; the alternative is
the pre-change behaviour where the call fails permanently.

There is a second over-fire direction, and it is the deliberate price of the lower ordering
bound described in §5: a genuine `timeout` / `network` / `malformed-response` failure whose
message *also* carries the retirement wording now reads `unsupported` rather than its specific
kind. That is the trade for not letting `/ECONN/i` swallow the real outage message, and the
underlying cause — the over-broad `network` substring match — is disclosed as under-block item 5.

Worst case cost of a false positive, in either direction, is bounded: exactly **one** extra
bounded subprocess call. The retry is never recursive (the authority refuses to retry when the
model already equals the floor), and the retry authority remains the only behavioural consumer
of the label.

---

## 2. Under-block

Five failure modes remain, all stated rather than fixed here:

1. **A fourth retirement shape.** If OpenAI invents new wording, the classifier will not
   recognise it and the fleet goes dark again in exactly this way. This change hardens the two
   *observed* shapes; it does not make the classifier self-discovering.
2. **A floor that dies without anyone probing.** The floor is now live, but nothing
   continuously verifies it. If `gpt-5.6-sol` is retired, `TIER_TO_MODEL` and the floor die
   together again — the identical failure to the one being fixed. The structural answer is a
   scheduled live probe that alarms on floor death; it is **not** in this PR.
   <!-- tracked: CMT-1406 -->
3. **`KNOWN_CODEX_MODEL_IDS` still lists retired ids** (`gpt-5.2`, `gpt-5.3-codex`, `gpt-5.4`,
   `gpt-5.4-mini`, `gpt-5.5`). A topic pinned to one of those is accepted by the pin validator
   and then fails at call time. Curating that list needs a per-id live probe as evidence, so it
   is deliberately out of this change rather than guessed at. <!-- tracked: CMT-1406 -->
4. **The codex hook-arming path still names a model retired in June.** `src/commands/init.ts`
   and `src/core/PostUpdateMigrator.ts` both hardcode `model: 'gpt-5.2'`, which feeds
   `makeTmuxTrustDriver` and reaches a real launch line in `src/core/codexHookArm.ts`
   (`${codexBinary} -m ${model}`). `gpt-5.2` has been retired since 2026-06-03 by this repo's
   own record. Surfaced by the second-pass review. Impact is unverified and probably benign —
   the TUI trust prompt renders before any model request and arming is fail-soft — but it is a
   live model-choice site naming a dead id, and the decision-point inventory above should not be
   read as exhaustive. Not fixed here (different path, different failure mode, anti-bundling).
   <!-- tracked: CMT-1406 -->
5. **The `network` classification is over-broad and this change had to route around it.**
   `/network|ECONN|ETIMEDOUT|dns/i` is a substring match, so ANY message containing the word
   "Reconnecting" classifies as a network error — "R-ECONN-ecting". That is a pre-existing
   latent defect: Codex prefixes its retries with "Reconnecting... N/5", so a broad class of
   non-network Codex errors is currently mislabelled. This change does not fix it; it places the
   new branch above `network` so the retirement message is not swallowed, and pins that bound
   with a test. Narrowing `ECONN` to a token match is a separate fix.
   <!-- tracked: CMT-1406 -->
6. **The 400 retirement branch still sits above `auth` — the identical defect, one branch up.**
   The pre-existing 400 branch matches before `auth`, so
   `403 Forbidden: The 'gpt-5.5' model is not supported when using Codex with a ChatGPT account.`
   masks a real auth failure exactly the way the new branch would have before it was moved. The
   file now carries two opposite ordering policies, and the 400 branch's own comment ("Keep it
   ahead of generic auth classification … but must surface every neighboring 400/auth/rate-limit/
   network failure unchanged") is self-contradictory. Realism is low — no observed 400 retirement
   body carries an auth token — and anti-bundling argues against changing a pre-existing branch
   here, but it is recorded so the next reader does not have to rediscover it. Surfaced by the
   second-pass re-review. <!-- tracked: CMT-1406 -->

---

## 3. Level-of-abstraction fit

Correct layer, and the change deliberately does **not** climb.

`classifyCodexErrorMessage` is a **detector** — a cheap regex over an error string returning a
structured label. It is exactly what the signal-vs-authority doc lists as an allowed detector
("Regex / literal matchers"). The **authority** — the decision to retry, and on what — already
exists one layer up in `evaluateWithModelObserved`, which gates the retry on three conditions
(not already the floor, label is `'unsupported'`, floor is in `KNOWN_CODEX_MODEL_IDS`). This
change feeds the existing authority a signal it was previously blind to. It does not add a
parallel retry path, and it does not move any decision into the detector.

The tier maps sit at the adapter layer, which is where a framework's concrete model vocabulary
belongs. The duplication between the two maps is pre-existing (documented as "keep in lockstep")
and is now covered by a test that asserts both resolvers agree with `KNOWN_CODEX_MODEL_IDS`, so
the lockstep is machine-checked instead of comment-enforced.

---

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [x] **No** — this change produces a signal consumed by an existing smart gate.

The widened classifier emits a label; the pre-existing retry authority consumes it. No brittle
check gains blocking power. The tier-map and floor edits have no block/allow surface at all —
they are data. The one place this change touches a validation gate is *read-only*: the new test
asserts that every resolved tier is already a member of `KNOWN_CODEX_MODEL_IDS`, so the change
cannot produce a model the spawn route or pin validator would reject.

---

## 4b. Judgment-point check (Judgment Within Floors standard)

No new static heuristic at a competing-signals decision point. The classifier's domain **is**
enumerable and is an invariant: it matches two literal, vendor-emitted error strings. There are
no competing live signals to weigh — the message either carries Codex's retirement wording or it
does not. The retry authority that consumes the label is unchanged by this PR.

---

## 5. Interactions

- **Shadowing: the branch's POSITION is load-bearing in both directions, and the first draft of
  this change got it wrong.** The initial placement (immediately after the 400 branch, above
  `auth`) genuinely did shadow: a single Codex message can carry BOTH a specific failure token
  AND the model-not-found wording — e.g. `unexpected status 403 Forbidden: The model \`x\` does
  not exist or you do not have access to it` — and matching first reclassified real `auth`,
  `rate-limit` and `quota` failures as a retryable retirement. The original negative test
  (`401 unauthorized` alone) did not cover the combined message and so was not evidence for the
  claim it was offered as. Surfaced by the second-pass review.
  The obvious correction — move the branch to the end of the chain — is ALSO wrong, and failed
  loudly when tried: `network` matches `/ECONN/i` as a substring, and Codex prefixes its retries
  with `Reconnecting... 2/5 (…)`, so `R-ECONN-ecting` captured the real outage message and the
  self-heal never fired. The branch now sits BETWEEN `rate-limit` and `timeout`: specific,
  actionable failures still win above it; the loose substring patterns cannot swallow it below.
  Both bounds are pinned by tests (a combined-message test per specific kind, and a test using
  the verbatim outage message), so neither move can silently regress.
- **Double-fire:** no. The retry authority is single-shot by construction — its first guard is
  `model !== CODEX_CHATGPT_FALLBACK_MODEL`, so a retry that fails on the floor throws rather
  than looping.
- **Races:** none. Both edits are pure functions over their inputs with no shared mutable state.
- **Feedback loops:** one worth naming, in the *good* direction. `PromptGate` caches its
  "nothing here" verdict only on a successful verdict, so while codex calls were failing it
  re-fired every tick per session (~2,760 calls/hour observed on one machine) and saturated the
  host spawn cap, which then shed *other* components' calls — a self-sustaining outage. Making
  codex calls succeed collapses that loop. The underlying `catch {}`-with-no-backoff in
  PromptGate is a genuinely separate defect and ships as its own PR rather than being bundled
  here. <!-- tracked: CMT-1406 -->

---

## 6. External surfaces

- **Other agents / install base:** yes, and this is the point — every codex-routed agent gets
  working internal LLM calls again. Behaviour change is strictly failure → success.
- **External systems:** the model id sent to the Codex CLI changes. No API contract, no
  auth surface, no wire format changes.
- **Cost, stated honestly:** these calls were failing at **zero** token cost, so restoring them
  makes real spend appear where there was none. Measured on the operator's fleet after the
  equivalent hot-patch: ~650 internal calls/hour at ~15k input tokens each, of which roughly
  15k per call is Codex CLI's fixed per-invocation overhead (openai/codex#19996), not prompt.
  This is the correct trade — working background checks cost money; broken ones only looked free
  — but it is a real bill and is called out in the release notes rather than buried.
- **Persistent state:** none. No ledger, database, or memory-file shape changes.
- **Operator surface:** no operator-facing action is added or touched. Not applicable.

---

## 6b. Operator-surface quality

No operator surface — not applicable. This change touches no dashboard renderer, approval page,
or grant/revoke/secret-drop form.

---

## 7. Multi-machine posture (Cross-Machine Coherence)

**machine-local BY DESIGN — and the reason matters here.** Which codex model ids a machine can
reach is a property of *that machine's installed Codex CLI and its logged-in account*, not of
the agent. The 2026-07-09 comment in `KNOWN_CODEX_MODEL_IDS` records exactly this: older CLI
versions 400 with "requires a newer version of Codex" for ids a newer CLI accepts. Replicating a
model choice across machines would therefore propagate a *wrong* answer to a machine with a
different CLI version. Each machine resolves the same code against its own CLI and account.

- **User-facing notices:** none emitted. No one-voice gating needed.
- **Durable state:** none held, so nothing strands on topic transfer.
- **Generated URLs:** none.

The change ships identically to every machine through the normal release path, which is the
correct distribution mechanism — and is precisely what a per-machine `node_modules` hot-patch is
**not**: the hot-patch applied during the incident was silently erased by auto-update 1.3.1232
on the first machine to update, which is the reason this had to land in source.

---

## 8. Rollback cost

- **Hot-fix release:** revert the commit, ship as the next patch. Pure code change.
- **Data migration:** none — no persistent state written or read.
- **Agent state repair:** none. Agents pick up the change on their normal auto-update.
- **User visibility during rollback:** reverting restores the outage (every internal codex call
  fails again), so a revert is only correct if the new ids themselves prove wrong — in which
  case the right move is to re-probe and re-point forward, not to revert. Stated plainly because
  "revert is cheap" would be misleading here: revert is *mechanically* trivial and
  *operationally* a return to a fleet-dark state.

---

## Conclusion

The review surfaced three things the first pass had wrong or missing, all now folded in. First,
the initial scope assumed the self-heal had to be *built*; re-grounding on current `main` showed
it already exists and only its **floor** was dead — so the fix is far smaller and more surgical
than briefed. Second, the 404 retirement shape was never classified, which meant the self-heal
could not have fired for `gpt-5.5` no matter how healthy the floor was; shipping the floor alone
would have left a known hole and been a deferral in disguise. Third, a mechanism test hardcoded
the old floor name, so it would have re-broken on every future floor move — it now asserts
against the constant.

Four related defects are deliberately **not** bundled, per this skill's anti-bundling rule, and
all are tracked to CMT-1406: PromptGate's missing error backoff, the stale retired ids in
`KNOWN_CODEX_MODEL_IDS`, the June-retired `gpt-5.2` still hardcoded into the codex hook-arming
launch line, and the over-broad `network`/`ECONN` substring match (plus the 400 branch's mirror
of the ordering defect just fixed). Clear to ship pending second-pass concurrence.

---

## Second-pass review (if required)

Required: this change touches a recovery path (the model-retirement self-heal) and an error
classifier feeding it.

**Reviewer:** independent reviewer subagent (fresh read of artifact + diff + principle doc)
**Independent read of the artifact: round 1 CONCERN → resolved → round 2 CONCUR**

Two concerns raised, both legitimate, both acted on:

1. **The §5 shadowing claim was factually wrong.** The reviewer reconstructed the branch chain
   and diffed old-vs-new classification over crafted messages, showing that a message carrying
   both an auth/throttle token and the model-not-found wording flipped from `auth`/`rate-limit`/
   `quota` to `unsupported`. Correct, and the cited negative test did not cover it.
   **Resolved by code change, not by rewording:** the branch was moved below
   `auth`/`quota`/`rate-limit`, a per-kind combined-message ordering test was added, and §5 now
   states the truth.
   *One correction to the reviewer's own recommendation, worth recording:* they recommended
   moving the branch to the very end of the chain and stated they had verified the real outage
   message matches none of the intervening patterns. It does match one — `network`, via `ECONN`
   inside "Reconnecting". Applying that recommendation as given made the two new tests fail
   immediately, which is how it was caught. Final placement is between `rate-limit` and
   `timeout`, and both bounds are now test-pinned.
2. **The decision-point inventory read as exhaustive but was not.** `src/commands/init.ts` and
   `src/core/PostUpdateMigrator.ts` still hardcode the June-retired `gpt-5.2` into the codex
   hook-arming launch line. Correct. Not fixed here (different path, anti-bundling) but now
   disclosed as under-block item 4 and tracked.

**Round 2 (re-review of the resolution) — CONCUR.** The reviewer extracted the eight classifier
branches programmatically and re-ran the classifier with the retirement branch inserted at every
index 0-7: indices 0-3 fail the upper bound (real auth/quota/rate-limit failures reclassify),
indices 6-7 fail the lower bound (the verbatim outage message classifies `network` via `ECONN`).
Only 4 and 5 pass; the shipped position is 4. They confirmed the artifact's account is accurate
including its characterisation of their own incorrect recommendation, and stated they should have
tested the proposed placement rather than reasoning about it.

Four non-blocking corrections came out of round 2, all applied rather than deferred:
- §1 now discloses the *other* over-fire direction the lower bound costs (a genuine
  timeout/network/malformed failure whose message also carries the retirement wording).
- §2's heading said "Two failure modes" above a list of five, and the Conclusion said "Two
  related defects" while four are tracked. Both counts corrected.
- A sixth under-block item was added: the pre-existing **400** retirement branch still sits above
  `auth` — the identical ordering defect one branch up, left unfixed per anti-bundling but no
  longer left for the next reader to rediscover.
- The reviewer found the tests still permitted exactly **one** slot of movement (down to between
  `timeout` and `network`), which passed every assertion while contradicting the source comment.
  A third ordering test now pins that too, so the stated ordering is binding rather than
  aspirational.

The reviewer also independently confirmed: the retry authority is single-shot for two
independent reasons (non-recursive call plus the `model !== floor` guard); signal-vs-authority
compliance holds (detector feeding an existing authority, no new blocking surface); the
de-hardcoded self-heal test genuinely interpolates the constant rather than expanding to an
empty shell variable; and no live model-choice site on the internal-LLM or session-launch paths
was missed — every one funnels through the two resolvers this change fixes.

---

## Evidence pointers

- Live model probe, 2026-09-09, operator's ChatGPT-account Codex — results recorded verbatim in
  the header of `src/providers/adapters/openai-codex/models.ts`.
- `tests/unit/codex-model-tier-resolution.test.ts` — 13 tests: live mapping, floor liveness,
  floor reachability by the retry authority, retired-name regression guard across both
  resolvers, and cross-check that every tier resolves inside `KNOWN_CODEX_MODEL_IDS`.
- `tests/unit/providers/adapters/openai-codex/observability/eventNormalizer.test.ts` — the 404
  shape classifies as `unsupported`, quoting-style variants, and a negative test that a generic
  404 does **not**.
- `tests/unit/codex-cli-provider-execjson.test.ts` — the end-to-end self-heal through the real
  exec-json spawn path, now asserted against `CODEX_CHATGPT_FALLBACK_MODEL`.
