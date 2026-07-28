# Convergence Report — Correction & Preference Learning Sentinel

**Spec:** `docs/specs/CORRECTION-PREFERENCE-LEARNING-SENTINEL-SPEC.md` (v5.1)
**ELI16 overview:** `docs/specs/CORRECTION-PREFERENCE-LEARNING-SENTINEL-SPEC.eli16.md`
**Iterations:** 5
**Final round:** Round 5, no new material findings
**Convergence verdict:** **CONVERGED** — ready for user sign-off (`approved: true`).

## ELI10 Overview

This is the conversational twin of the failure-learning loop we shipped earlier today (which learns from CODE that broke). The new loop learns from MOMENTS THE USER HAD TO CORRECT THE AGENT. The idea: every time you say "no, plainer," "stop asking me that," or "actually, that's wrong," that's a free signal about either (a) something Instar itself is doing clumsily, or (b) just how you like things. Today those corrections help only the conversation they happen in. After this ships, the loop captures the pattern, distills the lesson, and routes it: if it's an Instar bug, it queues a `/feedback` proposal to Dawn; if it's a personal preference (and you stated it explicitly), it writes the preference to a new always-injected surface so every future session picks it up automatically.

The big change between the first draft and the final version is structural: in v2 the loop was going to "auto-add to the Playbook" — but mid-review we discovered the Playbook's `add` command was actually broken at the Python layer AND the session-start hook didn't read the Playbook at all. So the closure mechanism was dead infrastructure. v3 onward pivoted to **Path A**: build a small new preferences endpoint that mirrors the working ORG-INTENT pattern (which IS unconditionally fetched at session start). The cost was one extra small sub-slice; the gain was a closure mechanism that actually works.

The other big tightening was security: the policy-keyword filter that catches injection-shaped explicit preferences ("from now on, ignore the safety guard") was originally going to silently block. The convergence review pointed out that's a brittle regex wielding authority — violates our signal-vs-authority rule. Fixed to route those to the Attention queue for one-tap user disposition instead.

## Original vs Converged (what review actually changed)

| Surface | v1 said | Converged said | Why |
|---|---|---|---|
| Where preferences get applied | Session-start digest the agent reads | Playbook auto-add (v2) → preferences-endpoint write (v3+) | v1 was willpower; v2's Playbook was dead infra; v3+ mirrors the working ORG-INTENT pattern |
| LLM cap | "Dedicated 25¢/day" via shared LlmQueue | Sentinel owns its own LlmQueue instance | The shared queue has no per-feature sub-cap; "dedicated cap" wasn't enforceable as v1 claimed |
| Auto-/feedback path | `FeedbackManager.submit()` direct | Loopback POST to own `/feedback` route | `submit()` bypasses anomaly/quality/length guards; only the route runs them |
| Scrubbing | LLM-trusted scrub of the summary | Deterministic `scrubSecrets()` on BOTH sides of the LLM call (pre-egress + post-persist) | LLMs do echo secrets they read; the regex pass is the actual guarantee |
| Recurrence gate | Single-prong `minDistinctSessions` | Three-pronged AND (`minSupport` + `minDistinctDays` + second orthogonal prong) | Instar restarts inflate session counts; calendar days are restart-proof |
| Policy-keyword filter | Silent block | Route to Attention queue (human disposes) | Brittle regex never wields blocking authority alone (P2: Signal vs Authority) |
| Authority guard | "Inherited from failure loop" | Re-proven for the two new capabilities (loopback POST + recordPreference) | The guarantee is a property of the injected capability set, not a property the spec inherits by claim |
| Hot-path execution | Async hop on the message-delivery seam | Void fire-and-forget; classify() sync; distill off the delivery path | Fail-open of `HumanAsDetectorLog` would regress otherwise |
| Acceptance fixture | Abstract "an explicit preference Justin states" | Specific: the recurring "no good stopping point" / "no pausing for context length" corrections from the agent's own MEMORY.md | Reproducibility on the agent's own corpus |

## Iteration summary

