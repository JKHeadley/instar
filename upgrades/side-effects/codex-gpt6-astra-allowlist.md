# Side-Effects Review — codex `gpt-6-astra` allowlist + codex spawn-arm de-duplication

**Version / slug:** `codex-gpt6-astra-allowlist`
**Date:** 2026-09-05
**Author:** Echo (instar-dev agent)
**Second-pass reviewer:** required (touches `/sessions/spawn` allow decision — session lifecycle)

## Summary of the change

Two changes, one root cause. (1) `gpt-6-astra` is added to `KNOWN_CODEX_MODEL_IDS`
(`src/core/ModelTierEscalation.ts`) — the closed enum the topic-profile validator and the
spawn route both gate codex model ids against. It was absent, so pinning a topic to a model
that codex CLI ≥ 0.153.4 runs fine was refused `off-enum`, while sessions launched with the
model passed directly ran it happily — a capability the agent HAD but could not be
configured to use. (2) The spawn route's codex special-case arm in `src/server/routes.ts` is
deleted. That arm read `CODEX_MODELS_SUBSCRIPTION`, a hand-maintained literal copy of the
same list, "kept in lockstep" by comment only with nothing enforcing it. `KNOWN_MODEL_IDS['codex-cli']`
IS `KNOWN_CODEX_MODEL_IDS`, so the general arm every other framework already uses yields the
identical list; deleting the special case removes the drift class instead of documenting it.

Files: `src/core/ModelTierEscalation.ts`, `src/server/routes.ts`,
`tests/unit/topicProfileValidation.test.ts`, `tests/unit/route-validation-edge.test.ts`.

## Decision-point inventory

- `validateModelId` (`src/core/topicProfileValidation.ts`, reads `KNOWN_MODEL_IDS`) — **modify (data only)** — the closed enum it gates topic-profile model pins against gains one live-verified id. The check's logic and fail-closed shape are untouched.
- `POST /sessions/spawn` model allowlist (`src/server/routes.ts`) — **modify (source of the list, not the decision)** — the codex arm is removed; codex now reads the same canonical per-framework map as every other framework. Accepted set is provably identical to the post-(1) codex list.

---

## 1. Over-block

**What legitimate inputs does this change reject that it shouldn't?**

None newly. The change only ever WIDENS the accepted set, by exactly one id
(`gpt-6-astra`). Every id accepted before is still accepted: `KNOWN_MODEL_IDS['codex-cli']`
is a reference to `KNOWN_CODEX_MODEL_IDS`, and `GENERIC_TIERS` is still spread in both arms.
The residual over-block is pre-existing and deliberate: sibling `gpt-6-*` names that were
never live-verified are still refused `off-enum`. That is the intended fail-closed posture
(a typo must not strand a topic on a model the CLI will reject at launch), and it is now
asserted by a test rather than left implicit.

---

## 2. Under-block

**What failure modes does this still miss?**

- The enum cannot tell whether the LOCAL codex CLI is new enough. `gpt-6-astra` needs codex
  CLI ≥ 0.153.4; 0.149.0 returns `400 … requires a newer version of Codex`. A pin set on a
  machine with a current CLI, then resolved on a machine with an older one, still fails at
  launch. That is unchanged by this PR and is the same shape the 5.6 family already carries
  (its comment records the ≥ 0.144.0 floor). Naming it rather than fixing it here: a CLI
  version probe at pin time is a real feature with its own failure modes, not a line in an
  enum. <!-- tracked: ACT-420 -->
- The enum is a static list, so a genuinely new codex model is refused until a human adds it.
  That is the deliberate closed-enum design (`§5.2(c)`), not a miss.

---

## 3. Level-of-abstraction fit

Correct layer, and the change moves it further in the right direction. The list is data
consumed by two existing validators; this PR adds an entry and deletes a duplicate reader.
It does not add a new check, a new layer, or a parallel path. The deletion specifically
removes a lower-quality copy in favour of the canonical primitive that already existed —
the "does a lower-level primitive already exist that this should USE instead of
re-implementing?" question, answered by deletion.

