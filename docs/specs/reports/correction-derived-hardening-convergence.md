# Convergence Report — Correction-Derived Hardening

## Cross-model review: codex-cli:gpt-5.5

RAN. A real GPT-tier external pass ran through the agent's codex CLI in ALL
THREE rounds (round 1: MINOR ISSUES — capability-context concern, folded into
the round-1 synthesis; round 2: MINOR ISSUES — cosmetic example-pair
suggestion, non-material: both decision boundaries are exercised in
`tests/unit/messaging-tone-gate-b21.test.ts`; round 3, on the advisory
revision: MINOR ISSUES — rollback-wording contradiction + ack-contract seam
scope, both fixed in-round).

## ELI10 Overview

On July 18 the operator corrected the agent twice in one evening and then said
the thing this spec exists to honor: every correction should turn into an
infrastructure change, not a note in one agent's memory. The first correction:
the agent had handed the operator a "just click through these portal steps"
checklist for a Slack setup task — the operator ruled that handing humans
click-work is never acceptable; agents do browser work and may only ask for a
credential or an approval. The second: the agent asked the operator which
account manages a workspace the agent itself had built — its own records held
the answer (a test account it had provisioned OWNED the workspace), but its
"I've checked everywhere" machinery never looked at identities it had created.

This change turns both corrections into machinery. One: the gate every
outgoing message already passes gets a new rule (B21) that catches messages
handing the user a multi-step procedure for agent-doable work — while still
passing one-tap links, genuine approvals, and things only a human can do. Two:
the self-unblock checklist — the machinery that must be exhausted before the
agent may claim "this needs the operator" — gains a new probe that consults a
small registry of identities the agent provisioned, so "check your own
creations first" is structural, not remembered.

The main tradeoffs: the gate rule adds a small permanent prompt cost to every
outbound review and ships live (like every gate rule); and the registry only
helps if identities get registered — the structural registration path is a
tracked follow-up (CMT-905), with the habit-forming trigger shipped in every
agent's instructions meanwhile.

## Original vs Converged

The original draft was directionally right and materially incomplete in ways
two review rounds fixed:

- **The stale-registry trap (biggest catch, found by the second-pass reviewer
  and sharpened by round 1):** originally, a registry entry advertised its
  scopes unconditionally. A stale entry would then look like a held credential
  forever — making the checklist never-exhausted, which the blocker ledger
  interprets as "you can still self-unblock," refusing the escalation path
  permanently. Converged: entries only advertise when their credential POINTER
  resolves right now (file exists / vault key present), jailed to the agent
  home, so a fully-stale registry behaves exactly like no registry.
- **Bounded and hygienic:** the probe originally read up to 1 MB and looped
  every entry with a stat each. Converged: 256 KB cap, 500-entry hard bound,
  per-path stat cache, and every string clamped + control-char-stripped before
  it can ride into any downstream surface.
- **B21 capability-blindness:** reviewers (internal adversarial + codex)
  converged on the same point — the gate can't see what the agent can actually
  do, so an over-eager rule could block honest escalations. Converged: an
  explicit capability-uncertainty default-PASS plus a widened human-only
  carve-out (personal inboxes, personal-device 2FA, person-bound accounts).
- **Honesty upgrades:** the always-on token cost and live-on-release exposure
  of the gate rule are now stated; the spec no longer claims the liveness gate
  "can never block a settle" (a resolving-but-stale entry can, until pruned —
  now documented with the recovery path); the migration text matches the real
  append-only convention; a wiring-integrity ratchet test pins the production
  callsite; cross-machine recurrence (WS2 metadata replication) and structural
  registration are tracked follow-ups (CMT-906, CMT-905) instead of silent
  gaps.

## Iteration Summary

| Iteration | Reviewers who flagged | Material findings | Spec changes |
|-----------|-----------------------|-------------------|--------------|
| 1 | security(2), scalability(2), adversarial(2), integration(5), decision-completeness(4), lessons-aware(4), codex(1 overlapping) | 18 (with overlaps ~15 distinct) | jail + clamps + bounds + loud-unparseable in provider; capability-uncertainty default-PASS in B21; canonicalization frontloaded; decision-table honesty; machine-local-justification key; migration text reconciled; wiring ratchet; CMT-905/906 tracked follow-ups; cost/exposure disclosure |
| 2 | (converged) — all six internal RESOLVED + no new material; codex MINOR (cosmetic) | 0 material | none |
| 3 | OPERATOR DESIGN REDIRECT (23:00 PDT): B21 must be advisory-only — sentinels nudge, the agent decides, overrides recorded. Codex re-pass: MINOR (rollback wording contradiction; ack-contract seam scope) — both fixed | 1 directive + 2 minor | RULE_DISPOSITIONS map (B21 advisory, ratchet keyset==VALID_RULES); seam split 422 tone-gate-advisory/notSent + toneAdvisoryAck recorded-override path (telegram + slack conversational seams); advisory can never block, ack can never override a blocking rule (both test-enforced incl. end-to-end route test); spec/decision-table/rollback/fragment rewritten to the nudge model; migration intent for B15-B19 tracked (CMT-904) |

