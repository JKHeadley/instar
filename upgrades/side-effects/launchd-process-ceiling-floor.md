# Side-Effects Review — Launchd process ceiling floor + live-ceiling reporting

**Version / slug:** `launchd-process-ceiling-floor`
**Date:** `2026-08-19`
**Author:** `Echo (instar-dev agent)`
**Second-pass reviewer:** `cross-model codex-cli:gpt-5.5 (10 rounds) + Standards-Conformance Gate`

## Summary of the change

Two halves. (1) The launchd `NumberOfProcesses` belt moves 512 → 2048, because it mapped to
`RLIMIT_NPROC` — a PER-UID limit — and so sat below a normal desktop's idle process floor,
refusing `fork()` on an idle machine and eventually killing the agent server. Raise-only on
BOTH write paths (`installAutoStart` regenerates the plist; `migrateLaunchdProcessCeiling`
reaches deployed agents). (2) A boot check reads the LIVE `RLIMIT_NPROC` and raises one
deduped Attention item when a machine is running an unsafe ceiling or would be after its next
restart — because the plist is a symbol and the running process is the state.

Files: `src/commands/setup.ts`, `src/core/PostUpdateMigrator.ts`, `src/core/ProcessCeilingCheck.ts`
(new), `src/server/AgentServer.ts` (boot wiring), plus two unit suites (55 tests).

## Decision-point inventory

- `installAutoStart` plist write — **modify** — now raise-only via `preserveHigherProcessCeiling`.
- `PostUpdateMigrator.migrateLaunchdProcessCeiling` — **add** — raise-only, floor-gated,
  idempotent, surgical, non-reloading.
- `ProcessCeilingCheck.evaluateProcessCeiling` — **add** — five enumerable verdicts; the only
  output is whether to raise a notice.

---

## 1. Over-block

No block/allow surface — over-block not applicable. Nothing here refuses a request, a
message, a spawn, or a session.

The nearest analogue is a FALSE NOTICE: telling an operator a machine needs attention when it
does not. Every uncertain branch is silent by construction (`unknown` when the live reading is
unreadable; `ok` when both the reading and the plist are at or above the floor), so a false
notice requires the OS to misreport its own limit. The cost if it happened is one wrong
Attention row, which the operator resolves — never an outage.

---

## 2. Under-block

No block/allow surface — under-block not applicable.

The genuine detection gap, stated because it is real: the check verifies the LIMIT, not the
HEADROOM. A machine at 1900 of 2048 reports `ok`. Counting the UID's processes requires
spawning one — the exact operation that fails when the limit is exhausted — so a fork-based
headroom probe would go silent precisely when it mattered and reassuring otherwise. Tracked
as CMT-015 and made blocking on any future change to the ceiling value.

Second gap: an unreadable live limit yields `unknown` and no Attention item. Deliberate (a
guess in either direction is worse than none), but it is always LOGGED on darwin, so a reader
that broke could not silently disable the check fleet-wide.

---

## 3. Level-of-abstraction fit

Correct layer, and the review moved it there.

The ceiling belongs in the launchd plist — it is an OS resource limit and there is no
per-job or per-process-tree alternative on macOS (no `pids.max` equivalent reachable from a
plist). The migration belongs in `PostUpdateMigrator` per Migration Parity; the template
belongs in `setup`. Both were needed: `setup` REGENERATES the plist, so raise-only had to
exist on that path too — a spec-review finding, not something the original design covered.

The boot check is deliberately at the server boot rather than inside the migration: the
migration writes a file and cannot observe the process that will later inherit it, so a check
living there could only re-read its own output. Reading the live limit at boot is the only
place the state is observable.

---

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [x] No — this change produces a signal consumed by an existing smart gate.

`ProcessCeilingCheck` raises an Attention item and does nothing else. It never restarts the
agent, never invokes `launchctl`, never refuses a boot, never gates work. The Attention queue
(with its existing routing, dedupe, and flood ceilings) is the consumer. A wrong reading costs
one wrong notice; it can never cost an outage. This is the correct shape for a check whose
whole job is to report that a limit is wrong.

