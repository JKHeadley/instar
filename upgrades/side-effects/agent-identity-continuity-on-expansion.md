# Side-Effects Review — Agent identity continuity on expansion

**Version / slug:** `agent-identity-continuity-on-expansion`
**Date:** `2026-08-19`
**Author:** `Echo (instar-dev agent)`
**Second-pass reviewer:** `cross-model codex-cli:gpt-5.5 (7 rounds) + Standards-Conformance Gate`

## Summary of the change

An agent expanding onto a new machine silently became two agents sharing one name: `joinMesh`
provisions a MACHINE identity and never the AGENT identity, so the joining machine finds none
and `IdentityManager.getOrCreate()` mints a fresh keypair. Four modules close it: a joined-mesh
detector, a mint refusal at the minting site, a sealed handover over the existing pairing
exchange, a divergence detector wired at boot, and a reconciler that refuses to guess which
identity is canonical.

Files: `src/threadline/client/JoinedMeshDetector.ts` (new), `src/threadline/client/IdentityManager.ts`,
`src/core/AgentIdentityHandover.ts` (new), `src/core/AgentIdentityDivergenceDetector.ts` (new),
`src/core/AgentIdentityReconciler.ts` (new), `src/server/AgentServer.ts` (boot wiring),
`src/monitoring/guardManifest.ts`, plus a false-positive fix in `src/core/ProcessCeilingCheck.ts`.

## Decision-point inventory

- `IdentityManager.getOrCreate` — **modify** — refuses to mint when mesh-join state is present.
- `AgentIdentityHandover.openHandoverEnvelope` — **add** — accepts or rejects an identity payload.
- `AgentIdentityDivergenceDetector.evaluateDivergence` — **add** — agree / disagree / cannot-tell.
- `AgentIdentityReconciler.decideReconciliation` — **add** — repair / ask-operator / no-op.
- `ProcessCeilingCheck.evaluateProcessCeiling` — **modify** — `plistPresent` added (bug fix).

---

## 1. Over-block

The mint refusal is the one genuine over-block risk: a machine wrongly judged "joined" would be
denied an identity it is entitled to mint, and would not start.

Closed by making every uncertain reading resolve toward minting. No registry, unreadable
registry, registry listing only this machine, and a missing self machine-id all answer "not
joined". The only path to refusal is a parseable registry naming another machine — written by
the pairing flow before the server ever starts.

Verified against the live Studio (`joined: true, peerMachineCount: 2`) and against six fixture
cases including the ambiguous ones.

---

## 2. Under-block

Named, not implied:

1. **A joined machine with a corrupt registry can still mint.** Direct consequence of failing
   toward minting. The divergence detector is what catches it afterwards.
2. **Version skew leaves old joiners minting.** An old joiner against a new awake machine
   ignores the envelope and mints as before. That is today's defect, not a new one, and the new
   awake machine records that it served an envelope nobody acknowledged.
3. **Lineage is evidence, not authority.** A compromised host can self-sign false provenance.
   Any unattested candidate routes to operator selection rather than being decided.

---

## 3. Level-of-abstraction fit

The refusal sits at the minting SITE, not at its two call sites (`ThreadlineClient`,
`mcp-stdio-entry`) — guarding callers would leave the next caller free to reintroduce it.

The handover rides `POST /api/pair`, which already validates the operator-carried code and
already receives the joiner's encryption key (validated, previously unused). No new endpoint and
no new trust relationship at the protocol level — though the CONSEQUENCE of pairing-code
compromise rises sharply, which §6 covers.

Sealing reuses `SecretStore.encryptForSync`, the reviewed in-production primitive behind
cross-machine secret sync. A second sealing scheme for the same job would be new attack surface
for no gain.

---

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [x] No — this change produces a signal consumed by an existing smart gate.

The divergence detector raises one Attention item and does nothing else — it never repairs,
blocks a send, or changes an identity. The reconciler returns a DECISION and performs nothing,
so a caller cannot accidentally act on an unresolved one.

The mint refusal IS a block, and deliberately so: it is a safety guard on an irreversible
action (minting an identity that splits the agent), deterministic, on an on-disk fact, failing
toward the permissive direction. That is the compliant shape for blocking authority.

---

## 4b. Judgment-point check (Judgment Within Floors standard)

No new static heuristic at a competing-signals decision point. The reconciler is the one place
signals could compete — majority, age, prevalence, lease-holder all "suggest" an answer — and
the design's core move is to refuse all of them and ask the operator. Rather than a static
heuristic at a judgment point, it declines to be a judgment point at all.

---

## 5. Interactions

- **Shadowing:** the mint refusal runs after both load paths, so a provisioned identity is
  returned before the guard is reached. Verified by test.
- **Double-fire:** the divergence detector runs once per boot, 90s delayed, deduped on the
  episode key so every machine observing produces one item, not N.
- **Races:** the detector is fire-and-forget with an unref'd timer and cannot delay or fail a
  boot. The reconciler is pure.
- **Feedback loops:** none — nothing the detector emits changes what it reads.

