# Side-Effects Review — Claude 5 family model ids in the claude-code closed enum

**Version / slug:** `claude-5-family-model-ids`
**Date:** `2026-09-06`
**Author:** `Echo`
**Second-pass reviewer:** `required (touches a gate)`

## Summary of the change

`KNOWN_CLAUDE_MODEL_IDS` (`src/core/ModelTierEscalation.ts`) is the single closed
allowlist that both the topic-profile pin validator (`validateModelId` →
`validateProfileFields`) and the spawn route (`spawnModelAllowlist` in
`src/server/routes.ts`) read to decide which claude-code model ids are
acceptable. It had lagged a model generation: it topped out at `claude-fable-5`
/ `claude-opus-4-8` and carried the `opus`/`sonnet`/`haiku` CLI aliases but not
`fable`. This change adds `claude-fable-5-1`, `claude-opus-5`, `claude-sonnet-5`
and the `fable` alias. All four were live-verified against the installed CLI
(`claude --model <id> -p`, claude-code 2.1.263, 2026-09-06) before being listed.

The driving defect is operator-visible: a pin of topic 36966 to Fable 5.1 was
refused `off-enum`, and the already-shipped
`frameworkDefaultModels['claude-code'] = 'claude-opus-5'` was being silently
dropped at the resolution clamp — a stale allowlist is indistinguishable from a
deliberate policy refusal.

Files touched: `src/core/ModelTierEscalation.ts`, `src/core/ModelSwapService.ts`,
`scripts/model-registry-freshness.manifest.json`,
`tests/unit/topicProfileValidation.test.ts`,
`tests/unit/modelTierEscalation-resolver.test.ts`,
`tests/unit/modelSwapService.test.ts`, plus
`docs/specs/claude-5-family-model-ids.eli16.md` and this artifact.

`ModelSwapService.ts` is here because the second-pass review found the enum change
makes a dormant runtime bug reachable — see §5 and §1 below. It was not in the
original plan.

## Decision-point inventory

The enum has FOUR consumers, not two. The first draft of this review said "two
readers, both read-only"; the second-pass review corrected it, and the correction
is what surfaced the defect in §1.

- `validateModelId` (`src/core/topicProfileValidation.ts:318`, reading
  `KNOWN_MODEL_IDS['claude-code']`) — **pass-through** — the clamp keeps its
  authority and its fail-closed policy unchanged; only the reference data it
  consults is corrected.
- `validateProfileFields` (topic-profile write clamp) — **pass-through** — same;
  it delegates the model arm to `validateModelId`.
- `spawnModelAllowlist` (`src/server/routes.ts:104`) — **pass-through** — derives
  from the same enum, so it gains the same four ids with no separate edit.
- `ModelSwapService` defence-in-depth re-check (`src/core/ModelSwapService.ts:254`)
  — **pass-through on the read, but this reader feeds a WRITE**: the accepted
  value becomes `targetId` and is typed into a live tmux pane at `:350`. This is
  the consumer the first draft missed, and it is where the §1 defect lives.
- `paneConfirmsModel` (`src/core/ModelSwapService.ts:165`) — **MODIFIED** — the
  independent oracle that decides whether a swap actually landed. Fixed here; see
  §1.
- `ProfileIntentClassifier.defaultKnownModelValues()`
  (`src/core/ProfileIntentClassifier.ts:154`) — **pass-through** — supplies the
  conversational pre-filter vocabulary. Fail-open toward inclusion, so widening it
  is safe directionally.
- `resolveTierModel` / `resolveModelId` (model-tier escalation resolver) —
  **pass-through** — the escalation *policy values* (`escalated:
  'claude-fable-5'`) are deliberately unchanged; this widens what MAY be named,
  not what IS named by default.

---

## 1. Over-block

**What legitimate inputs does this change reject that it shouldn't?**

None — the change is purely additive to an allowlist, so no input that was
previously accepted is now rejected. The set of accepted ids grows by exactly
four; every previously-valid id remains valid (asserted by the retained
`claude-fable-5` / `claude-opus-4-8` containment test).

The over-block this *removes* is the reported one: `claude-fable-5-1`,
`claude-opus-5` and `claude-sonnet-5` are live subscription models that the pin
validator refused, and `fable` is a CLI alias that was refused while its three
siblings were accepted.

**One over-block is INTRODUCED and it is deliberate.** The `paneConfirmsModel` fix
in §5 adds `(?![.\-]\d)` to the swap-acknowledgment regex. A pane line reading
"Set model to Fable 5" followed immediately by a version digit no longer confirms a
swap to the shorter id. That is the intended narrowing — the alternative is the
false CONFIRMATION described in §5, which is the unsafe direction for a function
whose entire job is to be an independent oracle. The guard fires only on a
separator followed by a digit, so a sentence-final "Set model to Fable 5." still
confirms; a test pins that so the narrowing cannot quietly widen into a
false-negative for ordinary punctuation.

