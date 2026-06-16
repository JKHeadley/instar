# Round 2 — Integration / Deployment / Multi-Machine convergence check

Reviewer: integration/deployment + multi-machine. Grounded in `src/commands/server.ts`
(router construction at line **4687**, CartographerSweep auto-vivify at line **11266**),
`src/core/IntelligenceRouter.ts` (swap loop 193–218), `src/scaffold/templates.ts`
(`generateClaudeMd`, "Per-Component Framework Routing" at line 836),
`src/core/PostUpdateMigrator.ts` (`migrateClaudeMd` 3834, `migrateConfig` 7545),
`src/config/ConfigDefaults.ts` (`getMigrationDefaults`/`applyDefaults` 1392/1406),
`src/server/routes.ts` (`GET /intelligence/routing` 7933).

## Verdict on the three convergence questions

### (1) §5 migration — existing-agent awareness path: CONCRETELY CORRECT, with one coherence gap

**SOUND:**
- **Runtime-computed / no persisted block** is correct against the mechanism. `migrateConfig`
  (7545) writes config via `applyDefaults` (only adds MISSING keys, never overwrites). Writing
  no `componentFrameworks` block means existing agents keep `componentFrameworks` undefined and
  the new code computes the effective config at boot — exactly as specified. Confirmed the engine
  honors `undefined ⇒ today's behavior` (IntelligenceRouter `evaluate()` line 161, `resolveConfig`
  returning undefined short-circuits to `defaultProvider`).
- **`migrateClaudeMd` append-with-content-sniff** is the right mechanism and matches every existing
  block in the method (each is `if (!content.includes('<unique marker>')) content += …`).

**[MEDIUM] Awareness migration must NOT sniff on "Per-Component Framework Routing" — that marker
already matches the EXISTING section on every deployed agent.**
- Verified: echo's own live `CLAUDE.md` already carries `## Per-Component Framework Routing`
  (line 860), and `migrateClaudeMd` **only APPENDS, never edits a section in place** (the method's
  own comments at 3853 and 4613 state this explicitly). A content-sniff on the existing heading
  would evaluate true and the migration would do nothing — existing agents would never learn the
  default-on behavior.
- **Worse — the OLD text becomes actively WRONG and stays on disk.** The shipped template section
  states "Routing is **opt-in**; with no config, everything stays on your default framework"
  (templates.ts:836) and "if it's just rate-limited the component falls back to its **heuristic**
  (no herd onto the default)" (templates.ts:839). After this spec ships, BOTH are false for
  sentinel/gate/reflector: routing is default-ON, and a *gating* call now swaps down the active
  chain rather than degrading to heuristic. Existing agents keep the contradictory text.
- **Resolution:** The awareness migration must (a) sniff on a NEW, unique marker (e.g. the literal
  `run off Claude by default` or `INTERNAL_FRAMEWORK_PREFERENCE`), not the old heading, and (b)
  append a corrective subsection that states the new default explicitly AND notes the gating-call
  swap behavior (superseding the old "falls back to its heuristic" line). `generateClaudeMd` for
  NEW agents should EDIT the existing section's opt-in/heuristic sentences so a fresh install isn't
  internally contradictory. Spec §8 should name both halves (new marker for migrate; in-place edit
  of the opt-in + heuristic sentences for generate). The §8 prose "the existing section gains the
  new DEFAULT behavior" is correct for `generateClaudeMd` only — it does not describe a path
  `migrateClaudeMd` can execute as written.

### (2) §5 multi-machine "machine-local BY DESIGN" posture: SOUND AND COMPLETE

The declaration is correct and covers every new surface the spec adds.
- **The computed default is machine-local by construction.** The active-set is computed from
  `buildProvider(fw) !== null` on THIS machine's installed CLIs (§4.2), the resolver runs at THIS
  machine's router-construction site (server.ts:4687), and nothing is persisted to config — so
  there is no replicated/shared artifact through which machine A's provider set could reach machine
  B. The "never a replicated/persisted block ⇒ A can't pin onto B" claim is mechanically exact.
- **`/intelligence/routing` reflection is correctly machine-local.** Verified the route
  (routes.ts:7933) calls `intel.for('__nonexistent__')` and `intel.for(name)`, both of which read
  `this.opts.resolveConfig()` (IntelligenceRouter `for()` line 126) — i.e. the LOCAL machine's
  resolver. Once §4.6 makes that resolver return the computed effective config, the route reflects
  the local machine's resolved routing automatically, with no extra wiring. Sound.
- **No state-sync / replicated-store surface is introduced.** `componentFrameworks` is not in any
  `multiMachine.stateSync.*` store, and the spec adds none — so there is no PII/at-rest or
  conflict-resolution consideration to carry. Complete.
- **One thing to STATE for completeness (not a gap, an explicit note):** the §4.3 "primary is
  boot-computed, restart to re-pick after installing a higher-preference CLI" honesty also applies
  PER-MACHINE — installing Codex on machine B re-picks B's primary at B's next restart only; it
  never reaches A. Add one sentence so the operator isn't surprised that two machines can run
  different primaries simultaneously (this is correct and intended, but should be said).

**Answer: yes — the machine-local posture is sound and complete for every new surface.**

### (3) NEW integration/deployment/rollback issues from the rewrite

