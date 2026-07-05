# Round 3 findings — nature-axis-routing

## Conformance gate (1)
- GR3-1 [Bounded Notification Surface]: FD6 HIGH notices never coalesce while pool-coalescing deferred → fleet-wide door outage multi-fires HIGH items → FIX: per-machine AGGREGATION (one item enumerating affected gates + common cause). [FIXED — FD6 aggregated-per-machine-per-episode]

## External codex r3 (SERIOUS, RAN)
- CR3-1 SERIOUS: enabled empty-chain fall-through bypasses safety invariant. For a MAPPED critical gate, empty-available → 'fall-through' to legacy category routing, which does NOT respect R-rules/bans/injection/doc-tree-Claude-ban → could route opus-CLI. FIX: mapped critical gate / component-with-static-bans + empty ⇒ FAIL CLOSED (caller gating heuristic) or validated terminal reserve, NEVER legacy fall-through. Keep fall-through ONLY for unmapped/non-benched.
- CR3-2 SERIOUS: injection safety depends on per-call caller honesty (one forgotten callsite enables Groq). FIX: STATIC per-component/per-operation injection-exposure map + exhaustiveness ratchet, default exposed:true (fail-safe), explicit false only for audited-trusted; per-call flag may only TIGHTEN.
- CR3-3: byte-identical claim still too prominent/partly contradicted in FD11 + ELI16. FIX: sweep to carve out the LA4 unconditional clamp everywhere.

## External gemini r3 (MINOR, RAN)
- Ge3-1: justify pi-cli-as-primary over openai-api (subsidy/no-key/bench 100% fastest) + acknowledge bespoke-CLI dependency risk. FIX: 1-2 sentences in FD1.
- Ge3-2: benchmark/model drift could invalidate the harness-penalty premise; S6 reslot reactive → mention a lightweight continuous door-penalty canary (doorway-scan substrate exists). FIX: strengthen Close-the-Loop item 3.

## Internal round 3 (async)
- lessons+security: (pending)
- decision+integration: ONE finding = FD6 within-machine cross-component flood (= GR3-1, already FIXED via aggregation). Confirms all round-2 fixes captured; open questions empty.
- lessons+security: ONE finding — LS3-1 MED FD4/FD6 self-contradiction (ratchet "every crit-gate B/JUDGE" vs FD6-listed nature-A MessageSentinel) → reword ratchet to "no crit-gate resolves chain WRITE" (crit gates are A or B, never D/WRITE). [FIXED]. All round-2 HIGH fixes verified captured.

## ROUND-3 STATUS: fixes applied — FD6 aggregation, empty-set nature-aware fail-closed (CR3-1), static injection-exposure map (CR3-2), byte-identical sweep (CR3-3), pi-cli justification (Ge3-1), drift canary (Ge3-2), FD4-ratchet-never-WRITE (LS3-1). → round 4 convergence check.

## lessons+security r3 (1 finding)
- LS3-1 MED FD4/FD6 self-contradiction: Adv1 ratchet "every crit-gate=B/JUDGE" contradicts FD6 listing nature-A MessageSentinel as crit-gate → reword ratchet to real invariant "no crit-gate resolves chain WRITE" (WRITE = sole Opus-CLI-exempt lane). [FIXED]
- Confirms all 5 round-2 HIGH fixes + migration + CR2 + sec-r2 correctly captured.

## ROUND-3 STATUS: all material (GR3-1 flood, CR3-1 empty-set-fail-closed, CR3-2 static-injection-map, CR3-3 byte-identical-sweep, Ge3-1 pi rationale, Ge3-2 drift-canary, LS3-1 ratchet-contradiction) FIXED. → round 4 convergence check.