---

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [x] No — this change has no block/allow surface of its own.

The blocking authority (a closed-enum validator) already existed and is unchanged in shape,
strictness, and failure mode. This PR edits the DATA the authority reads and removes a
duplicate copy of that data. No brittle logic gains authority; no authority is weakened —
unknown ids still fail closed.

---

## 4b. Judgment-point check (Judgment Within Floors standard)

No new static heuristic at a competing-signals decision point. The domain is enumerable by
construction: it is a closed set of model identifiers accepted by a CLI, which is exactly
the "it's an invariant, name it" case. There are no competing live signals to arbitrate —
an id is in the vendor's supported set or it is not.

---

## 5. Interactions

- **Shadowing:** none introduced. The codex arm and the general arm were mutually exclusive
  branches of one ternary; collapsing them removes a branch rather than reordering checks.
  `GENERIC_TIERS` still precedes the per-framework ids in the spread, unchanged.
- **Double-fire:** not applicable — validation is a pure function of the request body.
- **Races:** none. Both constants are module-level frozen-by-convention arrays read
  synchronously; no shared mutable state.
- **Feedback loops:** none. The enum is not written by anything at runtime.
- **Adjacent consumers — full inventory** (the first draft named only the first two; the
  second-pass reviewer found three more by grepping the tree, so this list is now the result
  of a sweep rather than recall):
  - `escalatedModelIds` / `resolveTierModel` (`ModelTierEscalation.ts`) — fail closed on an
    out-of-enum config value. A `models.tierEscalation.frameworks['codex-cli']` naming
    `gpt-6-astra` now resolves instead of nulling; the shipped codex default is
    `{ default: null, escalated: null }`, so nothing changes without a deliberate operator
    config edit, which is the intended effect.
  - `ModelSwapService.ts:254` — clamps a topic's pinned baseline against
    `KNOWN_MODEL_IDS[framework]` before a **live-session** model swap. This is the most
    material consumer of the three and the first draft missed it: widening the list means a
    topic pinned to `gpt-6-astra` can now be swapped onto rather than clamped away. That is
    the intended effect (it is the same authority the pin itself passed), and the swap path
    keeps its own independent verification — but it deserved naming, not discovery.
  - `ProfileIntentClassifier.ts:157` (`defaultKnownModelValues`) — the union is the
    extraction vocabulary for conversational pins, so "use gpt-6-astra here" now resolves to
    a model value instead of falling through unrecognised. Intended, and the reason the
    conversational surface works at all.
  - `CodexCliIntelligenceProvider.ts:496` — reads the list benignly; no behavior change.

---

## 6. External surfaces

- **Other agents on the same machine:** none — no shared state touched.
- **Install base:** the only user-visible change is that a topic-profile pin naming
  `gpt-6-astra` now succeeds where it returned `off-enum`. No previously-working
  configuration changes behavior.
- **External systems:** none. instar does not call the model vendor here; it validates a
  string that is later handed to the codex CLI.
- **Persistent state:** none written or migrated. A topic profile that could not previously
  store this model id simply had nothing stored.
- **Timing / runtime conditions:** none introduced. The pre-existing dependence on the local
  codex CLI version is recorded under §2.
- **Operator surface (Mobile-Complete Operator Actions):** no new operator-facing action.
  The existing surface — the operator saying "use gpt-6-astra here" in the topic, which the
  topic-profile write path already accepts from a verified operator — is phone-complete and
  unchanged. This PR is what makes that sentence succeed rather than be refused.

---

## 6b. Operator-surface quality

No operator surface — not applicable. No dashboard renderer, approval page, or
grant/revoke/secret-drop form is touched.

---

## 7. Multi-machine posture (Cross-Machine Coherence)

**Posture: machine-local BY DESIGN — with a replicated consumer, and that split is the
interesting part.**

The enum itself is compiled-in constant data, so it is machine-local in the same trivial
sense all code is: each machine runs whatever instar version it has installed. The reason
this is BY DESIGN rather than an oversight is that the thing it gates — a topic profile
pin — IS replicated (`multiMachine.stateSync.topicPins`). So the honest posture is: the
DATA is per-version, the STATE it validates is pool-wide.

