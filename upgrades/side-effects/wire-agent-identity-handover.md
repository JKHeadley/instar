# Side-Effects Review — Wire the agent-identity handover

**Version / slug:** `wire-agent-identity-handover`
**Date:** `2026-08-20`
**Author:** `Echo (instar-dev agent)`
**Second-pass reviewer:** `not required — see below`

## Summary of the change

PR #1946 shipped `sealIdentityForJoiner` and `openHandoverEnvelope` with 12 passing tests and
**nothing calling either**. The mint guard shipped wired. So the net effect of the change meant
to fix identity continuity was to **break joining**: a machine joining a mesh correctly refused
to mint and had no way to receive the identity.

This connects them. `POST /api/pair` seals the identity to the joiner's encryption key;
`joinMesh` installs it before the server first starts; `AgentServer` passes through the context
the sealer needs.

Files: `src/server/machineRoutes.ts`, `src/commands/machine.ts`, `src/core/AgentIdentityHandover.ts`,
`src/server/AgentServer.ts`, `tests/unit/agent-identity-handover-wiring.test.ts`.

## Decision-point inventory

- `POST /api/pair` — **modify** — now returns a sealed identity envelope, or omits the field
  with a named log line. No new decision: the pairing-code validation upstream is unchanged.
- `joinMesh` identity install — **add** — accept or refuse; refusal provisions nothing.

---

## 1. Over-block

The install path can refuse a legitimate handover: a clock skew past the envelope expiry, an
unreadable encryption key, or a `stateDir`/`agentName` an embedder did not supply.

Every one of those produces a **named refusal and a loud message naming the remedy**, and the
machine is left exactly as it was — unjoined, with no identity, rather than half-provisioned.
That is the intended direction: the alternative to refusing is minting, which is the defect.

The residual cost is real and worth stating: an operator hitting one of these gets a failed
join and must re-pair. That is strictly better than the silent split it replaces.

---

## 2. Under-block

- **Without the operator's pairing artefact carrying the agent fingerprint, the pin check is
  skipped** and the envelope's own fingerprint is used. That still resists a wrong-joiner or
  replayed envelope (transcript + sealing key cover those) but NOT a hostile listener
  fabricating one. `--agent-fingerprint` exists on the join options; nothing yet puts it into
  the artefact `instar pair` prints. Honest posture: weaker when absent, and the code says so.
- **Version skew is unchanged from the spec:** an old joiner ignores the envelope and mints.

---

## 3. Level-of-abstraction fit

The seal belongs on the route that already validates the pairing code and already receives the
joiner's key — no new endpoint, no new trust relationship at the protocol level.

The install belongs in `joinMesh` **before the server starts**, because that ordering is what
makes the mint guard unreachable in the happy path rather than merely survivable.

`readAgentIdentityForHandover` sits beside the sealer rather than in `IdentityManager` because
it reads for EXPORT; `IdentityManager` reads for USE and is deliberately no-create.

---

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [x] No — this change has no block/allow surface.

Neither half decides anything about agent behaviour. The route hands over data or does not; the
joiner installs it or refuses. The only blocking authority in this feature is the mint guard,
which shipped in #1946 and is unchanged here.

---

## 4b. Judgment-point check (Judgment Within Floors standard)

No new static heuristic at a competing-signals decision point. Both new paths are enumerable
transforms over a single input each.

---

## 5. Interactions

- **Shadowing:** the install runs before the server starts, so it cannot race the boot's
  identity read. That ordering is the point, not an incidental.
- **Double-fire:** the route seals once per redemption; the joiner installs once per join.
- **Races:** the write is atomic (temp file → rename in the destination directory), so a crash
  mid-write leaves either the old state or the new one, never a half-key.
- **Feedback loops:** none.

**Interaction with the mint guard, stated because it is the whole point:** these two are a
matched pair. The guard without the carry breaks joining — that is what #1946 shipped. The carry
without the guard restores the silent split. Neither should ever ship alone again, which is what
the wiring suite now asserts.

---

## 6. External surfaces

- **Other users of the install base:** joining a machine works again, and now yields the same
  identity as the machine joined.
- **External systems:** none. No new network call; the same response gains a field.
- **Persistent state:** `identity.json` on the joiner, written owner-only.
- **Operator surface:** three plain-language console outcomes on join — received / not offered
  (name the machine to update) / refused (name the reason). None asks for terminal work beyond
  re-pairing.

---

## 6b. Operator-surface quality (Operator-Surface Quality standard)

No dashboard renderer or form is staged. The join console output was held to the same bar: it
states what happened, what to do, and — in the not-offered case — explicitly why an identity was
NOT invented, so an operator seeing a failed join understands it as a deliberate refusal rather
than a malfunction.

---

## 7. Multi-machine posture (Cross-Machine Coherence)

**`unified`** — this is the mechanism by which the agent identity becomes unified. Machine keys
remain `machine-local`; `machine-local-justification: hardware-bound-resource`, unchanged from
the parent spec.

- **User-facing notices:** none added.
- **Durable state on topic transfer:** none.
- **Generated URLs:** none.

---

## 8. Rollback cost

Reverting returns to the #1946 state, in which **joining is broken**. So this is not a safe
revert on its own: rolling this back requires also reverting the mint guard, or accepting that
no machine can join until it is restored. Stated plainly because "revert the last commit" is the
instinct and here it is the wrong one.

---

## Conclusion

The code change is small and mechanical. The finding worth recording is the process one.

**Every gate passed on an unreachable component.** Unit tests exercised the piece in isolation
and it was correct. Seven rounds of cross-model review examined the design and it was right. The
full suite ran the code that exists and cannot notice code that is absent. Docs coverage, the
guard manifest and the lints all asked about what IS there. Each answered a narrower question
than the one that mattered: *is it plugged in?*

That is a general blind spot, not a one-off. The remedy shipped here is a wiring-integrity suite
that asserts reachability through the real seams — the standard already requires this for
dependency-injected components, and this is the case that shows why.

---

## Second-pass review (if required)

**Reviewer:** not required for the code; the design was reviewed over 7 rounds in the parent
spec and is unchanged. This commit changes no decision point, adds no blocking authority, and
introduces no new interface — it connects two reviewed components.

The judgement that a second-pass would have added value HERE is worth recording honestly: it
would not have caught the original defect either, because it reviews the artifact and the
artifact described a design that was correct. What caught it was asking "what calls this?".

---

## Evidence pointers

- `tests/unit/agent-identity-handover-wiring.test.ts` — 9 tests: route→sealer, join→installer,
  server→context pass-through, no-mint-on-failure, seal→install round-trip proving the joiner
  ends up with the SOURCE identity, owner-only permissions, absent-envelope, refused-envelope.
- 97 tests across the identity work.
- Full suite: 25 failures / 10 files — byte-identical to the pre-change baseline.