---

## 2. Under-block

**What failure modes does this still miss?**

- **The next generation.** This is a hand-maintained mirror of a moving vendor
  surface. It is correct as of 2026-09-06 and will go stale again the next time
  Anthropic ships a model id; nothing in this change detects that. The class is
  registered as an evolution action rather than left implicit
  <!-- tracked: ACT-514 -->.
- **Plan-gated variants.** Any id the CLI accepts syntactically but the account's
  plan refuses at launch is still accepted here. The enum answers "is this a real
  model id", not "can this account run it" — unchanged by this edit, and the
  live-verification discipline (only ids observed answering) is what bounds it.
- **Alias drift.** `fable`/`opus`/`sonnet`/`haiku` resolve CLI-side to whatever
  the vendor currently calls latest. A pin to an alias is therefore not a pin to
  a fixed model. That was already true of the three existing aliases; adding
  `fable` makes the surface symmetric rather than introducing the property.

---

## 3. Level-of-abstraction fit

Right layer, and deliberately the *only* layer. `KNOWN_CLAUDE_MODEL_IDS` is the
single source both the pin validator and the spawn route read — the file's own
comment records a prior incident where the route carried a hand-typed duplicate
of the codex enum and drifted from it undetected. This change edits the one
enum and adds nothing parallel to it, so the spawn route and the pin validator
cannot disagree. The existing
`the spawn ROUTE accepts every id the pin validator does` test covers that
invariant for the new ids for free.

There IS a second hand-maintained Claude model list, and §3's original "edits the
one enum and adds nothing parallel to it" was too strong. The doorway/model
registry (`scripts/model-registry-freshness.manifest.json`) carries its own
per-door `topModels[]`, gated by a strict lint in the `npm run lint` chain. The two
are deliberately NOT in lockstep, because they answer different questions: the enum
answers "is this a real model name we may accept" (acceptance), the registry
answers "which model should routing reach for" (frontier). Adding a name to the
first must not promote it in the second — a model earns the routing lane via
benchmarks, not release date. This change therefore updates only the registry's
claude-code door NOTE, recording that the Claude 5 family is now recognized and
that `claude-fable-5-1` is deliberately not promoted. The strict lint passes.

That distinction is also where the drift came from: the 2026-08-18 registry review
had already classified `claude-opus-5` and `claude-sonnet-5` as frontier while the
acceptance enum still refused them, so the two layers contradicted each other for
three weeks and the shipped `frameworkDefaultModels` default was collateral.

No new primitive was introduced, and no lower-level helper was re-implemented.

---

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [x] No — this change has no block/allow surface *of its own*.

The block/allow authority (`validateModelId`) already exists, already owns the
decision, and is unchanged. This change corrects the curated data that authority
consults. No brittle detector is being handed blocking power; if anything the
change reduces a brittle failure, because the authority was refusing live models
purely because its reference list had aged.

The fail-closed direction is preserved and explicitly tested: an unverified
sibling (`claude-fable-6`, `claude-opus-6`) still refuses `off-enum`, which is
the property that keeps a typo from stranding a topic on a model the CLI will
reject at launch.

---

## 4b. Judgment-point check (Judgment Within Floors standard)

No new static heuristic at a competing-signals decision point. The domain here
is enumerable by construction — "which model ids does this CLI accept" is a
finite, externally-determined list, verified by observation rather than
inferred. That is the invariant case, not a judgment point.

---

## 5. Interactions

- **Shadowing:** none. The model arm of `validateProfileFields` runs before
  `thinkingMode`/`effort`/`escalationOverride`; widening what it accepts means
  those later clamps now run on inputs that previously short-circuited at the
  model arm. That is the intended ordering and each remains independently
  enforced (their own tests are unchanged and green).
- **Double-fire:** none. One enum, two readers, both read-only.
- **Races:** none. Compile-time `as const` data; no shared mutable state.
- **Feedback loops:** none. The enum is not written by anything at runtime.
- **Billing lane:** `PER_TOKEN_LANE_MODEL_IDS['claude-code']` is `[]` on the
  documented premise that *every* member of the claude enum launches via the
  subscription-authed CLI. That premise had to be re-checked, not assumed, since
  this change adds members: all three new full ids launch through the same
  subscription CLI path, so the empty deny-set stays correct. A test now asserts
  `billingLaneError` returns null for each, so if one of them ever moves to a
  per-token lane the assertion is the place that has to be updated deliberately.
