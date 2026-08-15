# Side-Effects Review — WriteAdmission can name the OWNING machine in a refusal

**Version / slug:** `write-admission-owner-nickname`
**Date:** `2026-08-15`
**Author:** `echo`
**Second-pass reviewer:** `not required — Tier 1. A 2-line addition supplying an OPTIONAL, already-declared, already-consumed dependency at the single construction site. No decision logic; both failure paths degrade to null, which is the value the message already fell back on.`

## Summary of the change

`WriteAdmission.refusal()` builds:

```
`This write belongs to ${ownerNick ? `'${ownerNick}'` : `machine ${ownerId}`} — re-send it there.`
```

`nicknameOf` was **declared** (`WriteAdmission.ts:168`), **consumed** (`:370`, producing `ownerNick`)
and **supplied nowhere** — so `ownerNick` was ALWAYS null and **every refusal took the raw-hex
branch**. The readable branch was unreachable.

Measured with controls: `nicknameOf` at the construction site = **0**; CONTROL `selfNickname` (wired
in the immediately preceding change) = **1**.

**This is the more consequential half of the same gap.** The previous change let a machine name
ITSELF; this one lets it name the OTHER machine — which is the entire purpose of a refusal that tells
you where to re-send.

## Where it came from

**From my own class-closure note.** The `write-admission-self-nickname` side-effects doc names
`nicknameOf` as not addressed. Following that written record produced this fix — the fourth time this
window a fix came from a declaration of what the previous one did NOT close.

## Decision-point inventory

- `nicknameOf` supplied at `server.ts` construction site — ADD (2 lines + comment).
- `tests/unit/write-admission-self-nickname.test.ts` — one assertion added per construction site.
- `WriteAdmission.ts` — UNCHANGED. The dep, its optionality, the `?? null` fallback and the message
  shape are untouched.
- No runtime block/allow decision added or modified.

## 1. Over-block

**Structurally cannot regress.** Both failure paths yield `null`, which is what `ownerNick` already
was in every case:
- `_listPoolMachines` is declared null at module scope and assigned inside a conditional block;
- a machine absent from the pool capacities has no nickname.

So the change can only replace hex with a name. It cannot produce a wrong name and cannot throw. Same
source and same null-safety as the `selfNickname` line directly above it, deliberately — mixed sources
in one options object would be the drift worth avoiding.

## 2. Under-block

A machine genuinely unknown to the pool still shows the raw id, exactly as today. The canonical
`resolveSelfNickname` (with its derive fallback) is still not used here, for the reason recorded in the
previous change: it is dynamically imported inside another block and a differently-scoped local of the
same name exists at `:23987`.

## 3. Level-of-abstraction fit

The composition root is where dependencies are supplied. `WriteAdmission` already asks correctly.

## 4. Signal vs authority compliance

No authority change. `nicknameOf` affects only the human-readable HINT on a refusal that has already
been decided; it participates in no admit/refuse decision.

## 5. Interactions

- `_listPoolMachines` is read-only here; the lookup runs per refusal, not on a hot path.
- Real `tsc --noEmit` exit 0 (via `node node_modules/typescript/bin/tsc` — `npx tsc` here is
  intercepted by a shim that exits 0 WITHOUT typechecking).
- No config key, route, or state file touched.

## 6. External surfaces

A write refusal now names the owning machine by nickname where it previously printed a raw machine id.
That surface is dev-gated and dry-run, so fleet behaviour is unchanged. No new capability.

## 7. Multi-machine posture (Cross-Machine Coherence)

**Correct by construction, and this is the multi-machine feature naming its PEER.** The nickname is
resolved from THIS machine's own view of the pool registry — the same view the pool surfaces already
use. It is advisory text on a refusal, never authoritative about the peer, and nothing durable is
written, so nothing can strand on a topic transfer.

## 8. Rollback cost

`git revert` of a 2-line addition plus one test assertion. Reverting restores the raw-id fallback.

## Evidence pointers

- `tests/unit/write-admission-self-nickname.test.ts` — **11/11 green**.
- **Negative control: 1 of 11 fails** against the unwired tree, naming `server.ts:24595` and the
  consequence. The other 10 pass both ways, including the anti-vacuity control.
- `server.ts` restored **byte-exact** after the control (sha match).
- Real `tsc --noEmit` exit 0.
- Tier **1**: 2 added lines in one in-scope file, no authority, no capability.
