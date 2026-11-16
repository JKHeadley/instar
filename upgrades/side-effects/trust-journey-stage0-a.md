# Side-Effects Review — Trust journey stage 0, PR A: widening needs the person

**Version / slug:** `trust-journey-stage0-a`
**Date:** `2026-11-15`
**Author:** `echo`
**Second-pass reviewer:** `independent security review subagent (see below)`

## Summary of the change

Spec: `docs/specs/trust-journey.md` (approved by Justin, telegram 142440, 2026-11-15 22:15 PST), stage 0, decision 4 and section 6. This is the first of three stage-0 PRs (plan: PR B is the account-path approval, CMT-1837; PR C is governed effects, CMT-1838). This PR also lands the approved spec, its plain-language overview and its convergence report.

A change that widens what the agent may do now needs an `OperatorProof`: evidence of the person's approval for that exact change. Nothing in this PR issues one (the issuer arrives with the account path in PR B), so every widening is refused with `403 operator-approval-required`, which names the approval it needs. Every narrowing still applies at once.

What counts as widening, decided by pure comparisons of structured settings (`src/core/TrustRaiseGuard.ts`):
- a less restrictive trust level for a service operation (`AdaptiveTrust.grantTrust`, `grantServiceTrust`, all or nothing);
- an autonomy profile with wider agent autonomy, safety or evolution self-approval (`AutonomyProfileManager.setProfile`);
- recovering trust after an incident (`TrustRecovery.acceptRecovery`);
- a config change that turns off the external-operation gate or its sentinel, unblocks an operation, drops an ask-first entry, allows a new operation, removes a permission limit, raises a batch limit, drops a service's limits, ends a read-only service, widens the trust floor or turns on auto-elevation, or lets evolution approve or implement on its own (compared against the same file config and the same one-level merge the write uses);
- registering or approving a Slack account as owner or admin;
- any work board policy other than `every-agent-card` through the PIN route.

The trust owners enforce it themselves (defense below the routes); the routes translate the refusal into a 403. Agent-reported approval rows (`POST /approvals`, `POST /autonomy/elevation/record`, evolution proposal decisions) are stored labelled agent-reported and never count toward an offer or eligibility; hiding the rubber-stamp signal is refused. Agent awareness and capability text now say a raise needs the person.

Size: 1 new module, 1 awareness entry, 9 source files edited, 1 new unit and 1 new integration test file, 1 test helper, 7 test files updated. Tier 2 (security-sensitive authority). Spec convergence: 10 rounds before approval; this build: first commit attempt.

## Decision-point inventory

- **Is this change a raise?** `invariant`. Deterministic by design: it compares structured settings in a fixed order (trust levels, profile fields, config lists and flags, role names, policy values), never words or meaning. A raise misread as a narrowing would hand authority without proof, so the classifier errs toward "raise" (unknown levels, replaced blocks and new service entries without limits count as raises).
- **Does this proof cover this change?** `invariant`. A proof counts only if this process issued it (a module-private `WeakSet`) for exactly this proposal hash. No request body, file or config value can produce one.

## 1. Over-block

