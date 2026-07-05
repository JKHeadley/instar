# Round 2 findings — nature-axis-routing

## Conformance gate (round-1 findings resolved; 3 new)
- GR2-1 [Mobile-Complete Operator Actions]: metered go-live requires operator to hand-edit metered-caps.json + flip config = a money-spend authorization that must be mobile-complete → go-live must be a PIN-gated dashboard/API action (structured form), never file editing.
- GR2-2 [Agent Proposes, Operator Approves]: agent should PRE-FILL a structured authorization (proposed cap from projected spend); operator approves via PIN → don't make the operator construct cap+config from scratch.
- GR2-3 [Migration Parity]: FD8 changes frameworkDefaultModels.claude-code off Fable but only migrates sessions.natureRouting → add migrateConfig path for the Fable→account-default change (existence-checked: only if currently claude-fable-5).

## External round 2
- codex-r2: MINOR (down from SERIOUS). CR2-1 sweep "never Claude Code for judgment" wording → "never Opus-family via Claude Code; Sonnet reserve permitted as terminal fallback" (incl ELI16). CR2-2 FD3 E-vs-B ordering under-defined → E,B are equivalent JUDGE-tier (tie→map value, never widens); tightening changes nature only (chain follows map row). CR2-3 FD6 drift baseline lifecycle → add baseline storage/init-at-first-enable/update-on-approval/migration. CR2-4 availability conflates capability+health → structured reason codes (unsupported/notConfigured/budgetClosed/breakerOpen/policySkipped/injectionUnsafe) in logs + /intelligence/routing. CR2-5 mini-policy-engine → declare small policy-schema/evaluator boundary (resolver = pure evaluator; retry/breaker/budget stay in router).
- gemini-r2: (pending)

## Internal round 2 (async)
- security+adversarial: (pending)
- decision-completeness: CONVERGED — no material findings. FD10 narrowed tag accepted; FD12 removes mid-build-stop (cap value = operator runtime config, not parked); open questions empty. (gate's PIN-vs-file-edit is UX-quality not decision-completeness.)
- lessons-aware: LA1/2/3/5/6 RESOLVED. LA4 NOT fully resolved (HIGH): degrade-path clamp fix scoped inside natureRouting.enabled, but fail-open is in main independent of feature → ships dark → real fail-open stays LIVE on fleet. FIX: make degrade-path clamp UNCONDITIONAL (standalone safety fix, fires with feature unset, test both defaultFramework values unset). CONSEQUENCE: correct the "byte-identical/untouched unconfigured path" claim — the clamp narrows the degrade path Opus-CLI→Sonnet-CLI even when unset (acceptable safety narrowing, but state it honestly).
- scalability+integration: M1 FD8 Fable→Opus NO migration (=GR2-3) → content-sniffed migrateConfig (if claude-code===claude-fable-5 && ==prior shipped default → Opus/unset), idempotent, override-preserving. M2 FD12 N>1 detection unstated + counting reachable peers FAILS OPEN (partitioned machine reads N=1 double-spends) → key disable on multiMachine CONFIGURED (registered peer ever/pool enabled), fail-safe assume N>1 under uncertainty. M3 S1 in-mem counter boot-only-reconcile assumes single-process-writer → state+justify single-writer invariant (metered calls in server process) OR short-cadence reconcile. M4 Int2 override-preservation states property not mechanism → discriminator: overwrite only a position byte-equal to PRIOR VERSION's shipped default (store prior default per schemaVersion).

## sec+adv r2 (NEW material)
- Sr2-1 HIGH FD4 family predicate is DENYLIST where invariant is ALLOWLIST (unrecognized capable Claude id fails open) → allowlist: only sanctioned Sonnet-4.6 reserve id permitted on claude-code FAST/SORT/JUDGE, deny-by-default. [FIXED]
- Sr2-2 MED-HIGH metered go-live agent-self-authorizable (config bool via PATCH) → PIN-gated dashboard action, agent proposes/operator approves. [FIXED, = gate GR2-1/2]
- Sr2-3 MED N-detection can race transiently-dark peer (reads N=1 double-spends) → fail-closed, membership-uncertain→N>1. [FIXED, = M2]
- Round-1 items verified resolved. fall-to-defaults safe (defaults are build-lint-validated).

## gemini r2: DEGRADED (timeout) — codex r2 RAN clean, so round still got a real external opinion; spec-level flag stays codex-cli:gpt-5.5 (both rounds had a successful codex pass).

## ROUND-2 STATUS: all material findings (gate 3 + codex 5 + LA4 + M1-M4 + sec-r2 3) addressed. decision-completeness CONVERGED. → round 3 convergence check.