Standards-Conformance Gate: ran rounds 1, 2, and 3 (0 flags each), not
degraded. Per-round reviewer models: internal reviewers ran as fresh-context
`claude -p` one-shots on claude-opus-4-8 (the fork's authoring session runs
claude-fable-5; the one-shot door pins opus — recorded honestly per D7);
external = codex-cli gpt-5.5 both rounds; clean-door anthropic family not
separately run (the opus one-shots ARE clean-door reads, disclosed here rather
than flagged as cross-model).

## Full Findings Catalog

### Round 1 — security
1. MATERIAL — unclamped registry strings flow into the settle authority's
   envelope. → Resolved: `clampRegistryString` (128-char + control-char strip)
   on every name/tag; clamp test added.
2. MATERIAL — un-jailed `file:` refs stat arbitrary host paths and any extant
   file satisfies liveness. → Resolved: agent-home jail with `..`/absolute
   escape refused BEFORE any stat (test: out-of-jail paths never statted);
   weak-liveness guarantee stated honestly in the spec.

### Round 1 — scalability
3. MATERIAL — unbounded synchronous stat loop (rule-(b) violation; runner
   timeout can't interrupt sync code). → Resolved: 256 KB read cap, 500-entry
   processing bound (overflow counted), per-path stat cache.
4. MATERIAL — B21's permanent per-message token cost + live fleet-wide
   exposure undisclosed. → Resolved: "Cost + exposure" section added.

### Round 1 — adversarial
5. MATERIAL — B21 capability-blindness can block the only honest unblock
   message. → Resolved: capability-uncertainty default-PASS + widened
   genuinely-lacks-means carve-out (also the codex round-1 finding).
6. MATERIAL — present-but-unparseable registry silently re-creates the
   founding bug. → Resolved: fail-closed + loud bounded server-log warning +
   distinct detail text.

### Round 1 — integration/deployment
7. MATERIAL — missing machine-local-justification key. → Resolved:
   `physical-credential-locality` marker added.
8. MATERIAL — WS2 replicated-store family not engaged; incident can recur
   cross-machine. → Resolved: engaged + metadata-only replication registered
   as tracked CMT-906.
9. MATERIAL — spec text claimed in-place migration; implementation appends.
   → Resolved: spec reconciled to the append-only convention.
10. MATERIAL — no wiring-integrity test (the parent feature's founding
    regression class). → Resolved: ratchet test pins the AgentServer callsite.
11. MATERIAL — no independent off-switch unstated. → Resolved: stated
    honestly (rides `monitoring.blockerLedger.*`; rollback = source removal).

### Round 1 — decision-completeness
12. MATERIAL — target/scopeTag canonicalization un-frontloaded. → Resolved:
    canonical `service:scope` opaque-id convention frontloaded + stated in the
    CLAUDE.md trigger and migrator text.
13. MATERIAL — liveness-gate decision-table row overstated ("can never block
    a settle"). → Resolved: honest-limit rewrite naming the resolving-but-
    stale case and the inherited foundation coupling.
14. MATERIAL — stranding residual understated ("one wasted attempt"). →
    Resolved: recovery path (prune the entry) documented in spec + CLAUDE.md.
15. MATERIAL — rung-floor interaction unstated (owned identity ≠ authority).
    → Resolved: capability-≠-authority bullet added to spec + template intent.

### Round 1 — lessons-aware
16. MATERIAL — P1: registration is willpower-only. → Resolved: acknowledged;
    structural registration path tracked as CMT-905 (never claimed solved).
17. MATERIAL — L7: no founding-scenario reproduction. → Resolved: the
    checklist-level test reproduces the incident shape (workspace-owner
    identity, opaque team-id tag, live ref → NOT exhausted; stale variant →
    exhausted).
18. MATERIAL — foundation coupling asserted away. → Resolved: surfaced as an
    inherited design property of BlockerLedger's refuse-while-not-exhausted.

### Round 1 — codex-cli (gpt-5.5)
19. MINOR-overlapping — B21 capability-context (same as #5). → Resolved with #5.

### Round 2 — all perspectives
All round-1 findings verified RESOLVED by a fresh six-perspective pass; zero
new material findings. Codex round 2: MINOR ISSUES (add PASS/BLOCK example
pairs — cosmetic; both boundaries are test-exercised; the worked block example
lives in the b21 unit test rather than the prompt to keep the always-on token
cost down).

### Round 3 — operator redirect + codex re-pass

The operator's mid-build directive (nudge-not-block for outbound sentinels) was
incorporated as a structural disposition layer; conformance gate re-ran clean
(0 flags); codex-cli:gpt-5.5 re-reviewed the advisory revision (MINOR ISSUES:
a rollback-wording contradiction and the ack-contract seam scope — both fixed
in the same round). The advisory disposition strictly REDUCES Change A's
authority, so rounds 1-2's over-block analyses remain valid as conservative
bounds.

## Convergence verdict

Converged at iteration 3 (iteration 2 on findings; iteration 3 incorporated an
operator design directive and its codex re-pass with zero remaining material
findings). No material findings in the final round; zero open
questions; both residuals disclosed and commitment-tracked (CMT-905, CMT-906).
Spec is ready for user review and approval.
