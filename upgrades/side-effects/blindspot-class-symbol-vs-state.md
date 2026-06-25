# Side-Effects Review — Verify the State, Not Its Symbol (constitution amendment)

**Change:** Documentation-only. Adds the constitutional standard "Verify the State, Not Its
Symbol" to `docs/STANDARDS-REGISTRY.md` (Substrate section), registers it as **P20** in
`docs/INSTAR-DESIGN-PRINCIPLES-AND-LESSONS.md` (the surface the `/spec-converge` lessons-aware
reviewer loads), re-points L5 to P20 as its parent, updates the Part-4 reviewer range to P1-P20,
and lands the supporting analysis spec + ELI16. **No runtime/`src` surface.** Operator-ratified
(Justin, topic 16566, 2026-06-24) after independent verification that it is a real gap.

1. **Over-block** — None. No code path, gate, or filter changes; nothing new can reject input.
   The only behavioral effect is additive: the spec-converge reviewer gains one more lens (P20)
   to flag a future spec — advisory findings, never a hard block of runtime behavior.
2. **Under-block** — The standard is enforced today only via the lessons-aware reviewer (advisory)
   + the companion code fix (the crystallizing instance). The `no-uncorroborated-symbol-fire` CI
   ratchet that would mechanically catch *new* violating callsites is named as the next enforcement
   surface, not yet built — so a brittle detector added between now and that ratchet relies on the
   reviewer catching it. Stated honestly in the standard's "Applied through", not hidden.
3. **Level-of-abstraction fit** — Correct layer. It is a Substrate (model-level truth) standard, a
   parent of the existing L5 lesson and the AUP-wedge note; placed beside its siblings
   (No Silent Degradation, Distrust Temporary Success) and registered in the same P-catalog the
   reviewer already consumes. No new abstraction invented.
4. **Signal vs authority (P2)** — Compliant and explicitly differentiated: the standard's text
   states it is *orthogonal* to Signal-vs-Authority (which governs who may BLOCK) — it governs the
   *evidentiary correctness* a detector must have whether it is a signal-emitter or a gate. The
   amendment itself holds no authority; it is documentation feeding an advisory reviewer.
5. **Interactions** — Touches the shared P-catalog: P18/P19 already existed, so the new entry is
   **P20** (verified free) and the Part-4 range bumped P1-P19 → P1-P20. L5 gains a parent pointer.
   No collision with the unrelated registry "No Unbounded Loops" P19 reference (left intact). No
   migration surface (these docs are not agent-installed files; Migration Parity N/A).
6. **External surfaces** — None. Internal developer-facing docs only; no user/agent/API surface,
   no template (`generateClaudeMd`) change, no config, no hook.
7. **Multi-machine posture** — N/A (documentation). The standard it describes is, for detectors,
   machine-local-by-design (each machine verifies its own sessions) — captured in the companion
   fix's own side-effects review, not here.
8. **Rollback cost** — Trivial: revert the doc commit. No data, no state, no deployed behavior to
   unwind. The companion code fix ships and rolls back independently on its own branch.

**Second-pass review:** Not required — documentation-only, no block/allow decision, no session
lifecycle, no gate/sentinel/watchdog code. (The companion CODE fix
`ratelimit-sentinel-false-positive-hardening`, which DOES touch sentinels, carries its own
mandatory Phase-5 second-pass on its own branch.)