The migration writes a file and is not an authority over any runtime decision. It is
raise-only by a strict `<` comparison, so it cannot override an operator's judgement in the
one direction that would matter.

---

## 4b. Judgment-point check (Judgment Within Floors standard)

No new static heuristic at a competing-signals decision point. All three decision points are
classified `invariant` in the spec, and the reasoning is the same in each: an enumerable
answer space from bounded inputs. The boot check takes two inputs but they answer two
different, non-competing questions (safe now / safe after the next restart), so the result is
a lookup rather than a weighing. No floor or arbiter is declared because there is nothing to
arbitrate.

---

## 5. Interactions

- **Shadowing:** the boot check runs alongside the migration but reads a different thing (live
  process vs file), so neither shadows the other. Within the check, the `future-repair` branch
  is deliberately evaluated before `ok` so a safe-but-misconfigured machine is not swallowed.
- **Double-fire:** the `repair` state exists precisely to avoid two voices for one condition —
  a machine whose migration never ran is reported by the check, and the migration's own result
  reports its failure to the log. They describe the same underlying fault, but only the check
  reaches the operator, and it says the correct action for it (look at it, do not restart).
- **Races:** none introduced. `readEffectiveProcessCeiling` reads the process's own report;
  `evaluateProcessCeiling` is pure; the plist read is a single synchronous read. The check
  spawns nothing — deliberately, since the failure it detects is an inability to spawn.
- **Feedback loops:** none. The check cannot change the limit it reads.

Interaction worth naming: the migration deliberately does NOT reload launchd. That is what
creates the symbol/state divergence this check reports — the two halves are a matched pair,
and removing either leaves the other incoherent (a reload would restart a running agent
mid-update; a migration with no check leaves the divergence silent).

---

## 6. External surfaces

- **Other agents on the same machine:** the ceiling is per-UID, so raising it affects every
  process of that user — in the permissive direction only.
- **Other users of the install base:** deployed agents receive the migration on update and the
  check at the next boot. A macOS agent gets at most one Attention item; a non-darwin agent is
  a strict no-op.
- **External systems:** none. No network call, no third-party binary. The check does not even
  exec.
- **Persistent state:** one integer in the machine's own launchd plist, with a timestamped
  backup written before the edit. No schema, no database, no migration to reverse.
- **Timing / runtime conditions:** improves them — the whole point is removing a limit that
  refused `fork()` at rest.
- **Operator surface (Mobile-Complete Operator Actions):** the notices are phone-complete by
  construction. The `raise` action is "restart this machine", which needs no terminal; the
  `repair` and `future-repair` notices report a condition and ask for no command. All three
  are asserted by test to contain no path, command, or config key. The rare
  raise-above-2048 escape path IS terminal work, and is deliberately kept out of the notices
  (documented in the spec instead) — handing plist surgery to an operator who needs a restart
  would be worse guidance, not better reach.

---

## 6b. Operator-surface quality (Operator-Surface Quality standard)

No dashboard renderer, markup file, approval page, or grant/revoke/secret-drop form is
staged — the gate's trigger does not fire. The operator-facing output is Attention item text,
reviewed against the same spirit:

1. **Leads with the primary action** — each title states the machine and what is needed
   ("needs one restart", "a restart will not fix it", "a restart may lose that").
2. **Zero raw internals** — no fingerprints, no paths, no key names; the two numbers shown are
   process counts, which are the substance.
3. **Destructive actions de-emphasized** — none offered.
4. **Plain language** — asserted by test: each notice is checked to contain none of
   `launchctl`, `ulimit`, `NumberOfProcesses`, `.plist`, a home path, or `sudo`.

---

## 7. Multi-machine posture (Cross-Machine Coherence)

**`unified` for the shipped value; `machine-local` for the effective reading**
(`machine-local-justification: hardware-bound-resource`).

