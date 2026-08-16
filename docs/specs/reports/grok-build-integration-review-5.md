# External cross-model reviews — rounds 10 and 11 (codex-cli:gpt-5.5)

Spec: docs/specs/grok-build-framework-integration.md

## Round 10 — verdict: SERIOUS ISSUES

Disposition: findings 1, 2 and 5 were verbatim re-arguments of decided points
(drift warn-vs-fail-closed, budget-ledger races, structure/archaeology — all
dispositioned in review-3). Finding 3 (economics framing) was folded into §0.3.
Finding 4 was a NEW and correct catch about how §4.3 READ: the session lanes do
not "merely scrub env keys" — they FORCE the vendor kill switch, which is the
same control §3.1.1 relies on. §4.3 was rewritten to say so, and to name the
narrower real divergence (the adapter lane additionally VERIFIES the on-disk
policy and refuses; the session lanes force-and-proceed), with the preflight
hardening tracked.

**Verdict: SERIOUS ISSUES**

1. **Session lanes weaken the billing gate (§3.1.1, §4.3).**  
   The spec says the adapter relies on vendor `disable_api_key_auth` to close credential locations it cannot enumerate. But §4.3 says interactive/headless session lanes merely scrub env keys and proceed. Scrubbing does not cover config/keychain credentials, the exact gap §3.1.1 identifies.  
   **Resolution:** require the same verified login-policy preflight for all Grok spawns, including tmux/headless sessions; scrub-env can remain, but cannot replace policy verification.

2. **The spec is overfit to review-round archaeology (§2, §4, §8, §11).**  
   Many sections embed prior findings, “round-N” corrections, and implementation-status claims inline with normative requirements. This makes the design hard to audit: a builder must distinguish history, evidence, current requirements, and shipped status in long paragraphs.  
   **Resolution:** split into: normative contract, evidence appendix, implementation status, and resolved-review log. Keep only current MUST/SHOULD requirements in the main path.

3. **No clear abstraction boundary for “Grok reviewer” vs “Grok framework” (§6–§8, §14).**  
   The source says internal routing is fully excluded, reviewer direct-construction is live, sessions are dark/gated, and quota semantics differ per consumer. That is defensible, but the spec still frames this as a fifth framework, which invites future callers to assume framework-wide availability.  
   **Resolution:** define an explicit capability matrix/type boundary: `grok-build:reviewer-one-shot` live; `grok-build:sessions` gated; `grok-build:internal-routing` unsupported. Make consumers bind to capabilities, not framework id alone.

4. **Industry pattern gap: local JSON ledger as budget brake (§8, Multi-machine posture).**  
   The spec acknowledges check-then-act races, lost increments, and per-machine ceilings against one invisible shared pool. This is acceptable for dark reviewer use, but it is not a durable budget architecture.  
   **Resolution:** mark the local ledger as a temporary circuit breaker, not accounting. Before second machine or broader use, require a shared transactional store or append-only event log with idempotent run ids.

5. **Warn-only CLI drift is reasonable, but tool-deny safety remains brittle (§4.1, §9).**  
   The spec says unknown vendor tools widen surface until re-pinned. Scratch cwd helps, but this is still an enumerated-deny-list design.  
   **Resolution:** prefer a vendor “no tools”/allowlist mode if available; otherwise make version-drift warnings operationally visible in reviewer reports, not only logs.

---

## Round 11 — verdict: MINOR ISSUES

Verdict improved from SERIOUS ISSUES to MINOR ISSUES. Disposition: all five
folded rather than argued. (1) scope clarity + (5) normative-vs-history
readability produced a new "Current normative contract" section at the top of
the spec — the structure complaint had recurred in four rounds and answering it
constructively beat re-litigating the §0 convention a fifth time. (2) §0.5's
"cost profile" language was tightened to "locally token-bounded and valued
conservatively at public list rates", since only TOKEN spend is bounded and the
billing sink remains unproven. (3) the one-OS-user / no-parallel-reviewer-
orchestration launch invariants are now stated explicitly in that same section.
(4) the session lanes are now explicitly declared unacceptable for
cost-sensitive automated work until the on-disk policy preflight lands.

**Verdict: MINOR ISSUES**

1. **Scope clarity conflict (§1, §4.3, §7, §14).**  
   The spec says it adds `grok-build` as a fifth framework and lists broad session/routing/threading work, but the only live lane is the adapter one-shot reviewer path. Interactive sessions refuse unless doubly opted in, headless jobs refuse, ACP is undeclared, and internal routing is totally excluded. Resolution: retitle or front-load the phase boundary as “one-shot reviewer integration first; framework identity threaded for future lanes” so implementers do not infer full framework parity.

2. **Economics language still overclaims (§0.5, §13).**  
   The source correctly says the billing sink is unknown and “no observable cost” is instrument-limited. But §0.5 says the CLI path has an “unproven-but-bounded cost profile” that beats API billing. The token ceiling is bounded; the billing sink is not proven. Resolution: say “locally token-bounded and valued conservatively at public list rates,” not “cost profile,” until invoice or billing-side proof exists.

3. **Local JSON budget is acceptable only because the lane is narrow (§8).**  
   The spec honestly labels the reviewer ledger a circuit breaker, not accounting, and names last-writer-wins loss. From an outside systems perspective, this is the most likely failure mode if usage grows: multiple convergence processes or agents under separate OS users bypass the intended account-level cap. Resolution: make “no parallel reviewer orchestration / one OS user per host” an explicit launch invariant, or move earlier to append-only run records with idempotent run IDs.

4. **Session-lane billing policy divergence needs a stronger warning (§4.3, §3.1.1).**  
   The spec says adapter lanes verify-and-refuse, while session lanes force the vendor switch and scrub env but proceed without policy preflight. That may be reasonable for interactive work, but it is a weaker invariant than the reviewer path. Resolution: state that session lanes are not acceptable for cost-sensitive automated work until the on-disk policy preflight lands.

5. **Readability issue: convergence history obscures normative requirements throughout.**  
   Sections like §2.0, §4.1, §8, and §11 contain many round-by-round corrections. The audit trail is valuable, but it makes the final design hard to extract. Resolution: add a short “Current Normative Contract” summary near the top, with history moved to appendix or collapsed notes.