**[MEDIUM] §4.5 `intelligence.swapAttemptTimeoutMs` — the spec names a config key but does not
specify (a) how the value reaches the router, nor (b) its default-delivery to existing agents.**
- **Threading gap.** The router reads config ONLY through `resolveConfig: () => config.sessions?.componentFrameworks`
  (server.ts:4693). `swapAttemptTimeoutMs` lives at `intelligence.swapAttemptTimeoutMs` — a
  DIFFERENT config path NOT carried by `componentFrameworks`. The swap loop (IntelligenceRouter.ts
  201–202) currently has no timeout and no access to that value. So §4.5 requires a NEW router
  option (e.g. `resolveSwapTimeoutMs: () => number`, threaded at construction in server.ts:4687,
  read live like `resolveConfig`). The spec must name this wire; "config: `intelligence.swapAttemptTimeoutMs`"
  is under-specified about who reads it.
- **Default-delivery / migration.** Good news: a ConfigDefaults entry and a migration are NOT
  required IF the default is applied **in-code** (`config.intelligence?.swapAttemptTimeoutMs ?? 5000`).
  This is the ESTABLISHED `intelligence.*` precedent — types.ts:2810-2814 documents that
  `intelligence.circuitBreaker` defaults "apply when the section is absent... reaches every existing
  agent on a version bump with zero config migration." The spec implies a default value ("default
  ~gateTimeoutMs, e.g. 5s") which is consistent with in-code defaulting.
- **Resolution:** §4.5 should state explicitly: (i) the timeout is threaded into the router as a
  live-read option at construction (sibling to `resolveConfig`); (ii) the default is applied
  in-code (`?? ~5000`), NO ConfigDefaults entry and NO `migrateConfig` block — matching the
  `circuitBreaker.openMs` pattern, so it reaches existing agents for free. Add a unit test asserting
  the in-code default when `intelligence.swapAttemptTimeoutMs` is absent.

**[MEDIUM] §4.6 "memoized computed config" vs "live-read for the operator's own later edits" — a
genuine tension the spec leaves ambiguous.**
- The operator-override path is live (`resolveConfig` reads the in-memory `config` object every
  call, so an operator edit that mutates it is hot — confirmed at server.ts:4693 + the live-read
  design in IntelligenceRouter.ts:14). But §4.6 says: when the operator did NOT set
  `componentFrameworks`, "pass a `resolveConfig` that returns the **computed effective config
  (memoized)**... This preserves live-read semantics for the operator's own later edits."
- These cannot both hold simultaneously. If the resolver returns a memoized object, an operator who
  STARTED with no config and LATER adds `componentFrameworks` (e.g. via a hot in-memory config
  edit) will be ignored — the memoized computed config keeps winning. The spec needs to pick:
  either (i) the resolver checks `config.sessions.componentFrameworks` FIRST on every call and only
  falls to the memoized computed config when still unset (true live-read; an operator's later add
  wins — preferred and matches the existing live-read contract), or (ii) accept that an
  operator-less-at-boot agent requires a restart to adopt a hand-added config (acceptable but must
  be DOCUMENTED, like the §4.3 primary-re-pick honesty).
- **Resolution:** Specify (i) — the construction-site resolver should be
  `() => config.sessions?.componentFrameworks ?? <memoized computed config>` (the boot snapshot
  decides only WHETHER the computed branch is wired at all; the per-call check decides which wins).
  This keeps the documented live-read contract intact and removes the contradiction. Add a unit
  test: operator-unset-at-boot → adds `componentFrameworks` in-memory → next call honors it.

**[LOW] §4.4 boot-snapshot timing is satisfiable and correctly placed — verified, no change needed.**
- Confirmed the hazard is real and the order makes the fix possible: router construction is at
  server.ts:4687; the CartographerSweep `s.componentFrameworks ??= {}` / `overrides.CartographerSweep`
  auto-vivify is at server.ts:11266 — ~6,500 lines and much later in boot. A snapshot of the RAW
  on-disk operator-set boolean taken at/before line 4687 (the §4.6 site) is therefore guaranteed to
  precede the mutator. §4.4 + §4.6 are sound. (Note for the builder: read the operator-set boolean
  from the file value or a pre-mutation clone, NOT from the live `config` object at a later point.)

**[LOW] Rollback lever `componentFrameworks: {}` — verify it survives the boot-snapshot gate.**
- The §9/§7 rollback is "operator sets `componentFrameworks: {}` (explicit empty)." For this to
  route everything to the agent default, the boot snapshot must classify an explicit `{}` as
  **operator-set** (so the computed default is NOT wired and `{}` passes through). An explicit empty
  object on disk is a deliberate operator act and must read as "operator-set = true." Confirm the
  snapshot's operator-set predicate is "key present on disk" (truthy for `{}`), not "has non-empty
  contents" (which would treat `{}` as unset and re-wire the default, defeating the rollback). The
  §7 unit test should assert the rollback against this exact predicate, not just against the engine.

## Summary
- NEW material findings: **4** (1 MEDIUM awareness-marker, 1 MEDIUM swap-timeout threading/default,
  1 MEDIUM memoize-vs-live-read tension, plus 2 LOW verifications — the LOWs are confirmations with
  small builder notes, counted as 1 material LOW item). Material count for convergence: **4**.
- Multi-machine machine-local posture: **sound and complete**.
- All findings are spec-text precision / wiring-naming gaps with concrete grounded resolutions —
  none reopen a round-1 resolution; none are architecture-level. The design is correct; the spec
  needs to name three wires (awareness marker, swap-timeout option, live-read resolver shape).

**Verdict: needs-changes** (targeted spec-text additions; no redesign).