The ceiling and both write paths are unified — the same code writes the same floor on every
machine. The live reading is machine-local because `RLIMIT_NPROC` is a kernel limit on one
host's running process; a peer's reading cannot answer "is THIS machine's limit raised yet?",
and replicating it would let a healthy peer mask an unhealthy machine.

- **User-facing notices:** one per machine, per-machine BY NECESSITY — each machine needs its
  own physical restart, so one-voice gating ACROSS machines would suppress a second machine's
  genuine need. Bounded three ways: deduped per machine, self-extinguishing (the condition
  ends when the restart happens), and riding the existing single-hub Attention routing rather
  than creating topics. A cross-machine summary was rejected because it would have to be
  raised by one machine on behalf of others using a reading it cannot have — and would omit
  the machine most likely to be down, which is the one crashing on this bug.
- **Durable state on topic transfer:** none held; nothing strands.
- **Generated URLs:** none.

The dedupe key mixes the host fingerprint with the machine id, so an id collision costs a
duplicate notice rather than swallowing the HIGH notice for a crashing machine.

---

## 8. Rollback cost

- **Hot-fix release:** revert and ship a patch. Pure code change.
- **Data migration:** none. An already-migrated plist keeps 2048, which is harmless within the
  supported-host envelope (roughly a fifth of `kern.maxprocperuid`); the timestamped backup of
  the original is on disk beside it.
- **Agent state repair:** none. The Attention items are ordinary rows the operator resolves.
- **User visibility:** reverting restores the previous behaviour — a silent restart
  requirement — which is the pre-change state, not a new regression.

---

## Conclusion

The review changed this substantially, and that is the honest headline. It began as a
one-integer change justified partly by a claim that was arithmetically false, treating a
corrected file as a corrected machine. Ten rounds of cross-model review plus the
Standards-Conformance Gate produced six findings that changed CODE — the symbol/state gap, two
missing verdict states, the setup clobber path, and a machine-id collision that could have
swallowed a crashing machine's notice — and roughly a dozen more that corrected claims in the
document. The Standards gate reached zero findings at round 3 and stayed there.

It did NOT converge: the two-consecutive-clean-rounds criterion was never met, the 10-round
cap fired, and the operator approved at the cap after reading the report that says so. That
distinction is preserved in the spec frontmatter rather than smoothed over.

Clear to ship on that basis.

---

## Second-pass review (if required)

**Reviewer:** cross-model `codex-cli:gpt-5.5`, 10 independent rounds
**Independent read: concur, with the residual risk named**

Round 10's closing assessment: *"the design is clear and appropriately narrows the belt's
role. The main residual risk is not conceptual; it is that the static default plus no headroom
probe can still fail silently on unusually busy hosts."* That risk is recorded in the spec, in
the release notes, and as CMT-015, and it is made blocking on any future change to the ceiling
value.

Disclosure on independence: the internal reviewer perspectives were carried by the authoring
session rather than by spawned subagents, under a session instruction not to spawn agents
without a request. The genuinely independent reads here are the cross-model pass and the
code-backed Standards gate — both ran every applicable round and produced every finding above.

---

## Evidence pointers

- `tests/unit/launchd-process-ceiling.test.ts` — 24 tests: raise-from-512, floor-gating,
  idempotency, surgical edit, no-reload, setup-path raise-only, and every plist form the
  change claims to no-op on.
- `tests/unit/process-ceiling-check.test.ts` — 31 tests: the live-process reading, all five
  verdicts, silence on every uncertain branch, dedupe behaviour, and the notice text for each
  state including the no-terminal-work assertions.
- Local run 2026-08-19: 55 tests, 0 failures.
- Field evidence: 531 uid processes against the 512 ceiling on a Mac Studio; server death on
  `spawnSync ssh-keygen EAGAIN`; ceiling confirmed 512 → 2048 against the LIVE process after
  restart, with the full suite (49,478 cases) then running to completion where it had
  previously taken the machine down.
- Convergence report: `docs/specs/reports/launchd-process-ceiling-floor-convergence.md`.
