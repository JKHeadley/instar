# Upgrade Guide — vNEXT

<!-- assembled-by: assemble-next-md -->
<!-- bump: patch -->

## What Changed

`WriteAdmission` renders its status as
`thisMachine: { machineId, nickname: this.d.selfNickname?.() ?? null }` — so a write
refusal can name WHICH machine owns the state. The `selfNickname` dep was **declared**
(`WriteAdmission.ts:169`), **consumed** (`:403`), and **supplied nowhere**, so every
machine reported `nickname: null` and could not name itself.

Measured with controls: `selfNickname` supplied at the construction site = **0**;
CONTROL `thisMachineId` = 1; the component IS constructed at `server.ts:24595`.

Wired using the module-scope `_listPoolMachines` accessor the file already uses to map
machineId → nickname. **Both failure paths degrade to `null`** — the accessor is assigned
inside a conditional block and may be unset, and a machine absent from the pool has no
nickname — which is exactly the value the field carried before. So the change can only
ADD a name; it cannot produce a wrong one and cannot throw.

**Declared open:** a canonical `resolveSelfNickname` also supports a *derive* fallback for
a machine in no capacity list. Not used here — it is dynamically imported inside another
block and a differently-scoped local of the same name exists at `:23987`; changing imports
in a 24,000-line composition root around a shadowed identifier is real risk for a display
field. A machine genuinely unknown to the pool still shows `null`, as today.

## What to Tell Your User

When your agent runs on more than one machine, only one owns a given piece of state at a
time, and the others refuse to write it. The status page for that mechanism is supposed to
tell you which machine you are looking at — by nickname, like "the Mac Mini", because the
underlying id is a meaningless string of hex.

That nickname was always blank. Every machine, every time. The page asked for it correctly;
the code that assembles the component just never handed it one.

Nothing was ever mis-refused and no wrong machine was ever named — a piece of information
that was meant to be there simply wasn't. It is there now. If your agent runs on one machine
this changes nothing you would notice.

## Summary of New Capabilities

None. No new command, endpoint, setting or behaviour — a status field that was always blank
now shows the machine's nickname.

## Evidence

- `tests/unit/write-admission-self-nickname.test.ts` — 10/10 green.
- **Negative control: 1 of 10 fails** against the unwired tree, naming `server.ts:24595`
  and its consequence. The other 9 pass both ways, including an anti-vacuity control
  proving the scan finds a construction at all — "every site supplies it" is trivially
  true of zero sites.
- The scanner matches `new [namespace.]WriteAdmission(` **by design**: my own first search
  used the bare form, returned zero, and nearly led me to conclude the component is never
  constructed. It is built as `new waMod.WriteAdmission({` through a dynamic-import
  namespace — the same bare-identifier blindness fixed in three lints this week, committed
  in the act of auditing for it. Scanner pins cover the namespace-qualified, bare and
  deeply-qualified forms, and negatively pin a similarly-named class, a plain import and a
  type reference.
- Real `tsc --noEmit` exit 0 — run via `node node_modules/typescript/bin/tsc` because
  `npx tsc` here is intercepted by a shim that exits 0 **without typechecking**.
- `server.ts` restored byte-exact after the negative control.