- The person can no longer widen trust, the profile or the gate config through the console or chat until PR B ships the approval path; the console shows the 403 message ("that approval path is not installed on this version yet, so the setting stays as it is"). Current settings stay where they are, so nothing that runs today stops. Tracked: CMT-1837.
- A dashboard feature toggle in the raise direction (for example switching the external-operation gate off) records the choice but its setting is refused; the existing `apply`/`effective` fields say the setting did not follow. Spec decision 4 says such a toggle opens a request; that arrives with PR B.
- Adding a new service entry that lists no permission limit, block or ask is treated as a raise (the gate's default for an unconfigured service is permissive, so the entry is not a narrowing). A person who only wants to add a limit gets it by listing one.
- Evolution and token-reported decisions no longer feed acceptance statistics, so the existing "evolution governance" and "profile" suggestion cards stop appearing. They could only suggest a raise, which is now refused anyway; the spec's offers (stage 1) replace them with evidence from verified outcomes.

## 2. Under-block

- An agent that edits files on its own host (config, state, source) is outside this spec's threat model (Threat model section); a hand-edited raise is caught by the proof check at load in PR B, not here.
- The mandate PIN arms that issue Slack floor grants predate this spec and are tracked separately (fb-f55d218a-a45).
- Other bearer-reachable safeguard switches (`inputGuard`, `responseReview`, `monitoring`, stop-gate kill switch) are outside this spec, as the spec states.
- Effects of governed kinds are not yet admitted by grants: that is PR C. This PR closes the setting writers.

## 3. Level-of-abstraction fit

The check sits in the trust owners (`AdaptiveTrust`, `AutonomyProfileManager`, `TrustRecovery`), so any future caller inherits it, plus at the two route-only writers that have no owner method (config patch, Slack role registration, board policy). No parallel gate is added: the account path in PR B issues the proof these owners already ask for.

## 4. Signal vs authority compliance

The new authority is deterministic and narrow: it compares structured values and refuses only unproven widenings, which is the constitution's own rule (the agent never widens its own authority). It does not judge meaning, so Signal vs Authority's warning about brittle checks holding authority over judgment does not apply; there is no judgment to make about whether `autonomous` is wider than `log`. The labelled agent-reported rows are signals and are still shown.

## 4b. Judgment-point check

No competing-signals decision point is added. Both decision points are invariants (see inventory).

## 5. Interactions

- `PATCH /config` keeps its allowlist, the executable fence and the self-action governor branch; the raise check runs after them, on the same merge, before any write.
- The feature toggle path goes through `PATCH /config` over loopback, so it is covered with no change of its own.
- `GrowthMilestoneAnalyst` reads `ApprovalLedger.summarize()`; `autoApprovalEligible` is now false unless rows are person-verified, and a new `agentReported` count is added. It is a signal there.
- Rubber-stamp detection still counts every approval (the conservative direction).
- No interaction with `ExternalOperationGate.evaluate`, which does not read trust levels today (G4).

## 6. External surfaces

- New 403 body `{error: 'operator-approval-required', message, needs, raises}` on `POST /trust/grant`, `POST /autonomy/profile`, `PATCH /config`, `POST /permissions/registrations/register|approve`, `POST /autonomy/elevation/dismiss-rubber-stamp`, `POST /work-board/settings`.
- `POST /approvals` rows now store `approver: 'agent-reported'`, `provenance: 'agent-reported'` and `reportedApprover` (the name the caller gave); `GET /approvals/summary` class rows gain `agentReported`.
- Agent instructions: one awareness entry and four capability lines.
- Public text (commits, PR body) describes the class of change, not how the old behaviour could be used.

## 6b. Operator-surface quality (Operator-Surface Quality standard)

The only operator-surface change is data: `ApprovalLedger` rows gain `provenance` and `reportedApprover`, and summaries gain an `agentReported` count. No dashboard renderer, markup, approval page or form is changed, and no screen layout moves.

1. **Leads with the primary action?** Unchanged: no page is edited. The existing console profile switch already shows the server's refusal message in its status line where the action was taken.
2. **Zero raw internals as primary content?** The new 403 message is plain words ("This would widen what the agent may do (...). Widening needs the person's approval from their own direct chat with the agent"); the `error` code is a field, not the displayed text.
3. **Destructive actions de-emphasized?** Not applicable: nothing destructive is added or moved.
4. **Plain language + phone width?** The refusal text is one sentence plus one note; no table or new element, so phone width is unaffected.

## 6c. Agent Proposes, Operator Approves

This change is the floor that standard needs: the agent can no longer author authority for itself through its token or the PIN. (1) The person never constructs a request here; this PR adds no approval surface, and the approval PR B adds is a server-prepared request card the person answers with `approve <code>`. (2) The only new text a person reads is the 403 refusal, composed by the server from structured comparison results (the `raises` list), never from agent free text. `ApprovalLedger` rows written through the token now say plainly that they are agent-reported, so an agent-authored row can never be shown as the person's decision.

## 7. Multi-machine posture (Cross-Machine Coherence)

Machine-local BY DESIGN for this PR, because it adds no state: each machine's trust owners refuse unproven raises from their own files, the same rule on every machine. The replicated grant store and holder-serialized consumption arrive with PR B (spec Multi-machine posture). No notices, no URLs, no new status surfaces.

## 8. Rollback cost

Pure code change, no migration, no new persisted state. Rows written with `provenance` are additive fields older builds ignore. Revert and ship a patch; settings changed during the window were only narrowings.

## Conclusion

The review kept the design. Building made three changes: the guard compares against the effective level (so narrowing an unset operation to `blocked` is not misread as a raise), `grantServiceTrust` is all or nothing, and evolution proposal decisions are labelled agent-reported because their status is set through the same token. The second-pass review then found one must-fix and one should-fix, both closed (see below). Clear to ship.

## Second-pass review (if required)

**Reviewer:** independent security review subagent (general-purpose, Claude Opus 5.5), given the spec and the code, not this artifact's conclusions; two rounds.
**Independent read of the artifact: concur** (round 2), after these changes:

- Must-fix (closed): `evolution.approvalMode: null` fell back to an autonomous profile default without counting as a raise. The check now compares the mode in force (explicit value, or the profile default when unset), assuming the widest default when the profile is unknown.
- Should-fix (closed): token-reported elevation rows could clear the rubber-stamp caution with fake slow latencies, or push server-written rows out of the 200-event history. Route rows now carry `source: 'route'`, may only add caution, and are evicted first.
- Notes acted on: a list field given as a string (the gate substring-matches strings) and giving a permission list to an entry that had none (the gate refused every call to it) now count as raises; the 403 for a `services`/`readOnlyServices` patch says those are replaced whole.
- Notes left, with reasons: proof replay and the exact `from` level belong to the receipt consumption in PR B (CMT-1837); demoting a Slack owner to guest or promoting guest to operator are not raises under decision 4 (approvals read owner ids only from config, never the Slack registry); other bearer-reachable safeguard switches are out of scope per the spec's G1.

## Follow-up commit (2026-11-16)

The full e2e and integration runs found five older tests that relied on raising without proof (console Home's evolution toggle, the work board's PIN policy switch, trust recovery and a migration-provenance profile switch). Each now asserts the refusal, or raises with a test proof where the raise is only setup. The board's policy check moved after its settings validation, so a malformed request is a 400 (nothing written) before any 403.

## Evidence pointers

- Unit: `tests/unit/TrustRaiseGuard.test.ts` (both sides of every classifier; owners refuse an unproven raise).
- Integration: `tests/integration/trust-raise-refusal-routes.test.ts`.
- E2E: `tests/e2e/autonomy-lifecycle.test.ts`, `tests/e2e/trust-elevation-lifecycle.test.ts`.
- Live proof on a throwaway agent (this build, port 4797, 2026-11-15 23:10 PST): 16 checks, every widening 403 with the setting unchanged, every narrowing applied, the token-reported approval row labelled, the gate feature toggle recorded but its setting refused; re-run on the post-review build (23:30 PST) with the evolution-reset and string-list cases, same results. Record: `.instar/lanes/work-front-doors-1114/stage0-prA-live-proof.txt` in the agent home.

## Class-Closure Declaration (display-only mirror)

No agent-authored-artifact defect — not applicable. The defect is in server code (routes and owners that accepted unproven widenings); the agent-facing capability text that told agents to grant trust themselves is corrected in the same change.

---

## Maintainer note (2026-11-16)

The spec's maturation line read `**ladder:** trust.journey`, an id with no entry in `src/data/feature-ladders.json`, which failed `tests/unit/feature-ladders-coverage.test.ts` in Local Verify. Stage 0 is not laddered (spec: "Stage 0 is not laddered. It is a security fix and ships on for every agent"), and no trust-journey switch exists in the code yet, so there is nothing an entry could track. The line now says so and names where the entry will be added (the stage 1 change that introduces the switch). No code, test or approved behaviour changes in that commit.