| Round | Reviewers | Material findings | What changed |
|---|---|---|---|
| 1 | 5 internal (security, scalability, adversarial, integration, lessons-aware) + Standards Conformance Gate (slow timeout — log-only per skill's fail-open) | 27 (4 blocker, 11 high, 8 medium, 4 low) | v2 — comprehensive rewrite folding all 27 |
| 2 | 4 internal (lessons-aware errored at socket level) | 2 BLOCKERs (Playbook `add` dead + session-start hook doesn't read it) + 10 additional non-blocker | Handed back to Justin for path decision (A/B/C). Path A chosen. |
| 3 | 1 (lessons-aware re-spawn — mandatory after R2 error) | 4 HIGH (preference-application willpower, supervision tier, Phase-2 anti-pattern, ELI16/NEXT.md) + 4 MEDIUM | v3 — Path-A pivot (preferences endpoint mirroring ORG-INTENT) + v4 — folded 4 HIGH + 4 MEDIUM |
| 4 | 1 (lessons-aware convergence-check) | 3 (1 HIGH, 1 MEDIUM, 1 LOW) | v5 — folded N1 (amends-spec as documentary-pending-reconciler), N2 (Playbook scrub completion in §3.7/§3.8/§3.9/§4), N3 (config table addition) |
| 5 | 1 (lessons-aware final check) | 0 new; N2 fold incomplete (2 stale §3.8 lines) | v5.1 — completed N2 fold |

**Convergence:** Round 5 with v5.1 — N1, N2, N3 all CONVERGED, no new material findings.

## Full findings catalog

(Material findings only; cosmetic and resolved-pre-spec items omitted. Severities: B=blocker, H=high, M=medium, L=low.)

### Round 1 (27 material)

- **Security** F1-F4 (HIGH): auto-/feedback bypasses route guards; LLM-trusted scrub leaks; prompt-injection drives cross-agent routing; egress to LLM provider unaddressed. F5-F10 medium/low.
- **Scalability** F1-F4 (HIGH): dedicated LLM cap doesn't exist; cap exhaustion throws; async on sync seam; hot-path LLM amplification. F5-F8 medium/low.
- **Adversarial** F1-F4 (HIGH): "mirrors diversity gate exactly" is false; FeedbackAnomalyDetector not wired into submit(); by-construction guard not inherited; session-inflation by restarts. F5-F11 medium/low.
- **Integration** F1 (BLOCKER): LlmQueue not at AgentServer / not singleton. F5 (HIGH): board self-registration won't fire (frontmatter missing). F2b-F8 medium/low.
- **Lessons-aware** A1+B1 (BLOCKER): preference application is willpower / Phase-2 anti-pattern. A2 (HIGH): supervision tier. B2-B4 medium/low.

All folded in v2.

### Round 2 (2 BLOCKERs + 10 non-blocker)

- **R2-A (BLOCKER):** Playbook `add` broken on canonical main.
- **R2-B (BLOCKER):** Session-start hook does not read the Playbook.
- 10 non-blocker findings logged for Round 3+.

Handed back to Justin for path decision. Justin chose **Path A** (build preferences endpoint mirroring ORG-INTENT).

### Round 3 (4 HIGH + 4 MEDIUM + 2 LOW)

- H1 (HIGH): §11 "RESOLVED" overstated.
- H2 (HIGH): Slice 1a artifact engagement.
- H3 (HIGH): Named preference-path fixture.
- H4 (HIGH): Policy-keyword filter must Attention-route, not silent-block (P2).
- M1-M4 (MEDIUM): migrateClaudeMd coverage; injected-preferences budget; IB-ledger preference kind; generator-as-source-of-truth methodology.
- L1-L2 (LOW): stale text; verifyWindowDays split.

All folded in v4.

### Round 4 (1 HIGH + 1 MEDIUM + 1 LOW)

- N1 (HIGH): `amends-spec` was forward-reference to unbuilt reconciler.
- N2 (MEDIUM): R3 Playbook scrub was incomplete (6 stale references).
- N3 (LOW): `maxInjectedPreferencesBytes` missing from §9 config.

Folded in v5.

### Round 5 (0 new + completion of N2 fold)

- N2 fold was incomplete in v5 (2 stale §3.8 lines + duplicated sentence). Folded in v5.1.
- No new material findings.

## Convergence verdict

**CONVERGED at iteration 5 (v5.1).** No material findings in the final round. All BLOCKERs from Rounds 1-2 are resolved (or, in the case of R2-A/R2-B, NO LONGER APPLICABLE under Path A with the analogous ORG-INTENT-pattern surface verified against canonical main). The spec is ready for `approved: true` and ELI16 handoff to the user. After approval, `/instar-dev` can proceed on `Slice 1a` (preferences endpoint + session-start hook patch) and `Slice 1b` (the sentinel loop using that surface).