- **Escalation policy:** `ModelTierEscalation`'s default
  `{ default: 'claude-opus-4-8', escalated: 'claude-fable-5' }` and
  `respectFreeWindows` are untouched. Adding an id to the enum does not select
  it; no session changes model as a result of this change alone.
- **Substring hazard — the finding this review nearly missed.** The first draft
  checked only the three test assertions that do
  `expect(...).not.toContain('claude-fable-5')` against the anthropic-headless,
  openai-codex and gemini adapter tier maps. Those are fine: the adapter maps are
  separate modules, were not touched, and all three pass. But the hazard that
  matters is in RUNTIME code, and the second-pass review found it.

  `paneConfirmsModel` (`src/core/ModelSwapService.ts:165`) derives a display name
  from a model id and matches `set model to[^\n]*\b(?:<id>|<Display>)\b`. A
  shorter version is a literal prefix of a longer one, and `\b` sits between the
  digit and the separator — so `\bFable 5\b` matches INSIDE "Fable 5.1".
  Reproduced directly: `paneConfirmsModel("… Set model to Fable 5.1 …",
  'claude-fable-5')` returned **true**.

  It is reachable precisely because of this change. A topic pinned to
  `claude-fable-5-1` acks "Fable 5.1"; a later `tier:'escalated'` swap targets the
  config's `escalated: 'claude-fable-5'`, injects at `:350`, and the read-back at
  `:365` captures a 30-line tail still holding the stale 5.1 ack. The echo filter
  drops only lines containing `/model`, and the ack line does not — so the swap
  audits as `swap-confirmed` and `session.model` records `claude-fable-5` while the
  session runs 5.1. That is a false CONFIRMATION, which directly contradicts the
  "conservative by design / unrecognized format reads as NOT confirmed" contract in
  that function's own docstring, and it mis-attributes model and cost in
  `GET /sessions`.

  Fixed in this change rather than deferred, because this change is what makes the
  collision reachable. Four regression tests pin both directions (5 must not
  confirm from 5.1, and 5.1 must not confirm from 5), the punctuation
  false-negative boundary, and the Claude 5 display forms.

---

## 6. External surfaces

- **Other agents on the machine:** none until they update; the enum ships in the
  build.
- **Install base:** widens what `POST /sessions/spawn` and
  `POST /topic-profile/:topicId` accept. No previously-working call changes
  behavior.
- **External systems:** none. No network surface.
- **Persistent state:** none written by this change. Existing stored pins are
  unaffected; a pin that was being refused at resolution now resolves instead of
  falling back — which is the fix, and is visible to the operator through
  `GET /topic-profile/:topicId` (`resolved.model` / `sources.model`).
- **Timing / runtime conditions:** none.
- **Operator surface (Mobile-Complete):** no new operator action. The affected
  operator paths (the conversational "pin this topic to X" surface and the
  `/topic-profile` route) already exist and already have their surfaces; this
  change only makes them stop refusing a valid answer.

---

## 6b. Operator-surface quality

No operator surface — not applicable. No dashboard renderer, approval page, or
grant/revoke/secret-drop form is staged in this change.

---

## 7. Multi-machine posture (Cross-Machine Coherence)

**Posture: machine-local BY DESIGN — shipped code, not state.**

The enum is compiled into the instar build, so each machine gets it when that
machine updates. There is nothing to replicate: it is not agent state, it is the
program. The reason it *should* differ per machine transiently is the same
reason any code change does — machines update on their own cadence, and the
existing machine-coherence guard already treats an instar version skew across
the pool as its own observable (`GET /pool/machine-coherence`), so a mid-rollout
divergence is already surfaced by infrastructure built for exactly that.

Explicit answers:

- **User-facing notices:** emits none. No one-voice gating needed.
- **Durable state / topic transfer:** holds none. A topic pin carrying
  `claude-fable-5-1` does ride the existing `TopicProfileTransferCarrier`; the
  carrier re-validates on landing, so a topic pinned on an updated machine and
  transferred to a not-yet-updated one has its model refused off-enum there and
  falls back with a notice — the pre-existing, correct degrade path, not a
  stranding. It self-heals when the second machine updates.
- **Generated URLs:** generates none.

---

## 8. Rollback cost

- **Hot-fix release:** revert the four added lines, ship as the next patch.
- **Data migration:** none. No schema, no ledger, no column.
- **Agent state repair:** none required. A pin written to one of the new ids
  while the change was live would, after a revert, be refused at the resolution
  clamp and fall back to the framework default with the existing once-per-
  transition notice — degraded, visible, and repaired by re-pinning. No state
  corruption, no manual cleanup.
- **User visibility:** during a rollback window a topic pinned to a Claude 5 id
  would drop to the default model. That is the pre-change behavior, so the
  regression is a return to the status quo rather than a new failure.