**Interaction found by the suite, not by review:** the process-ceiling boot check (shipped
earlier today) was raising a `future-repair` attention item on machines with no launchd plist,
which polluted an unrelated e2e test's attention items and failed it. That is a false positive
in already-merged code; fixed here with `plistPresent` and five regression tests.

---

## 6. External surfaces

- **Other agents:** none — this is intra-agent.
- **Other users of the install base:** joining machines behave differently (identity carried,
  or a loud failure instead of a silent twin). Single-machine agents are unaffected: no
  registry means no refusal, and no peers means the detector returns before fetching.
- **External systems:** none. No new network call except the detector's peer reads, which use
  the existing authenticated `/provenance` route.
- **Persistent state:** the identity file and its provenance record. A repair backs up the
  superseded identity before replacing it.
- **Timing:** one delayed, bounded, unref'd boot timer.
- **Operator surface (Mobile-Complete Operator Actions):** the reconciler's decision is
  phone-completable — the operator picks between plain-language descriptions, not hex strings,
  and confirms against a restatement of what changes on which machine.

**The trust-consequence change, stated because it is easy to miss:** a pairing code today gets
an attacker a registry row; after this it is a path to the agent's signing key. The spec
reclassifies pairing as identity provisioning with a short expiry, a failed-attempt cap, and
one-at-a-time sessions.

---

## 6b. Operator-surface quality (Operator-Surface Quality standard)

No dashboard renderer or form is staged. The operator-facing output is notice text and the
reconciler's choice rendering, held to the same bar:

1. **Leads with the primary action** — the split notice names the machines and the decision;
   the reconciler leads with descriptions of each candidate.
2. **Zero raw internals as primary content** — the conformance gate rejected an earlier draft
   that made the operator compare two 32-character fingerprints. Fingerprints now appear
   truncated as supporting detail; the full values live in the audit record. Asserted by test.
3. **Destructive actions de-emphasized** — none offered; repair requires an explicit choice.
4. **Plain language** — asserted by test: the notice states the consequence in ordinary words
   and says plainly that nothing changes automatically and why.

---

## 7. Multi-machine posture (Cross-Machine Coherence)

**`unified` for the agent identity — that is the entire point of the change.** The current
per-machine behaviour is the defect.

The **machine** identity stays `machine-local`.
`machine-local-justification: hardware-bound-resource` — the machine id and its signing and
encryption keys identify one physical host, are used to verify that host's own signatures, and
are meaningless elsewhere. Replicating them would make two hosts indistinguishable to the lease
layer.

- **User-facing notices:** one per split, not one per machine. Every machine observes (the lease
  holder may BE the diverged one — it is, here); the episode key does the deduping.
- **Durable state on topic transfer:** none introduced.
- **Generated URLs:** none.

---

## 8. Rollback cost

- **Code:** revert and ship a patch.
- **Behavioural risk, stated honestly:** reverting restores the minting, so the next machine to
  join splits again, silently. A rollback must be paired with a freeze on joins or manual
  identity provisioning. This is NOT a harmless revert.
- **On-disk state:** repaired machines keep the canonical identity, which is what the rest of
  the mesh expects. Superseded identity files are retained, so an individual repair is
  reversible.
- **Relay state:** unchanged either way — this change retires no registration.

---

## Conclusion

The review changed this substantially and the changes were not cosmetic: it corrected a security
claim of mine that was simply false (an impersonator is NOT defeated by a signature check —
they supply the signature too), replaced a repair rule that broke on chained joins, rejected a
burn policy that would have cost a full re-pairing on any dropped packet, withdrew "no new trust
relationship", withdrew a claim to retire relay rows that this change cannot make, and rejected
an operator ceremony built on comparing hex strings.

Then the test suite caught three things review did not, including a false positive in code that
had already shipped today.

Built and verified against the real live split rather than fixtures: the detector reproduces it
and renders the notice; the reconciler refuses to decide it and produces the operator question.

---

## Second-pass review (if required)

**Reviewer:** cross-model `codex-cli:gpt-5.5`, 7 rounds
**Independent read: concur** — converged at round 7 under the operator's 80/20 standard, with
the residual findings named in the convergence report. Standards-Conformance Gate: 0 findings.

Disclosure on independence: the internal reviewer perspectives were carried by the authoring
session rather than spawned subagents, under a session instruction not to spawn agents without a
request. The genuinely independent reads were the cross-model pass and the code-backed gate.

---

## Evidence pointers

- `tests/unit/joined-mesh-mint-refusal.test.ts` — 11 tests.
- `tests/unit/agent-identity-handover.test.ts` — 12 tests.
- `tests/unit/agent-identity-divergence.test.ts` — 15 tests.
- `tests/unit/agent-identity-reconciler.test.ts` — 14 tests.
- `tests/unit/process-ceiling-check.test.ts` — 36 tests (5 new regressions).
- Live: the detector run against the real three machines returns `disagree` with the correct
  grouping; the reconciler returns `ask-operator / no-attested-root`; the joined-mesh detector
  returns `joined: true, peerMachineCount: 2` on the Studio.
- Full suite: 25 failures / 10 files — byte-identical to the pre-change baseline (CMT-016), so
  none introduced.
