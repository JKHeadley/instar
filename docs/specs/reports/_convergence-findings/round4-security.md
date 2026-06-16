# Round 4 — Security lens (FINAL convergence check on round-3 fixes)

Scope: verify ONLY that the round-3 fixes (§4.5 Promise.race + providers' timeoutMs→SIGTERM,
dropped AbortSignal; §4.6 live-read + layered computed-default) are SOUND and introduce NO new
security issue. Code-grounded against the live tree.

## §4.5 — Promise.race (crash-safe) + timeoutMs→SIGTERM, AbortSignal dropped → SOUND

- **Promise.race form is the shipped precedent.** `InputGuard.ts:320` uses exactly
  `await Promise.race([intelligence.evaluate(...), new Promise((_,reject)=>setTimeout(reject))])`.
  Node attaches a settlement handler to each racer, so a late REJECT from the abandoned attempt is
  handled by the race (NOT an unhandledRejection) and a late RESOLVE is ignored. No crash hazard —
  the round-3 correction (drop the manual `.catch`/`unref`/`AbortSignal`) is grounded.
- **AbortSignal correctly dropped — it has no receiver.** `IntelligenceOptions` (types.ts:847-880)
  has `timeoutMs` (855) but NO `signal`/`AbortSignal` field. The round-2 AbortSignal prescription
  would have been dead code; removing it is correct.
- **timeoutMs→SIGTERM holds across all 4 CLI providers.** Each honors `options?.timeoutMs`
  (Codex CliProvider:365 + Claude:70 via `execFile`'s `timeout:`; Gemini:102 + Pi:92 via a helper
  taking `timeoutMs`). For the `execFile` path, Node's `timeout` option kills the child with the
  default `killSignal` = **SIGTERM** — so passing the per-attempt cap as `timeoutMs` makes the
  subprocess self-terminate at the cap. The cap and the subprocess kill are the same bound, as
  claimed. Fail-open per-attempt; never weakens the fail-closed-when-all-down guarantee
  (IntelligenceRouter.ts:196 re-throw is untouched).

## §4.6 — live-read + layered computed-default does NOT re-open the §4.4 ordering concern → SOUND

The boot-snapshot (§4.4) and the runtime layering (§4.6) are cleanly separated and operate on
disjoint config slots — verified end to end:

- **Default-vs-operator is frozen at boot, BEFORE the only runtime mutator.** Router construction
  is `src/commands/server.ts:~4687`; CartographerSweep's auto-vivify of
  `config.sessions.componentFrameworks.overrides.CartographerSweep` is `server.ts:11268` — provably
  later. So CartographerSweep's mutation can NEVER make the boot snapshot read "operator-set". The
  §4.4 ordering contract is real and mutation-proof.
- **§4.6 layering runs ONLY in the default case and touches DISJOINT slots.** The computed default
  writes `categories.{sentinel,gate,reflector}` + `failureSwap` (§4.2) — never `overrides`, never
  `categories.job`. CartographerSweep writes ONLY `overrides.CartographerSweep`
  (`CartographerSweepEngine.resolveSweepFrameworkRouting`, lines 73-78). Disjoint ⇒ layering the
  computed default UNDER the live override is contention-free; the sweep's override survives.
- **Router resolution order is overrides > categories > default** (IntelligenceRouter config shape,
  lines 37-41), so even in the impossible case of an overlapping slot, the live
  `overrides.CartographerSweep` wins for its own component. The §4.6 "live override wins for its
  slot" guarantee holds doubly.
- **The layering reads NOTHING about operator-set-ness.** §4.6 only branches on the already-frozen
  boot snapshot; it never re-derives default-vs-operator from the live object. So a
  CartographerSweep auto-vivify cannot masquerade as an operator override. The concern is NOT
  re-opened.

## Coherence of the two fixes together
The fixes are independent and mutually consistent: §4.5 bounds latency via a per-attempt cap that
also kills the subprocess (no orphan, no crash); §4.6 preserves the cross-feature CartographerSweep
override while still defaulting unset slots off Claude — without disturbing the §4.4 boot-snapshot
authority. No new security surface is introduced; no fail-open/fail-closed property is weakened.

## Non-blocking precision notes (NOT findings, NOT new material)
- Spec prose "all four CLI providers already `execFile` with a `timeoutMs`" is slightly imprecise:
  Gemini/Pi pass `timeoutMs` to a helper rather than literally calling `execFile`. The honored-cap
  + SIGTERM guarantee still holds. Cosmetic wording only.
- `resolveConfig` today returns the object by reference (server.ts:4693); §4.6 correctly replaces
  it with the live-read+layer logic. Accounted for.

## Verdict
CONVERGED. Round-3 fixes are code-grounded and sound; no new security issue; the §4.4 ordering
contract is not re-opened by §4.6.
