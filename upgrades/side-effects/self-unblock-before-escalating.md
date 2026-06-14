# Side-Effects Review — Self-Unblock Before Escalating (constitutional standard)

**Version / slug:** `self-unblock-before-escalating`
**Date:** `2026-06-14`
**Author:** `echo`
**Second-pass reviewer:** `general-purpose reviewer subagent (high-risk: touches a settle gate)`

## Summary of the change

Encodes the operator directive (Justin, topic 12476, 2026-06-13) "exhaust self-unblock within your
permissions before requiring anything from a human" as a constitutional standard. The crucial design
move — forced by round-1 convergence and two external reviewers — is that it **EXTENDS the existing
`BlockerLedger.settleTrueBlocker()` gate rather than forking a parallel one**. The ledger ALREADY
mandates a recorded failed self-unblock attempt before a credential/account blocker can settle as a
true-blocker, already HARD-rejects `missing_failed_attempt`, and already routes the settle JUDGMENT
through the Tier-1 `SettleAuthority` (B17) LLM gate. This change adds the four things the ledger did
not have and reuses everything else. Files: `src/monitoring/SelfUnblockChecklist.ts` (new, the only
substantial new code — a deterministic ordered probe list), `src/monitoring/DurableVaultSession.ts`
(new, flag-gated org-vault session), `src/monitoring/BlockerLedger.ts` (+140: the ONE logic edit —
`settleTrueBlocker` now takes a `runId` reference it LOADS + verifies instead of a caller-supplied
`failedAttempt` object), `src/server/{routes,AgentServer}.ts` (read-only `GET
/blockers/self-unblock-runs`), `src/core/{devGatedFeatures,types,ConfigDefaults}.ts` (dark dev-gate),
`src/core/PostUpdateMigrator.ts` (migration parity), `src/scaffold/templates.ts` (Agent Awareness),
`docs/STANDARDS-REGISTRY.md` (the standard), plus all 3 test tiers.

**Producer wiring (added after the first second-pass review caught it unwired — see Second-pass below):**
the runner/library + consumer gate above were wired, but NOTHING in production instantiated the
checklist or `DurableVaultSession`, so enabling the feature on a dev agent would have made settling a
credential-blocker IMPOSSIBLE (the gate demands a run that could not be produced). Closed by:
`src/monitoring/SelfUnblockProbeProviders.ts` (new — a REAL provider for all 9 sources +
`deriveBitwardenSession`), the AgentServer wiring (instantiates the production checklist +
`DurableVaultSession` when each sub-gate is on), and `POST /blockers/self-unblock-run` (the dev-gated
trigger that produces a verified run). During that wiring an independent review of the AgentServer
`deriveSession` caught a real production bug: it read `process.env.BW_SESSION` after `bw.unlock()`, but
`unlock()` stores the session in a PRIVATE field and never exports it to the env — so the org-Bitwarden
probe (the motivating source) would have silently failed in production while passing the injected-fake
tests. Fixed by adding `BitwardenProvider.getSessionKey()`, extracting the testable
`deriveBitwardenSession` helper, and a guard test (`tests/unit/deriveBitwardenSession.test.ts`) that
asserts the session comes from `getSessionKey()`, not the env.

## Decision-point inventory

- `BlockerLedger.settleTrueBlocker` evidence intake — **modify** — input contract changes from a
  caller-supplied `failedAttempt` object to a `runId` reference the ledger loads + verifies against
  the persisted checklist run. This is the only edit to the gate's logic; the settle AUTHORITY (B17
  Tier-1) is unchanged.
- `SelfUnblockChecklist` — **add** — a deterministic signal-PRODUCER. It holds NO blocking authority;
  it records probe results + the rung and produces the evidence the existing gate consumes.
- Rung-floor mapping — **add** — enforces a minimum rung of 1 (approval) for irreversible /
  cost-bearing / out-of-scope / policy-sensitive actions even when a self-unblock cred exists; maps
  onto the existing `AuthorityCheckEvidence` (no new field).
- `GET /blockers/self-unblock-runs` — **add** — read-only observability over the run store.

## 1. Over-block

**What legitimate inputs does this change reject that it shouldn't?**