That produces one real cross-machine behavior worth stating: a pin set on a machine running
this version replicates to a peer still on ≤ 1.3.1222, whose validator does not know the id.
This is not a new failure mode — it is exactly the documented "a pinned model that is no
longer available falls back to defaults with a once-per-transition notice" path, which is
already the shipped contract for a version-skewed pool and degrades to a working session
with a notice rather than a block. A rolling fleet update converges it, and the
machine-coherence guard already surfaces version skew.

- **User-facing notices:** emits none. The fallback notice above is pre-existing and already
  one-voice gated.
- **Durable state on topic transfer:** holds none of its own. The topic pin it validates is
  already replicated and already survives transfer.
- **Generated URLs:** none.

---

## 8. Rollback cost

- **Hot-fix release:** revert the commit, ship as the next patch. Pure code change.
- **Data migration:** none — but one honest caveat. If an operator pins a topic to
  `gpt-6-astra` and the change is then reverted, that stored pin becomes an unknown id on
  the next resolve. It does NOT wedge the topic: the shipped behavior is fallback-to-default
  with a once-per-transition notice. Cost is one notice per affected topic, no repair.
- **Agent state repair:** none required.
- **User visibility during rollback:** a topic pinned to the new id falls back to the
  framework default and says so. No silent behavior change.

---

## Conclusion

The review changed the shape of the fix twice, both times toward less code. The first draft
edited two lists in lockstep — which reproduced, in the same commit, the exact
comment-enforced coupling that caused the bug. The second draft made the route read the
canonical constant. The final version deletes the codex arm entirely, because
`KNOWN_MODEL_IDS['codex-cli']` already IS that constant and the general arm was provably
equivalent. Net effect: one id added, one duplicate reader removed, one drift class closed.

Two findings were surfaced rather than silently absorbed. The CLI-version floor (§2) is a
genuine residual gap and is tracked, not hand-waved. The version-skewed-pool pin (§7) is a
real cross-machine interaction, and it lands on an existing, correct degradation path.

The second-pass review then rejected the first version of the drift guard, correctly. That
guard iterated `KNOWN_MODEL_IDS['codex-cli']` and asserted `validateModelId` — but the
validator reads that same map, so the loop was tautological, and nothing in it read the
spawn route at all. The reviewer's negative control proved it: re-splitting the route to a
literal carrying 3 of 9 codex ids left the entire suite green. I had "falsified" that guard
by breaking the map alias, which it did catch — and mistook that for proof it watched the
route, which it never did. That is the precise failure mode of a guard that is blind to its
own subject, reproduced inside the very commit whose purpose is to close a drift class.

The fix is structural rather than another assertion: `spawnModelAllowlist(framework)` is
exported from `routes.ts`, the handler calls it, and the guard reads THAT — the route's own
accepted set — in both directions (the route accepts nothing the validator refuses, and
drops nothing the validator accepts). The reviewer's exact control now fails on
`gpt-5.2 missing from the spawn route`.

The review also caught that the commit re-planted the instruction it was deleting: three
comments still told a maintainer to "keep in lockstep with CODEX_MODELS_SUBSCRIPTION",
including one I newly added, pointing at a constant this change removes. All three are
rewritten. Clear to ship.

---

## Second-pass review (required — touches the `/sessions/spawn` allow decision)

**Reviewer:** independent reviewer subagent, 2026-09-05
**Independent read of the artifact: CONCERN — resolved, re-review recommended**

The reviewer verified sections A, B, E, §7 and §8 against the code (including confirming
that `CODEX_MODELS_SUBSCRIPTION` and `KNOWN_CODEX_MODEL_IDS` were entry-identical and
same-order on `origin/main`, so the deletion is a provable no-op on the accepted set, and
that `?? KNOWN_CLAUDE_MODEL_IDS` is unreachable for codex because `KNOWN_MODEL_IDS` is an
exhaustive `Record` over the framework union). Five findings were raised; all five are
resolved in this commit:

1. **(blocking) The drift guard was blind to its own subject.** Proven by negative control:
   re-splitting the route to a literal dropping 6 of 9 codex ids left both test files green,
   58/58. Resolved — `spawnModelAllowlist` is exported and the guard reads the route's own
   list bidirectionally; the same control now fails on
   `codex-cli pinnable id gpt-5.2 missing from the spawn route`.
2. **The commit re-planted the instruction it deletes.** Three "keep in lockstep with
   CODEX_MODELS_SUBSCRIPTION" comments survived, one newly added by this change, pointing at
   the constant it removes. Resolved — all three rewritten; zero references remain in `src/`.
3. **Consumer inventory incomplete.** `ModelSwapService.ts:254`, `ProfileIntentClassifier.ts:157`
   and `CodexCliIntelligenceProvider.ts:496` were unlisted. Resolved — §5 now carries the
   swept inventory, with the live-session swap path called out as the material one.
4. **Falsification evidence not reproducible.** The quoted output did not correspond to the
   committed code. Resolved — both controls re-run against the shipped code and quoted
   verbatim under Evidence.
5. **Spawn-side coverage reduced under a wrong justification.** Resolved — `gpt-5.6-terra`
   restored to the HTTP sample, and the comment now points at the route-observing guard
   rather than claiming the validator test covers the route.

The reviewer's `Concern raised` verdict stands against the version it read. Every finding it
raised is addressed above; the load-bearing one changed the design.

**Re-review verdict: "Concur with the review"** (same reviewer, against the fixed tree). It
re-ran both injection controls itself and reproduced the quoted evidence verbatim (2/56 and
1/57), instrumented the guard's per-framework loop to confirm neither direction runs vacuous
(codex 9/9, claude 10/10, gemini 3/3 ids after the generic-tier filter), confirmed the
handler has exactly one list-computation site and that the test import creates no runtime
cycle (the CapabilityIndex back-reference is type-only). Two non-blocking nits were raised
and are fixed in this commit: a dangling `CODEX_MODELS_SUBSCRIPTION` reference in the
model-registry freshness manifest's descriptive note, and `grok-build` added to the guard
loop (the reviewer verified it passes; it was ROUND-21's original victim framework, so its
absence from the guard was the omission most worth closing). `pi-cli` stays omitted — its
enum is closed-empty by design, so both loop directions would be vacuous.

---

## Evidence pointers

- Live verification of the model id, Mac Mini, 2026-09-05: codex CLI 0.149.0 →
  `400 invalid_request_error: The 'gpt-6-astra' model requires a newer version of Codex.`
  After upgrading to 0.153.4, the same one-shot prompt returns a normal completion.
- Refusal that prompted the change: `POST /topic-profile/69507` →
  `{"failure":"off-enum","reason":"'gpt-6-astra' is not a known codex-cli model id"}`, on an
  agent whose own Studio machine was concurrently running seven sessions on that model.
- Falsification runs, re-captured against the COMMITTED code after the second-pass review
  (the first draft quoted `expected [ …(6) ] to be [ …(7) ]`, which corresponded to an
  intermediate version of the guard, not to what shipped — the reviewer was right that it
  was unreproducible):
  - **Control A — remove the id from the enum:** 2 failed | 56 passed.
    `accepts codex-cli GPT-5.6 + GPT-6 family model values` → `expected 400 not to be 400`;
    `accepts the GPT-6 family against codex-cli` → `expected { field: 'model', …(4) } to be null`.
  - **Control B — re-split the route to a literal dropping 6 of 9 codex ids** (the reviewer's
    own control, which the FIRST guard passed green): 1 failed | 57 passed.
    `the spawn ROUTE accepts every id the pin validator does, for every framework` →
    `codex-cli pinnable id gpt-5.2 missing from the spawn route: expected [ Array(3) ] to include 'gpt-5.2'`.

---

## Class-Closure Declaration (display-only mirror)

No agent-authored-artifact defect — not applicable. This is a defect in hand-maintained
source data (a duplicated constant), not in an LLM prompt, hook, config, skill, or standards
text; and it adds no self-triggered controller.
