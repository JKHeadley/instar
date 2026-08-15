# Side-Effects Review — WriteAdmission is given its own machine nickname

**Version / slug:** `write-admission-self-nickname`
**Date:** `2026-08-15`
**Author:** `echo`
**Second-pass reviewer:** `not required — Tier 1. A 13-line addition supplying an OPTIONAL, already-declared, already-consumed dependency at the single construction site. No decision logic added; every failure path degrades to the value the field already had (null).`

## Summary of the change

`WriteAdmission` renders its status as
`thisMachine: { machineId, nickname: this.d.selfNickname?.() ?? null }` — so a
write refusal can name WHICH machine owns the state. The `selfNickname` dep was
**declared** (`src/core/WriteAdmission.ts:169`) and **consumed** (`:403`) and
**supplied nowhere**, so every machine reported `nickname: null` and could not
name itself.

Measured, each with a control:

| probe | result |
|---|---|
| `selfNickname` supplied at the construction site | **0** |
| CONTROL — `thisMachineId` supplied there | 1 |
| the component IS constructed (dev-gated + dry-run, but live) | `server.ts:24595` |

Wired with the module-scope `_listPoolMachines` accessor the file already uses to
map machineId → nickname.

## The mistake in the investigation, which shaped the test

**My first search for the construction site returned ZERO** — `grep 'new
WriteAdmission'` — and I was one step from concluding the component is never
instantiated and the finding was moot. It is constructed as
**`new waMod.WriteAdmission({`**, through a dynamic-import namespace.

A bare-identifier scan that misses the namespace-qualified form is the EXACT
defect class fixed in three lints tonight (#1886, #1887, #1889/#1890) — committed
by me, in the act of auditing for it, and the second time tonight (a peer caught
the first, in my own invariant test in #1872).

So the guard here matches `new [ns.]WriteAdmission(` and **pins that behaviour
with its own tests**, rather than trusting the spelling that happens to be in the
tree today.

## Decision-point inventory

- `selfNickname` supplied at `server.ts:24595` — ADD (13 lines incl. comment).
- `tests/unit/write-admission-self-nickname.test.ts` — ADD, with an exported
  `findWriteAdmissionConstructions` scanner.
- `WriteAdmission.ts` — UNCHANGED. The dep, its optionality, the `?? null`
  fallback and the status shape are all untouched.
- No runtime block/allow decision added or modified.

## 1. Over-block

**Structurally impossible to make anything worse, and that is the whole safety
argument.** Both failure paths produce `null`, which is exactly the value the
field already carried:

- `_listPoolMachines` is declared `null` at module scope and assigned inside a
  conditional block, so it may legitimately be unset → `?.()` → `[]` → `null`.
- A machine absent from the pool capacities has no nickname → `?? null`.

So the change can only ever ADD a name. It cannot produce a wrong one and cannot
throw. `waMachineId` itself may be null; that branch returns null explicitly.

## 2. Under-block

**Declared rather than implied:** a canonical `resolveSelfNickname`
(`src/core/SelfNicknameResolver.ts`) additionally supports a *derive* fallback for
a machine that appears in no capacity list. I did NOT use it here: it is only
dynamically imported inside another block of `server.ts`, and a differently-scoped
local function of the same name exists at `:23987`. Changing imports in a
24,000-line composition root, around a shadowed identifier, is real risk for a
display field. **Consequence: a machine genuinely unknown to the pool still shows
`null`, exactly as today.**

Also unaddressed: `nicknameOf` on other components, and the peer audit's remaining
optional-dep findings.

## 3. Level-of-abstraction fit

The composition root is where dependencies are supplied; that is the only place
this could go. `WriteAdmission` itself is untouched, which is correct — it already
asks for the value properly.

## 4. Signal vs authority compliance

No authority change whatsoever. `selfNickname` feeds a STATUS field only; it
participates in no admit/refuse decision. WriteAdmission's dry-run posture, its
domain registry and its refusal logic are untouched.

## 5. Interactions

- `machinePoolRegistry` / `_listPoolMachines` are read-only here.
- The lookup runs per status call, not on a hot path.
- Real typecheck (`node node_modules/typescript/bin/tsc --noEmit`) exit 0.
  **Noted because `npx tsc` here is intercepted by a shim that prints
  "This is not the tsc command you are looking for" and EXITS 0 WITHOUT
  TYPECHECKING** — a plausible success from a command that never ran. The real
  binary is the measurement.
- No config key, route, or state file touched.

## 6. External surfaces

The `/write-admission` status surface gains a populated `thisMachine.nickname`
where it previously always reported null. That surface is dev-gated and dry-run,
so fleet behaviour is unchanged. No new capability, no new endpoint — the Agent
Awareness Standard needs no template change for a field that was already
documented as present.

## 7. Multi-machine posture (Cross-Machine Coherence)

**Machine-local by design, and correct — this is the multi-machine feature naming
ITSELF.** The value is deliberately *this* machine's own nickname, resolved from
its own view of the pool registry; it is not replicated, not merged on read, and
not authoritative about any peer. Each machine answers for itself, which is the
right posture: a machine asserting a peer's nickname from its own state would be
the coherence bug, not the fix.

Nothing durable is written, so nothing can strand on a topic transfer.

## 8. Rollback cost

`git revert` of one 13-line addition plus the test file. No migration, no state,
no deployed artifact. Reverting restores `null`, the pre-change value.

## Conclusion

Ship. A declared-and-consumed dependency is supplied at its only construction
site, both failure paths degrade to today's exact value, and the wiring is pinned
by a guard whose scanner is deliberately built to catch the spelling that fooled
my own investigation.

## Evidence pointers

- `tests/unit/write-admission-self-nickname.test.ts` — **10/10 green**.
- **Negative control: 1 of 10 fails** against the unwired tree, naming
  `server.ts:24595` and the consequence. The other 9 pass **both ways** — one
  proving the scan finds a construction at all (an anti-vacuity control: "every
  site supplies it" is trivially true of zero sites), plus scanner pins for the
  namespace-qualified, bare and deeply-qualified forms, and negative pins for a
  similarly-named class, a plain import, and a type reference. `server.ts`
  restored **byte-exact** after the control (sha match).
- Real `tsc --noEmit` exit 0 (via the real binary — see §5).
- Tier **1**: `classifyTier` reports riskFloor 1 **and suggested tier 1** — the
  size heuristic agrees this time, so there is no under-declaration question.
  Directional controls: `SessionReaper.ts` and `SecretStore.ts` both floor 2.