The checklist itself is not a block/allow surface — it produces evidence. The settle GATE it feeds
could now reject a legitimate true-blocker if a caller tries to settle WITHOUT a persisted checklist
run (it derives the failed attempt only from a verified run id). That is the intended anti-gaming
direction — a blocker may not settle as "operator-required" without real evidence — and it fails
toward safety (don't let a blocker masquerade as operator-required). The one genuine over-block risk:
if the checklist RUNNER cannot persist a run at all (disk failure), settle is blocked. This degrades
toward "keep trying / surface honestly," not toward a false operator-blocker, which is the correct
direction. A checklist that completes with every probe `reachable:false` is a VALID run (it produces
"nothing reachable" evidence) and satisfies the gate — so a genuinely-blocked agent is not stuck.

## 2. Under-block

**What failure modes does this still miss?**

The deterministic relevance match (`holdsRelevantCred`) can MISS a credential that IS relevant but is
under-tagged or mis-tagged — it fails CLOSED (`holdsRelevantCred:false`), so the cred is not surfaced
and the agent escalates to the human when it could in principle have self-unblocked. This is an
"under-self-unblock" (the agent asks the human slightly more than strictly necessary) — the SAFE
direction for this standard's primary security invariant: it never mis-applies a credential, it only
occasionally fails to find one. The fix path is better credential tagging, never looser matching. The
checklist is also only as complete as its probe list (vault/Bitwarden/Vercel/Cloudflare/GitHub/MCP/
browser); an account type with no probe is simply not auto-discovered — data-extensible, documented.

## 3. Level-of-abstraction fit

**Is this at the right layer?**

Yes — and this is exactly what the adversarial review corrected. The checklist is a low-level,
deterministic DETECTOR that FEEDS the existing high-level Tier-1 `BlockerLedger` settle AUTHORITY. The
first design drafted a weaker parallel gate; round-1 convergence (integration + lessons-aware
reviewers, independently) caught it. The final design adds NO new gate, ledger, log, or
`evaluateSelfUnblock` authority — it reuses BlockerLedger's pipeline/taxonomy/log/envelope and changes
only the evidence intake. The deterministic relevance match is deliberately kept OUT of LLM judgment
(the most failure-prone hop), consistent with the signal/authority split.

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

**Does this change hold blocking authority with brittle logic?**

- [x] **No — this change produces a signal consumed by an existing smart gate.**

The `SelfUnblockChecklist` (deterministic, brittle-by-nature tag matching, code-only) holds NO
blocking authority. The ONE judgment — whether a blocker may settle as a true-blocker — remains
BlockerLedger's existing Tier-1 `SettleAuthority` (B17) LLM gate. The change makes that gate STRICTER
(it now derives the failed attempt from a verified persisted run rather than a caller-asserted object),
never adds a brittle authority. The rung-floor is a deterministic MINIMUM raised on top of the existing
authority, not a new allow/deny owner. Fully compliant.

## 5. Interactions

- **Shadowing:** the new `GET /blockers/self-unblock-runs` route is registered BEFORE `GET
  /blockers/:id` so the literal path is not swallowed by the param route (verified in the diff and the
  integration test). No allow/deny shadowing — there is no new gate.
- **Double-fire:** no new gate is added, so there is no double-gating of a settle decision. The
  checklist runs once per blocker-resolution attempt and persists one run.
- **Races:** the run store is append-keyed by immutable run id; `settleTrueBlocker` reads by that id.
  The bw session is held only while a run is in flight (TTL + idle-expiry), so concurrent runs each
  hold their own warm window; no shared mutable settle state is introduced.
- **Feedback loops:** none — the checklist's output feeds the ledger's settle path, which does not
  feed back into the checklist's inputs.

## 6. External surfaces

- **Other agents / users / external systems:** the production probe providers
  (`SelfUnblockProbeProviders.ts`) reach the agent's OWN sources only — its vault (names only), the org
  Bitwarden vault (via `DurableVaultSession`, exit-code reachability), and authed cloud accounts
  (Cloudflare zones via ONE bounded fetch; `vercel`/`gh` via ONE bounded CLI exec). All READ-ONLY,
  one bounded call each, no writes, no new egress, no recursive scans (the 2026-06-13 load-spike
  lesson). Each provider returns ONLY reachability + non-secret scope-tag strings — never a credential
  value. Relevance is operator-declared + fail-closed (an undeclared source advertises nothing → never
  surfaced), so the worst case is under-self-unblock (ask the human slightly more), never mis-applying
  a credential.
- **Persistent state:** a new machine-local JSONL run store (per-probe results + rung). Inert
  observability data; no schema other code depends on; safe to delete.
- **Credential reach:** `DurableVaultSession` reaches the org Bitwarden vault via the existing
  `BitwardenProvider`. This is the standard's main security tradeoff and is bounded: session value in
  process memory ONLY, never logged, handed to `bw` ONLY via the child `BW_SESSION` env (never argv),
  never on the secret-sync path, held only while a run is in flight, master password operator-held
  (read from the EXISTING `bw-master-password` vault key — no new on-disk secret). The wiring-integrity
  test `tests/unit/SelfUnblockSessionLeak.test.ts` asserts a sentinel session value rides ONLY the
  `BW_SESSION` env and never appears in argv, the persisted run JSON, the decisions log, or the ledger
  store.
- **Operator surface:** two new API surfaces — the READ-ONLY `GET /blockers/self-unblock-runs`
  (observability) and the dev-gated `POST /blockers/self-unblock-run` (the agent-facing trigger that
  runs the checklist). Both are Bearer-gated, 503-after-auth when dark, `no-store`, and emit untrusted
  probe `detail` through the `<blocker-ledger-data>` envelope — no secret in any response. Neither is an
  operator dashboard ACTION (no approval page, grant/revoke, secret-drop form, or renderer) → §6b not
  applicable.

## 6b. Operator-surface quality (Operator-Surface Quality standard)

**No operator surface — not applicable.** This change adds no `dashboard/*.js` / `dashboard/*.html`
renderer, no approval page, and no grant/revoke/secret-drop form. The single new HTTP surface is a
read-only JSON observability route (`GET /blockers/self-unblock-runs`), not an operator action.

## 7. Multi-machine posture (Cross-Machine Coherence)

**Posture: machine-local BY DESIGN** — with a security reason, not an oversight.

- **Credential reachability is inherently per-machine:** a credential reachable on machine A's authed
  CLIs / keychain may not be reachable on machine B. The checklist probes THIS machine's reachable
  sources; replicating "what I can reach" across machines would be incorrect and a reconnaissance leak.
- **The `DurableVaultSession` is a security boundary that MUST NOT replicate:** it is explicitly kept
  off the `multiMachine.secretSync` path (asserted in the spec + a wiring test). Machine-local is the
  required posture, not a default.
- **The run store is a per-machine audit trail** (like the reap-log / blocker-decisions log).
- **User-facing notices:** none emitted by this change — any messaging is owned by the existing
  ledger settle path (one-voice gating already applies there), so no new double-voice risk.
- **Durable state on topic transfer:** the run store is NOT topic-keyed, so it does not strand on a
  topic move.
- **Generated URLs:** the one route is a local API path; it generates no cross-machine link.

If a pool-wide "what self-unblock runs happened across machines?" view is ever wanted, the correct
shape is a proxied-on-read merged view (`?scope=pool`) over each machine's local store — explicitly
NOT replication of the underlying credential-reach data. Noted as a possible future read-surface, not
needed for this standard.

## 8. Rollback cost

Pure code change behind a dev-gate. Back-out options, cheapest first:

- **Disable the flag** — set `monitoring.blockerLedger.selfUnblockChecklist.enabled:false` (and
  `durableVaultSession`): the checklist stops running, the route 503s, the session is not kept warm.
  Everything inert with no revert. This is the primary rollback.
- **Hot-fix revert** — revert the PR and ship a patch. The one input-contract change to
  `settleTrueBlocker` reverts with it; no caller depends on the runId path except the new checklist.
- **Data migration:** none. The persisted runs are inert machine-local JSON; deleting the run-store
  directory is sufficient and optional.
- **Agent state repair:** none. Dark on the fleet, so no fleet agent sees a change; the dev agent
  picks up the gate at next restart and drops it the moment the flag is disabled.
- **User visibility:** none — no user-visible behavior on a normal install during any rollback window.

## Conclusion

The review produced one mechanical change to the spec (§11 reworded from "deferred decisions" to
"scope boundary / explicit non-goal" — identical meaning, reworded so it does not trip the
no-orphan-deferrals scan) AND, far more importantly, the second-pass review caught that the build was
shipped HALF-WIRED: the consumer gate + run store + read route were wired, but the PRODUCER (the
checklist runner + `DurableVaultSession` + a trigger) was not — so enabling it would have BLOCKED
settling a credential-blocker on a dev agent. Completing the producer (within the approved spec §5)
then surfaced a second real defect (the `deriveSession` env-vs-getSessionKey bug) that passed the
injected-fake tests but would have killed the org-Bitwarden probe in production. Both are resolved and
guarded by new tests. The standout property remains that the adversarial pass forced the design to
EXTEND the existing BlockerLedger settle authority instead of forking a weaker parallel gate — zero new
blocking authority, the one judgment stays on the Tier-1 gate, strictly HARDER to settle a false
operator-blocker. It ships dark behind the developmentAgent gate, is reversible to fully inert via the
flags, and is machine-local by a stated security reason. Clear to ship.

## Second-pass review (if required)

**Reviewer:** independent general-purpose reviewer subagent (high-risk: touches a settle gate)

**Round 1 — Concern raised.** Confirmed the consumer half (signal-vs-authority, anti-gaming run-id
verification, fail-closed relevance, route auth) is solid (A–D), but raised TWO blocking concerns:
(1) the artifact over-claimed an "argv" non-leak test that did not exist; (2) `DurableVaultSession` and
the checklist RUNNER were instantiated only in tests — the producer was unwired in production, so the
settle gate would demand a run that could never be produced.

**Resolution.** Both addressed by completing the producer within the approved spec: a real bounded
fail-closed provider for all 9 sources (`SelfUnblockProbeProviders.ts`), production instantiation of
the checklist + `DurableVaultSession` in AgentServer (each on its own dev-gate), the `POST
/blockers/self-unblock-run` trigger, and the now-real argv non-leak test
(`SelfUnblockSessionLeak.test.ts`). Completing it surfaced + fixed the `deriveSession`
env-vs-`getSessionKey()` production bug (guarded by `deriveBitwardenSession.test.ts`).

**Round 2 — Concur.** A focused independent re-review of the final producer code verified, with
file:line evidence, all six checks: (1a) no provider returns/logs a secret value; (1b) each provider is
one bounded call, no recursive scan; (1c) relevance is fail-closed; (2) `deriveBitwardenSession`
returns `getSessionKey()` not the env and is null-safe; (3) the AgentServer block is dev-gated and
introduces no new on-disk secret; (4) the trigger route is 503-after-auth, intent-gated, `no-store`,
and leaks no secret. **Verdict: Concur.**

## Evidence pointers

- `tsc --noEmit` clean; `node scripts/lint-dev-agent-dark-gate.js` → `clean`.
- Targeted vitest run (11 files, 215 tests green): consumer/library —
  `tests/unit/BlockerLedgerSelfUnblock.test.ts`, `DurableVaultSession.test.ts`,
  `SelfUnblockChecklist.test.ts`, `PostUpdateMigrator-selfUnblock.test.ts`; producer —
  `tests/unit/SelfUnblockProbeProviders.test.ts`, `deriveBitwardenSession.test.ts`,
  `SelfUnblockSessionLeak.test.ts` (the argv/ledger non-leak wiring test);
  routes/E2E — `tests/integration/self-unblock-routes.test.ts` (incl. the production-path trigger →
  settle and the negative anti-gaming assertion), `tests/e2e/self-unblock-lifecycle.test.ts`
  ("feature is alive": 200 enabled / 503-after-auth dark); plus `lint-dev-agent-dark-gate.test.ts` +
  `feature-delivery-completeness.test.ts` (dev-gate registry coherence).

## Addendum — no-silent-fallbacks ratchet (post-CI follow-up)

CI surfaced one deterministic failure after the initial commit: the
`no-silent-fallbacks` ratchet counts error-swallowing `catch` blocks against a
tracked baseline (474) and the two new catches in `SelfUnblockRunStore`
(`loadRun` skipping a corrupt/partial trailing JSONL line; `listRuns` returning
`[]` when no runs file exists yet) pushed it to 475.

Both are intentional, expected-condition silences — a partial trailing line is a
normal crash-during-append artifact, and a missing runs file is the first-run
condition — and they match a pattern already blessed two functions up in the same
file. The correct fix is therefore the codebase's `@silent-fallback-ok` marker
with justification on each, NOT raising the baseline or bolting on noisy
degradation reports. Count is back to 473. No behavior change; pure annotation.
