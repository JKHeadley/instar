# Side-Effects Review — Sibling-machine reach: the outbound check knows what my other machines hold

**Version / slug:** `sibling-machine-reach`
**Date:** `2026-11-21`
**Author:** `echo`
**Second-pass reviewer:** `echo (independent reviewer subagent, see below)`
**Spec:** `docs/specs/sibling-machine-reach.md` (converged round 6, codex-cli:gpt-6.2-astra; approved)
**Commitment:** CMT-2073 / fb-56855d0f-0d2

## Summary of the change

On 2026-11-20 the agent told its operator to open the dashboard, enter his PIN and do four
sign-ins on the rebuilt Mac Studio, while the Mac Mini held browser profiles signed in to all
four accounts. The outbound check's reach described only the sending machine.

The change: a memory-only `SiblingHoldingsCache` (`src/core/sibling-holdings.ts`) refreshes, on a
10-minute timer off the send path, what each other machine holds (its plain `/subscription-pool`
and a new light `/playwright-profiles?view=accounts`). The reach (`src/core/agent-reach.ts`)
carries it; the gate (`src/core/MessagingToneGate.ts`) renders it in a separate `OTHER
MACHINES` section with a B21 per-machine sub-clause and B17 precedence, only when siblings exist
(the complete prompt is otherwise byte-identical). The route (`src/server/routes.ts`) re-reviews
any B17/B21 from such a prompt without the section (a B17 stands only if confirmed locally; a
local B17 wins over a sibling B21), validates the gate's opaque `siblingProfileRef`, and
attaches a server-templated route hint (`otherMachine`, `otherMachinesHint`, appended to
`suggestion`/`howToProceed`) with every rendered identity redacted from model text. Switch
`toneGate.siblingReach.enabled`: live on development agents, dark on the fleet; read live.

## Decision-point inventory

- Nudge a per-machine ask another machine can do — the existing LLM gate under B21 (advisory),
  given sibling data; judgment-candidate with floors (pass/advisory only, exact-identity browser
  evidence, UNKNOWN = pass, under-fire bias, override with reason, kill switch).
- B17 ignores sibling holdings — invariant enforced in code by the local-only confirmation
  re-review.
- Attach the hint — invariant: only rule B21 + a ref that is a key of the reach that built the
  prompt.
- Discard a read whose responder `machineId` differs — invariant (closed registry id set).

## 1. Over-block

Sibling data can only produce an advisory B21 (overridable with a reason). A stale-positive
case (a profile signed out on the Mini within the hour) yields an avoidable nudge, never a wall.
A B17 that appears only with the sibling section is re-reviewed without it; if that re-review
gives no verdict the send takes the existing no-verdict path (hold/degrade as configured),
which is a DELAY, not a confirmed block — accepted and counted (`b17-unconfirmed`). A per-machine
PIN approval, a physical step, a new account nobody holds, and a same-provider different
identity are explicit PASS cases in the sub-clause.

## 2. Under-block

A sign-in done on a peer after the last read (≤10 minutes stale) is not yet visible → today's
behavior (pass). A sibling-aware PASS where a local-only prompt would have given B17 is not
re-checked (cost); its rate is unmeasured (stated in the spec). The "tried it on the other
machine" PASS case takes the draft at its word (inherited from HELD-ACCESS). Fleet agents with no
registered browser profiles carry no browser evidence, so the sub-clause cannot fire there.

## 3. Level-of-abstraction fit

