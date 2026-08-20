<!-- bump: patch -->

## What Changed

**An agent expanding onto a new machine silently became two agents sharing one name.**

Joining a mesh provisions a clone of the shared project, a machine-local config, and a MACHINE
identity. None of those is the AGENT identity — it is gitignored (it holds a private key),
absent from the scaffolded config, absent from the pairing response, and absent from the
cross-machine secret-sync set. So on first boot the agent looks for its identity, finds none,
and mints a fresh one.

The design error in one sentence: **the agent's identity was treated as a per-machine secret,
when it is a shared-agent secret.** Machine keys are correctly per-machine — the agent is not.

Observed live (2026-08-19) and unreported for four days.

### The consequence, measured rather than argued

A **plain-text** message signed on the diverged machine:

| Verifier | Verdict |
|---|---|
| the machine that signed it | `agent-verified` |
| peer 1 | `rejected` — `bad-signature` |
| peer 2 | `rejected` — `bad-signature` |

Plain text deliberately: a separate known limitation rejects signed *markdown*, and would have
confounded the result. Agent-signature provenance is therefore **inoperative** from a diverged
machine. It fails safe — `rejected`, never silently accepted as operator-typed — but the
guarantee the feature exists to give is absent.

### What ships

- **The identity travels with the expansion**, sealed to the joining machine's encryption key
  over the pairing exchange that already carries it, bound to a transcript (session, machine,
  key, agent name, expiry). Sealing reuses the existing in-production secret-sync primitive.
- **A machine that joined a mesh may no longer mint an identity.** Enforced at the minting site
  rather than its callers. If the handover fails, the join fails loudly instead of producing a
  silent twin.
- **A split is now noticed.** Every machine compares what its peers publish and one deduped
  notice is raised. `cannot-tell` — an unreachable peer — is never rendered as agreement.
- **A repair path that refuses to guess.** Majority, age, durable prevalence and lease-holder
  are all rejected as tiebreakers: each correlates with being right without being a reason.

### Also fixed: a false positive shipped earlier the same day

The process-ceiling check conflated "this machine has no launchd plist" with "it has one and
it's wrong", warning healthy unmanaged machines that a restart might lose their limit. Found by
the test suite, not by review — it was raising an attention item inside an unrelated end-to-end
test and failing it.

## Evidence

- 88 tests across five suites: joined-mesh detection (11), sealed handover (12), divergence
  detection (15), reconciliation (14), process-ceiling incl. 5 new regressions (36).
- Verified against the **live split**, not fixtures: the detector reproduces it and renders the
  notice; the reconciler returns `ask-operator / no-attested-root`; the joined-mesh detector
  returns `joined: true, peerMachineCount: 2`.
- Full suite: 25 failures / 10 files — byte-identical to the pre-change baseline.
- Spec: 7 cross-model rounds, Standards-Conformance Gate 0 findings.

## What to Tell Your User

- **If you run one agent on more than one machine, it may quietly be more than one agent — and
  you would have no way of knowing.** After this update, machines compare identities and tell
  you if they disagree. New machines inherit the identity properly instead of inventing one.
- **An existing split needs one decision from you.** The rule that works out which identity is
  correct only applies to identities created after this ships. Older ones are shown to you as
  plain descriptions ("the identity used by your Mini and Laptop since May") and you pick — no
  comparing strings of hex.
- **Two things this does not fix, stated plainly.** Stale copies of an agent already registered
  on the relay are not cleaned up; that needs separate work. And every machine ends up holding
  the same key, so a stolen or retired machine keeps a working copy until the identity is
  replaced everywhere.

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Agent identity carried on join | Automatic. Sealed to the joining machine over the existing pairing exchange. |
| Refusal to mint on a joined machine | Automatic. A failed handover fails loudly instead of creating a second identity. |
| Split detection | Automatic at boot. One deduped notice per split; unreachable peers are reported as unknown, never as agreement. |
| Repair that asks rather than guesses | Surfaced as a plain-language choice when a split cannot be resolved from provenance. |