---

## Conclusion

This review produced two concrete checks that were not in the original plan and
are now tests: the billing-lane premise (`PER_TOKEN_LANE_MODEL_IDS['claude-code']
= []` is documented as true of *every* enum member, so adding members obligated
re-verifying it) and the substring hazard against the three
`not.toContain('claude-fable-5')` adapter assertions, which `claude-fable-5-1`
would trip if the id ever reached those maps.

It also surfaced the honest limit of the fix: this is a hand-maintained mirror of
a vendor surface with no freshness guard, so it will age again. That is
registered as ACT-514 rather than left as an implicit intention, and the fail-
closed refusal path is retained and tested so aging degrades safely.

The change is additive to an allowlist, changes no policy value, and holds no new
authority — but it is no longer only that. The second-pass review found that
widening the enum makes a dormant `paneConfirmsModel` prefix collision reachable,
which would have silently mis-recorded a session's model and cost. That is fixed
here rather than tracked for later, because this change is what arms it. The
review's real lesson is that the first draft's "one enum, two readers, both
read-only" was the wrong mental model: one of the readers feeds a tmux write, and
that is exactly where the damage would have been.

Clear to ship.

---

## Second-pass review (if required)

**Reviewer:** general-purpose reviewer subagent (independent read + code verification)
**Independent read of the artifact: concern raised, resolved**

The reviewer confirmed the claims on enum order/length (nothing indexes, sorts or
slices it), the `fable` alias namespace (no collision with `GENERIC_TIERS`; the
`FABLE` in `PairingProtocol.ts:37` is a disjoint SAS wordlist), the billing-lane
deny-set semantics, and the multi-machine degrade path
(`TopicProfileTransferCarrier.ts:639-643` drops the unvalidatable field and pushes
a disclosure — it does not strand or throw). It then raised four concerns:

- **`paneConfirmsModel` false-confirms across a version prefix.** Verified
  independently by reproducing it, then fixed in this change with four regression
  tests. See §1 and §5. This was the material one and it was a real defect.
- **The decision-point inventory undercounted the enum's readers** (two claimed,
  four actual, one of which feeds a write path). Corrected above; that correction
  is what made the first concern legible.
- **The artifact was stale against the diff** — the registry manifest and the
  ELI16 landed during the review. Files-touched list and §3 corrected.
- **The anti-escalation ratchet had an exact-match hole**
  (`not.toBe('claude-fable-5')` would wave through `claude-fable-5-1`). Widened to
  assert against the ultra family (`not.toMatch(/^claude-fable-/)`) and the `fable`
  alias added to the tier list, since it is now a way in.

The reviewer also noted, and this review agrees, that the bare token `fable` joining
the conversational pre-filter vocabulary (`ProfileIntentClassifier.ts:154`) means a
common English noun can now pass the pre-filter on unrelated prose and spend a
classify call. It is precedented exactly by `opus` and `sonnet`, is fail-open toward
inclusion, and costs a call rather than a wrong decision — recorded here rather than
changed.

---

## Evidence pointers

- Live model-id verification: `claude --model <id> -p "reply with exactly: ok"`
  on claude-code CLI 2.1.263 returned `ok` for `claude-fable-5-1`,
  `claude-opus-5`, `claude-sonnet-5` and `claude-fable-5` (2026-09-06).
- Fail-for-the-right-reason: with `src/core/ModelTierEscalation.ts` stashed, the
  new assertions failed 5/70 with `off-enum` / `expected false to be true`;
  restored, 70/70 pass.
- Production refusal reproduced by the new
  `accepts a Fable 5.1 pin arriving on a topic currently resolved to codex-cli`
  test (topic 36966, `POST /topic-profile/36966` →
  `{"failure":"off-enum","reason":"'claude-fable-5-1' is not a known claude-code model id"}`).
- `npx tsc --noEmit` clean.

---

## Class-Closure Declaration (display-only mirror)

Not applicable to the agent-authored-artifact arm: the change fixes stale data in
a TypeScript source constant, not a defect in an agent-authored LLM prompt, hook,
config, skill, or standards text. It also adds and modifies no self-triggered
controller — no loop, monitor, sentinel, reaper, scheduler, or recovery path, and
nothing that fires a restart / swap / respawn / spawn / notify / retry / re-drive
/ kill, so the `unbounded-self-action` arm does not apply either.

The staleness pattern itself is a genuine candidate class
(`vendor-mirror-staleness`; nearest existing: `generated-artifact-path-contract-drift`),
but registering a `novel` class requires a full registry entry with confirmed
status, which is its own change. It is tracked as ACT-514 <!-- tracked: ACT-514 -->.