The facts live where they already are (each machine's pool and profile registry); the judgment
stays in the one outbound authority that already reads the local reach. No new gate. The
peer-facing light view is a query on the existing route (no new route prefix). The hint rides
the existing 422 fields the reply scripts already print.

## 4. Signal vs authority compliance

Cache, reach, refs and hint are DATA/signals. The only authority remains the LLM gate. Nothing
string-matches the agent's text or override reason. Identity redaction is replacement of KNOWN
rendered values, not a judgment. `docs/signal-vs-authority.md` respected.

## 4b. Judgment-point check (Judgment Within Floors standard)

The nudge is a judgment with a complete floor (bounded actions, conservative default = pass,
ladder ending at the deterministic kill switch). The two invariants (B17 local-only, hint
attachment) have enumerable bases recorded in the spec.

## 5. Interactions

- The existing B17 REACH / HELD-ACCESS / APPROVAL-NOT-ERRAND sections are untouched; the new
  section renders after them. The local reach lines are unchanged (tested byte-equal).
- Advisory migration / decision-quality recording: the hint attaches to the normal advisory
  path; the override reaction records as before plus a `toneGate.siblingReach` evidence row.
- `reviewWithinBudget`: the re-review uses `min(configured budget, route timeout − elapsed −
  5 s)`; skipped (no verdict path) under 5 s.
- `poolPeerFetch` / `peerUrlGuard`: dial targets come only from `resolvePeerUrls` (admitted
  ropes); a machine known only to the registry is UNKNOWN and never dialed.
- Pool views: `subscriptionPoolScopeView` is unchanged except the added `siblingReach` field.

## 6. External surfaces

- Peer-facing: `/subscription-pool` now carries `machineId` on every response;
  `/playwright-profiles?view=accounts` (agent bearer only, before the dev gate; no vault, no
  write). Older peers ignore the query — and are never asked (the cache asks only peers whose
  pool body carried `machineId`).
- Agent-facing: 422 bodies gain `otherMachine`/`otherMachinesHint`; `suggestion`/`howToProceed`
  gain the hint sentence; the pool view gains `siblingReach` (identities only for the agent
  bearer). The admitted peer URL in `address` is a deliberate exception to the pool views'
  no-URL rule (the reader is the agent; the bearer is still required).
- Awareness entry `access-you-already-hold.md` extended (reaches every agent on update).
- Timing-dependent: a hint without `address` right after a network-path switch is expected.

## 6b. Operator-surface quality (Operator-Surface Quality standard)

No operator surface — not applicable (no dashboard, approval page or form touched; the pool
view's new field is agent-read JSON).

## 7. Multi-machine posture (Cross-Machine Coherence)

**unified (proxied-on-read, ephemeral).** Each machine reads its peers' own surfaces under the
agent bearer on a timer; nothing is persisted, replicated or written to a peer. The source
surfaces (pool logins, browser profiles) are machine-local because the logins physically live on
that disk (`physical-credential-locality`), which is why a proxied read is correct. Mixed
versions degrade honestly (older peer: pool read without identity check, browser UNKNOWN
`peer-too-old`). No user-facing notice is added (one-voice gating not needed); no durable state;
the only URL generated is the admitted peer address for the agent itself.

## 8. Rollback cost

Set `toneGate.siblingReach.enabled: false` (read through liveConfig at every send and tick:
immediate, no restart) or revert the PR. No state, no migration, no data repair. The two
peer-facing additions are additive.

## Stage-B certified set

`src/core/sibling-holdings.ts` enters the tone gate's import closure through `agent-reach.ts`; it is classified as an EXCLUDED member in `src/data/stageBCertifiedSet.ts` (memory-only cache, injected fetch and roster, no delivery logic), like `agent-reach.ts` itself. Certified hashes and the signed evidence are unchanged (`--check` passes).

## Conclusion

Ship. Sibling data nudges, never walls; every failure direction is named and bounded; the
feature is byte-identical on a single machine and dark on the fleet until the ladder graduates.

## Second-pass review (if required)

Required (outbound messaging block/allow + "gate"). Independent reviewer: see appended verdict.

## Evidence pointers

- `tests/unit/sibling-machine-reach.test.ts` (24), `tests/integration/sibling-machine-reach-routes.test.ts` (11), `tests/e2e/sibling-machine-reach-lifecycle.test.ts` (2) — all passing locally; the existing `held-access-false-blocker`, `reach-aware-false-blocker`, `approval-not-errand` suites unchanged and passing.
- `tests/unit/self-action-convergence.test.ts` covers the registered `sibling-holdings-refresh` controller.
- Convergence report: `docs/specs/reports/sibling-machine-reach-convergence.md`.

## Class-Closure Declaration (display-only mirror)

- `defectClass: unbounded-self-action`, `closure: guard`,
  `guardEvidence: {enforcementType: ratchet, citation: tests/unit/self-action-convergence.test.ts, howCaught: the refresh timer is modeled as the Eternal Sentinel 'sibling-holdings-refresh' in src/testing/selfActionRegistry.ts over the real nextSiblingAttemptAtMs decision; the ratchet drives a dead peer for 24h and 48h of virtual time and asserts the P19 rate floor (no two attempts closer than 60 s, count bounded by elapsed/floor) and the restart posture — an unbounded or accelerating refresh loop would fail it}`.
- This change fixes no defect in an agent-authored artifact (it adds facts to an existing
  prompt); the declaration above covers the new self-triggered controller.

**Concur with the review.** Independent second pass (echo reviewer subagent, 2026-11-21), audited against the working-tree diff, not the artifact's prose.
- (b) No path lets other-machine data alone hard-block. `src/server/routes.ts:5681-5721`: a sibling-aware B17 is replaced by the local-only re-review's verdict (`confirm`) or, with no verdict, by the existing no-verdict result (degrade / fail-closed-hold / fail-open) — never a confirmed B17; a sibling-aware B21 becomes a block only when the local-only prompt itself returns B17 (`:5717`). B21's disposition is baseline `'advisory'` in `RULE_DISPOSITIONS` (`src/core/MessagingToneGate.ts:834`, `resolveRuleDisposition:918-925`), independent of `toneGate.advisoryMigration`, so a B21 is a 422 `tone-gate-advisory` on every install.
- (c) No identity or email reaches the 422: `issue`/`suggestion` pass `redactSiblingIdentities` (`routes.ts:5732`, values from `renderedSiblingIdentities`, `src/core/agent-reach.ts:342`); the hint template and `otherMachine` carry machine id/nickname, service, address and counts only (`routes.ts:5733-5758`); the ref is parser-clamped to `/^S\d{1,3}$/` (`MessagingToneGate.ts:2108`) and must be a key of the reach that built the prompt. Residual (accepted, named in spec): redaction is of verbatim values only — a paraphrased or case-changed identity in model text is not caught.
- (d) `routes.ts:34726` answers `view=accounts` only on `bearerMatches(agent token)` and sits before the `playwrightFeatureEnabled()` 503 at `:34735`; `listAccountsLight` (`src/core/PlaywrightProfileRegistry.ts:422-431`) returns `[]` on a missing file before `read()`, so `seedSkeleton` and every vault path are never reached.
- (e) Every dial goes through `siblingPeerTargets()` = `resolvePeerUrls()` and is refused when the peer's URL no longer matches (`routes.ts:4440-4441`); the 422 `address` is re-resolved the same way (`:5738`).
- (a)/(f) The over-/under-block, interactions and multi-machine answers match the code. One omission worth a follow-up, not a blocker: the spec (§3.4) says the re-review is logged with `reason: 'sibling-confirm'`, but `logToneGateDecision` does not write a `reason` field (`routes.ts:6452-6490`), so the second `[tone-gate]` line is indistinguishable from the first; re-review frequency is measurable only through the `toneGate.siblingReach` evidence rows (`b17-overturned`, `b17-unconfirmed`, `hint-attached`), which do exist. Also note the sibling re-review runs for any kind that builds a reach (the health-alert kind builds none, so no redundant call there).
- Ran locally: unit 24/24, integration 11/11 (`vitest.integration.config.ts`), e2e 2/2 (`vitest.e2e.config.ts`), `tests/unit/self-action-convergence.test.ts` 866/866 including the `sibling-holdings-refresh` ratchet.
